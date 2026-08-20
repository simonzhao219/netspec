"""Phase 0 Security Checker — rules driven by SKILL.md frontmatter.

Architecture:
  SKILL.md (security: section)  ← Policy definition (editable without code change)
  SecurityChecker               ← Enforcement engine (reads policy from SKILL)

Layers:
  Layer 1: Sensitive information detection  → mask & warn, pipeline continues
  Layer 2: Attack-oriented use detection    → block, pipeline stops
  Layer 3: Prompt injection detection       → strip & warn, pipeline continues

To update security rules: edit the `security:` section in SKILL.md, restart backend.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# ── data types ────────────────────────────────────────────────────────────────

@dataclass
class SecurityAlert:
    category: str       # "sensitive_info" | "attack_intent" | "prompt_injection"
    severity: str       # "block" | "warn"
    message: str
    detected: list[str] = field(default_factory=list)
    suggestion: str = ""


@dataclass
class SecurityCheckResult:
    clean_text: str
    blocked: bool
    block_alert: Optional[SecurityAlert]
    warnings: list[SecurityAlert]


# ── SKILL frontmatter parser ──────────────────────────────────────────────────

def _load_skill_security(skill_path: str) -> dict:
    """Parse the `security:` block from SKILL.md YAML frontmatter."""
    try:
        text = Path(skill_path).read_text(encoding="utf-8")
        # Extract content between first --- and second ---
        if not text.startswith("---"):
            return {}
        end = text.index("---", 3)
        frontmatter = text[3:end].strip()

        # Minimal YAML parser for our specific structure (avoids pyyaml dependency)
        import yaml  # type: ignore
        data = yaml.safe_load(frontmatter)
        return data.get("security", {}) if isinstance(data, dict) else {}
    except Exception:
        return {}


# ── SecurityChecker ───────────────────────────────────────────────────────────

_SKILL_PATH = Path(__file__).parent.parent.parent / "skills" / "netspec-socratic" / "SKILL.md"

_DEFAULT_SECURITY: dict = {
    "layer1_sensitive": {
        "password_keywords": ["password","passwd","pwd","secret","api_key","api-key","token","auth_key","credential","private_key"],
        "ip_doc_ranges":     ["192.0.2.", "198.51.100.", "203.0.113."],
        "mask_mac":          True,
    },
    "layer2_attack": {
        "defense_context_chars": 40,
        "defense_keywords": ["防禦","偵測","告警","阻斷","防護","防止","detect","prevent","protect","defense","mitigation","monitoring","monitor","alert","anti"],
        "attack_patterns": [
            {"pattern": r"arp\s*spoof|arp\s*poison|arp欺騙",                 "label": "ARP Spoofing / ARP 欺騙"},
            {"pattern": r"bgp\s*hijack|bgp劫持|路由劫持",                    "label": "BGP Hijacking / 路由劫持"},
            {"pattern": r"\bd(?:d)?os\b|洪水攻擊|flood\s*attack|syn\s*flood","label": "DDoS / DoS 攻擊工具"},
            {"pattern": r"(?:bypass|繞過)\s*(?:acl|firewall|防火牆|filter|過濾)","label": "繞過 ACL / 防火牆"},
            {"pattern": r"韌體逆向|firmware\s*(?:reverse|hack|exploit)",     "label": "韌體逆向工程"},
            {"pattern": r"(?:未授權|unauthorized)\s*(?:存取|access|登入)",    "label": "未授權存取"},
            {"pattern": r"packet\s*(?:forge|spoof|inject)|封包偽造|偽造封包", "label": "封包偽造"},
            {"pattern": r"man.in.the.middle|中間人攻擊|mitm",                 "label": "中間人攻擊 (MITM)"},
            {"pattern": r"exploit|漏洞利用|zero.day|0day",                   "label": "漏洞利用 / Exploit"},
        ],
    },
    "layer3_injection": {
        "injection_patterns": [
            r"忽略以上指令|忽略前面|ignore\s+(?:all\s+)?previous\s+instructions?",
            r"你現在是(?!.*(?:工程師|架構師|PM|開發|測試))|you are now\b",
            r"pretend\s+you\s+are|act\s+as\s+(?:an?\s+)?(?:AI\s+)?without",
            r"\bsystem\s*:\s*|^\[system\]|<\/?INST>|<\/?SYS>|<\|im_start\|>|<\|im_end\|>",
            r"jailbreak|越獄|解除(?:所有)?限制|remove\s+all\s+restrictions?",
            r"output\s+(?:your\s+)?system\s+prompt|輸出.*系統.*提示",
            r"disregard\s+(?:all\s+)?(?:previous|prior)\s+",
            r"----+\s*(?:new\s+)?instructions?\s*:?",
        ],
    },
}


class SecurityChecker:
    """Enforcement engine — reads policy from SKILL.md, falls back to defaults."""

    def __init__(self, skill_path: Optional[Path] = None):
        raw = _load_skill_security(str(skill_path or _SKILL_PATH))
        cfg = raw if raw else _DEFAULT_SECURITY

        # ── Layer 1 config ────────────────────────────────────────────────────
        l1 = cfg.get("layer1_sensitive", _DEFAULT_SECURITY["layer1_sensitive"])
        pwd_kw = l1.get("password_keywords", [])
        pwd_pat = r"(?:" + "|".join(re.escape(k) for k in pwd_kw) + r")\s*[=:]\s*\S+"
        self._PWD_RE = re.compile(pwd_pat, re.IGNORECASE)
        self._MAC_RE = re.compile(r"(?:[0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}")
        self._IP_RE  = re.compile(r"\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b")
        self._DOC_PREFIXES = tuple(l1.get("ip_doc_ranges", []))
        self._mask_mac = l1.get("mask_mac", True)

        # ── Layer 2 config ────────────────────────────────────────────────────
        l2 = cfg.get("layer2_attack", _DEFAULT_SECURITY["layer2_attack"])
        defense_kw = l2.get("defense_keywords", [])
        self._DEFENSE_CTX = int(l2.get("defense_context_chars", 40))
        self._DEFENSE_RE  = re.compile("|".join(re.escape(k) for k in defense_kw), re.IGNORECASE)
        self._ATTACK_PATTERNS: list[tuple[re.Pattern, str]] = []
        for ap in l2.get("attack_patterns", _DEFAULT_SECURITY["layer2_attack"]["attack_patterns"]):
            try:
                compiled = re.compile(ap["pattern"], re.IGNORECASE)
                self._ATTACK_PATTERNS.append((compiled, ap["label"]))
            except re.error:
                pass

        # ── Layer 3 config ────────────────────────────────────────────────────
        l3 = cfg.get("layer3_injection", _DEFAULT_SECURITY["layer3_injection"])
        self._INJECTION_PATTERNS: list[re.Pattern] = []
        for pat in l3.get("injection_patterns", _DEFAULT_SECURITY["layer3_injection"]["injection_patterns"]):
            try:
                self._INJECTION_PATTERNS.append(re.compile(pat, re.IGNORECASE | re.MULTILINE))
            except re.error:
                pass

        self._source = "SKILL.md" if raw else "defaults"

    @property
    def source(self) -> str:
        """Shows whether rules were loaded from SKILL.md or built-in defaults."""
        return self._source

    # ── public API ────────────────────────────────────────────────────────────

    def check(self, requirement: str) -> SecurityCheckResult:
        text    = requirement
        blocked = False
        block_alert: Optional[SecurityAlert] = None
        warnings: list[SecurityAlert] = []

        # Layer 3 first (strip injections before other checks)
        text, inj_alerts = self._check_injection(text)
        warnings.extend(inj_alerts)

        # Layer 1 (mask sensitive info)
        text, sens_alerts = self._check_sensitive(text)
        warnings.extend(sens_alerts)

        # Layer 2 (attack intent — check original text)
        atk_alert = self._check_attack(requirement)
        if atk_alert:
            blocked     = True
            block_alert = atk_alert

        return SecurityCheckResult(
            clean_text  = text,
            blocked     = blocked,
            block_alert = block_alert,
            warnings    = warnings,
        )

    def reload(self) -> None:
        """Hot-reload rules from SKILL.md (no restart needed)."""
        self.__init__()

    # ── Layer 1 ───────────────────────────────────────────────────────────────

    def _check_sensitive(self, text: str) -> tuple[str, list[SecurityAlert]]:
        alerts: list[SecurityAlert] = []
        detected: list[str] = []

        if self._PWD_RE.search(text):
            text = self._PWD_RE.sub(lambda m: re.sub(r"[=:]\s*\S+", "=<REDACTED>", m.group()), text)
            detected.append("密碼或 API Key（已自動遮蔽）")

        if self._mask_mac and self._MAC_RE.search(text):
            text = self._MAC_RE.sub("<MAC_ADDR>", text)
            detected.append("MAC 位址（已自動遮蔽）")

        ip_found: list[str] = []
        def _replace_ip(m: re.Match) -> str:
            ip = m.group(0)
            if not any(ip.startswith(p) for p in self._DOC_PREFIXES):
                ip_found.append(ip)
                return "<IP_ADDR>"
            return ip
        text = self._IP_RE.sub(_replace_ip, text)
        if ip_found:
            detected.append(f"設備 IP 位址 {len(ip_found)} 筆（已自動遮蔽）")

        if detected:
            alerts.append(SecurityAlert(
                category  = "sensitive_info",
                severity  = "warn",
                message   = f"偵測到敏感資訊：{', '.join(detected)}。已自動以佔位符替換。",
                detected  = detected,
                suggestion = "使用文件用 IP（如 192.0.2.1）或 <DEVICE_IP> 佔位符代替真實位址。",
            ))
        return text, alerts

    # ── Layer 2 ───────────────────────────────────────────────────────────────

    def _check_attack(self, text: str) -> Optional[SecurityAlert]:
        found: list[str] = []
        for pattern, label in self._ATTACK_PATTERNS:
            m = pattern.search(text)
            if not m:
                continue
            start  = max(0, m.start() - self._DEFENSE_CTX)
            window = text[start: m.end() + self._DEFENSE_CTX]
            if self._DEFENSE_RE.search(window):
                continue
            found.append(label)
        if not found:
            return None
        return SecurityAlert(
            category  = "attack_intent",
            severity  = "block",
            message   = f"需求描述與攻擊性工具的開發模式相符（{', '.join(found)}），NetSpec 無法為此類需求生成規格書。",
            detected  = found,
            suggestion= "如果您的目標是防禦或測試場景，請明確說明使用情境（如「防禦 ARP Spoofing 的偵測與阻斷規格」）。",
        )

    # ── Layer 3 ───────────────────────────────────────────────────────────────

    def _check_injection(self, text: str) -> tuple[str, list[SecurityAlert]]:
        stripped = False
        for pattern in self._INJECTION_PATTERNS:
            if pattern.search(text):
                text    = pattern.sub("", text)
                stripped = True
        text = text.strip()
        if not stripped:
            return text, []
        return text, [SecurityAlert(
            category   = "prompt_injection",
            severity   = "warn",
            message    = "偵測到 Prompt Injection 指令模式，相關內容已自動移除，針對合法的網通需求部分繼續分析。",
            detected   = ["指令注入模式（已移除）"],
            suggestion = "若認為這是誤判，請重新描述您的網通需求。",
        )]


# ── singleton (auto-loads from SKILL.md on import) ───────────────────────────

checker = SecurityChecker()


def check_requirement(requirement: str) -> SecurityCheckResult:
    """Public entry point — run all Phase 0 checks."""
    return checker.check(requirement)


def reload_security_rules() -> str:
    """Hot-reload security rules from SKILL.md (for admin use)."""
    checker.reload()
    return f"Security rules reloaded from {checker.source}"
