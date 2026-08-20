"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import SocraticCard from "@/components/cards/SocraticCard";
import InputConfirmCard from "@/components/cards/InputConfirmCard";
import ResearchPlanCard from "@/components/cards/ResearchPlanCard";
import { SocraticInterrupt, PlanConfirmInterrupt } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useNetSpec } from "@/hooks/useNetSpec";
import { listFigmaFrames, getFigmaOAuthStatus, disconnectFigma } from "@/lib/api";
import type { FigmaFrameListResult } from "@/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

interface InputPanelProps {
  onStart: (requirement: string, detailLevel?: string) => void;
  status: string;
  storedRequirement?: string;
  backendClarityScore?: number | null;
  interruptType: string | null;
  interruptData: any;
  lastSocraticData: any;
  onSubmitAnswers: (answers: Record<string, string>) => void;
  onProceed: () => void;
  onSkip: () => void;
  onContinueMoreQuestions: (answers: Record<string, string>) => void;
  onConfirmInput: () => void;
  onBackToSocratic: () => void;
  onConfirmPlan: (modifiedKeywords?: string[]) => void;
  onFigmaLoaded?: (fileKey: string, fileName: string, frames: FigmaFrameListResult["frames"]) => void;
  onStartStory?: (fileKey: string, fileName: string, frames: FigmaFrameListResult["frames"]) => void;
  workflowMode?: "text" | "figma";
  llmMode?: "ollama" | "api";
}

// ─── Constants ────────────────────────────────────────────────────────────────

// 每個範例均通過本地清晰度評分 ≥ 70 驗證
const QUICK_FILL = [
  {
    label: "BGP",
    title: "BGP 路由",
    sub: "跨自治系統繞送",
    score: 87,
    icon: (<><circle cx="6" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><path d="M9 6h6a3 3 0 013 3v6" /></>),
    text: "在核心路由器上設計並部署企業多出口 BGP 路由備援架構，需同時支援 iBGP 與 eBGP 雙模式運作。配置 BFD 雙向轉送偵測機制，要求主備路由切換時間 ≤ 500ms，BFD 最小計時器設定為 100ms × 3 倍數。實作 ECMP 等價多路徑路由，最多維持 4 條並行上游路徑以均衡流量。規劃完整 AS Path 過濾策略、BGP 社群屬性標記（含 LOCAL_PREF 調整）及 Route Map 路由策略，並整合 SNMP 監控系統持續追蹤所有 BGP session 狀態與路由表變更。架構需容忍單一 ISP 線路完全中斷，不影響企業對外業務連線，目標可用性 99.99%，RTO ≤ 1 秒。",
  },
  {
    label: "防火牆",
    title: "防火牆",
    sub: "存取控制規則",
    score: 84,
    icon: (<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" />),
    text: "規劃並部署三層次防火牆安全架構：邊界防火牆（Internet 出口）、DMZ 防火牆（對外服務區）、內部分段防火牆（核心與使用者網段隔離）。需配置 stateful inspection 連線追蹤、QoS 流量優先級管理，整合 IPS 入侵防護系統，最大支援 10,000 條 ACL 規則，採用 First-Match 匹配語義。建立集中化防火牆日誌稽核平台，監控所有允許與拒絕事件。整體安全架構需符合 ISO 27001 資訊安全管理要求，並定期實作滲透測試驗證規則有效性，確保各 VLAN 間最小權限原則存取控制。",
  },
  {
    label: "VLAN",
    title: "VLAN 切割",
    sub: "網段隔離設計",
    score: 95,
    icon: (<><rect x="3" y="4" width="18" height="5" rx="1" /><rect x="3" y="15" width="18" height="5" rx="1" /><path d="M8 9v6" /></>),
    text: "設計並部署企業辦公室 VLAN 分割方案，將員工工作站（VLAN 10）、訪客無線網路（VLAN 20）、IoT 設備（VLAN 30）、伺服器群（VLAN 40）完全隔離。配置 802.1Q trunk 於核心交換器上行埠，並整合 802.1X 認證搭配 RADIUS 伺服器進行動態 VLAN 分配。建立獨立 DHCP scope 供各 VLAN 使用，規劃 inter-VLAN routing 存取控制清單（ACL），VLAN 數量上限 50 個。監控各 VLAN 流量，設定 STP BPDU Guard 防止拓墣迴路，整體目標為最小化橫向移動攻擊面。",
  },
];

// Token chip for the detail-level description (template `.tk`)
const TK = "inline-block text-[11.5px] font-bold px-[9px] py-[3px] rounded-[7px] bg-[#F1F3EC] text-[#10151B]";

const PROTOCOLS = [
  "bgp","ospf","vlan","bfd","ecmp","mpls","nat","acl","qos","dhcp",
  "ipsec","802.1x","防火牆","路由","交換","vxlan","stp","lacp",
];

const ACTIONS = [
  "設定","配置","建立","部署","實作","規劃","整合","遷移","監控",
];

// ─── Score ────────────────────────────────────────────────────────────────────

function localScore(text: string): number {
  if (!text.trim()) return 0;
  const lo = text.toLowerCase();
  const lengthScore  = Math.min(25, Math.floor(text.length / 14));
  const protocolScore = Math.min(45, PROTOCOLS.filter(k => lo.includes(k)).length * 9);
  const actionScore  = Math.min(30, ACTIONS.filter(k => lo.includes(k)).length * 8);
  return Math.min(100, lengthScore + protocolScore + actionScore);
}

// ─── Signature score ring (conic-gradient) ────────────────────────────────────

function ScoreRing({ score }: { score: number }) {
  const rc = score >= 85 ? "var(--ns-accent-deep)" : score >= 70 ? "var(--ns-amber)" : "var(--ns-muted-2)";
  return (
    <span className="relative grid place-items-center shrink-0" style={{ width: 40, height: 40 }}>
      <span className="absolute inset-0 rounded-full"
        style={{ background: `conic-gradient(${rc} ${score}%, transparent 0)` }} />
      <span className="absolute rounded-full" style={{ inset: 3, background: "#fff" }} />
      <span className="relative font-bold tabular-nums"
        style={{ fontFamily: "var(--font-grotesk)", fontSize: 13, color: "var(--ns-text)" }}>{score}</span>
    </span>
  );
}

// ─── Animated score bar ───────────────────────────────────────────────────────

function ScoreBar({ score, label: barLabel }: { score: number; label?: string }) {
  const color =
    score >= 70 ? "#34c759" :
    score >= 40 ? "#ff9500" :
    "#c7c7cc";

  const label =
    score >= 70 ? "達標" :
    score >= 40 ? "需補充" :
    "待輸入";

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-t" style={{ borderColor: "hsl(var(--border))" }}>
      <span className="text-[11px] text-muted-foreground shrink-0 select-none">
        {barLabel || "清晰度"}
      </span>

      {/* Track */}
      <div
        className="relative flex-1 h-[2px] rounded-full overflow-hidden"
        style={{ background: "hsl(var(--muted))" }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-500 ease-out"
          style={{ width: `${score}%`, background: color }}
        />
      </div>

      {/* Number */}
      <span
        className="text-[12px] font-semibold font-mono tabular-nums shrink-0 w-7 text-right transition-colors duration-300"
        style={{ color: score > 0 ? color : "hsl(var(--muted-foreground))" }}
      >
        {score > 0 ? score : "—"}
      </span>

      {/* Status chip */}
      <span
        className="text-[10px] font-medium px-1.5 py-0.5 rounded-md shrink-0 select-none transition-colors duration-300"
        style={{
          background: score > 0 ? `${color}18` : "hsl(var(--muted))",
          color:      score > 0 ? color : "hsl(var(--muted-foreground))",
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function InputPanel({
  onStart,
  status,
  storedRequirement,
  backendClarityScore,
  interruptType,
  interruptData,
  lastSocraticData,
  onSubmitAnswers,
  onProceed,
  onSkip,
  onContinueMoreQuestions,
  onConfirmInput,
  onBackToSocratic,
  onConfirmPlan,
  onFigmaLoaded,
  onStartStory,
  workflowMode,
  llmMode,
}: InputPanelProps) {
  const { securityState, rateLimitState } = useNetSpec();
  const [countdown, setCountdown] = useState(0);
  const inputMode = workflowMode ?? "text";
  const [figmaUrl, setFigmaUrl] = useState("");
  const [oauthStatus, setOauthStatus] = useState<{ connected: boolean; handle?: string; email?: string } | null>(null);
  const [currentModel, setCurrentModel] = useState<string | null>(null);

  useEffect(() => {
    if (inputMode !== "figma") return;
    fetch("/api/health")
      .then(r => r.json())
      .then(d => setCurrentModel(d.model ?? null))
      .catch(() => {});
    getFigmaOAuthStatus().then(setOauthStatus).catch(() => {});
    // Handle redirect back from Figma OAuth
    const params = new URLSearchParams(window.location.search);
    if (params.get("figma_connected") === "1") {
      window.history.replaceState({}, "", window.location.pathname);
      getFigmaOAuthStatus().then(setOauthStatus).catch(() => {});
    }
  }, [inputMode]);

  const handleOAuthConnect = () => {
    window.location.href = "/api/figma/oauth/start";
  };

  const handleOAuthDisconnect = async () => {
    await disconnectFigma();
    setOauthStatus({ connected: false });
  };
  const [figmaStep, setFigmaStep] = useState<"url" | "picking">("url");
  const [figmaFrameList, setFigmaFrameList] = useState<FigmaFrameListResult | null>(null);
  const [selectedFrameIds, setSelectedFrameIds] = useState<Set<string>>(new Set());
  const [listLoading, setListLoading] = useState(false);
  const [figmaError, setFigmaError] = useState<string | null>(null);
  const [showFlow, setShowFlow] = useState(false);   // 流程解說展開
  const [detailLevel, setDetailLevel] = useState<"concise" | "standard" | "comprehensive">("standard");   // 規格詳細度

  const handleListFrames = async (forceRefresh = false) => {
    if (!figmaUrl.trim()) return;
    setListLoading(true);
    setFigmaError(null);
    try {
      const result = await listFigmaFrames(figmaUrl.trim(), forceRefresh);
      setFigmaFrameList(result);
      setSelectedFrameIds(new Set(result.frames.map(f => f.frame_id)));
      setFigmaStep("picking");
      onFigmaLoaded?.(result.file_key, result.file_name, result.frames);
    } catch (e: any) {
      setFigmaError(e.message ?? "無法取得 Frame 列表，請確認連結正確");
    } finally {
      setListLoading(false);
    }
  };

  const handleToggleFrame = (frameId: string) => {
    setSelectedFrameIds(prev => {
      const next = new Set(prev);
      if (next.has(frameId)) next.delete(frameId);
      else next.add(frameId);
      return next;
    });
  };

  const handleToggleAll = () => {
    if (!figmaFrameList) return;
    const allIds = figmaFrameList.frames.map(f => f.frame_id);
    if (selectedFrameIds.size === allIds.length) setSelectedFrameIds(new Set());
    else setSelectedFrameIds(new Set(allIds));
  };

  const handleFigmaReset = () => {
    setFigmaStep("url");
    setFigmaFrameList(null);
    setSelectedFrameIds(new Set());
    setFigmaError(null);
  };

  // Countdown timer for rate limit
  useEffect(() => {
    if (rateLimitState?.type === 'rate' && rateLimitState.retryAfter) {
      setCountdown(rateLimitState.retryAfter);
      const id = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) { clearInterval(id); return 0; }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(id);
    }
  }, [rateLimitState]);
  // Initialize from storedRequirement so the textarea is restored after panel switch
  const [req, setReq] = useState(storedRequirement ?? "");
  const [showRevise, setShowRevise] = useState(false);
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync with storedRequirement when the component remounts (panel switch restores value)
  useEffect(() => {
    if (storedRequirement && !req) {
      setReq(storedRequirement);
    }
  }, [storedRequirement]);

  // Reset showRevise when plan_confirm clears
  useEffect(() => {
    if (interruptType !== "plan_confirm") {
      setShowRevise(false);
    }
  }, [interruptType]);

  const localScoreVal = useMemo(() => localScore(req), [req]);
  // Use backend LLM score when available (more accurate), fall back to local estimate
  const score     = backendClarityScore ?? localScoreVal;
  const scoreLabel = backendClarityScore != null ? "AI 評分" : "本地估算";
  const isRunning  = !["idle", "complete", "error", ""].includes(status) && !!status;
  const reqLen     = req.trim().length;
  const canStart   = reqLen >= 10 && reqLen <= 500 && !isRunning;

  // Always go straight to ResearchPlanCard — skip the extra InputConfirmCard step
  const renderPlanStep = (planData: PlanConfirmInterrupt) => (
    <ResearchPlanCard
      data={planData}
      onConfirm={(modifiedKeywords) => onConfirmPlan(modifiedKeywords)}
    />
  );

  // Keep textarea auto-height within reason
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [req]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setReq(e.target.value);
  };

  const handleQuickFill = (text: string) => {
    setReq(text);
    textareaRef.current?.focus();
  };

  const handleStart = () => {
    if (canStart) onStart(req.trim(), detailLevel);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canStart) {
      e.preventDefault();
      handleStart();
    }
  };

  // Detected protocols and actions for feedback
  const detectedProtocols = req ? PROTOCOLS.filter(k => req.toLowerCase().includes(k)) : [];
  const detectedActions   = req ? ACTIONS.filter(k => req.toLowerCase().includes(k)) : [];
  const missingHints = !req.trim() ? [] : [
    detectedProtocols.length === 0 && "協定名稱（如 BGP、VLAN、ACL）",
    detectedActions.length === 0   && "動作描述（如 設定、部署、整合）",
    req.length < 80                && "更多細節（建議 80 字以上）",
  ].filter(Boolean) as string[];

  return (
    <div className="w-full max-w-[1400px] mx-auto flex flex-col gap-5 py-2">

      {/* ── Figma heading + 流程解說（與文字輸入風格一致；移除原藍色流程引導卡）── */}
      {workflowMode === "figma" && figmaStep === "url" && (
        <div className="space-y-2.5">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-[26px] font-extrabold tracking-[-0.03em] text-foreground leading-none">
              Figma 分析
            </h1>
            <span className="text-[11px] font-bold px-2.5 py-1 rounded-full leading-none"
              style={{ color: "var(--ns-violet)", background: "var(--ns-violet-soft)", border: "1px solid #DAD5F7" }}>
              PM STORY
            </span>
          </div>
          <p className="text-[14px] text-muted-foreground leading-relaxed max-w-[560px]">
            貼上 Figma 設計稿連結，NetSpec 會引導你補齊需求，並為每個功能生成 PM 的 User Story 與驗收標準（AC）。
          </p>

          {/* ── 流程解說（可展開小卡，置於副標題下方）── */}
          <div className="flex flex-col gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowFlow(v => !v)}
              className="inline-flex items-center gap-1.5 self-start text-[12.5px] font-semibold px-3 py-1.5 rounded-full transition-all hover:bg-[#6B5CF0]/[0.07]"
              style={{ color: "#6B5CF0", border: "1px solid rgba(107,92,240,0.25)", background: "rgba(107,92,240,0.04)" }}
              aria-expanded={showFlow}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
                <circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" />
              </svg>
              流程解說：這個 AI 會怎麼執行
              <span className="transition-transform" style={{ fontSize: 10, transform: showFlow ? "rotate(90deg)" : "none" }}>▸</span>
            </button>

            {showFlow && (
              <div className="rounded-2xl p-4 flex flex-col gap-2.5"
                style={{ background: "#fff", border: "1px solid hsl(var(--border))", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
                <p className="text-[11.5px] leading-snug" style={{ color: "#6e6e73" }}>
                  半自動流程，過程中會請你參與；產出聚焦 <span style={{ fontWeight: 600, color: "#1d1d1f" }}>PM 的 User Story + 驗收標準（AC）</span>，可編輯、可存版本、可匯出。預計約 1–2 分鐘（視功能數量）。
                </p>
                {[
                  { n: "1", icon: "🔗", title: "載入設計稿", desc: "連接 Figma、抓取你選取 Frame 的文字內容", who: "AI 自動" },
                  { n: "2", icon: "💬", title: "AI 追問澄清", desc: "從業務目標／邊界／錯誤處理等維度問 2–3 題、最多 3 輪，補齊設計稿沒寫清楚的需求", who: "需要你作答（可跳過）" },
                  { n: "3", icon: "✅", title: "確認功能清單", desc: "AI 把畫面拆成獨立功能，你勾選要產生哪些", who: "需要你確認" },
                  { n: "4", icon: "📝", title: "生成 PM Story", desc: "每個功能平行產生 User Story + 驗收標準（AC）", who: "AI 自動" },
                  { n: "5", icon: "✏️", title: "檢視／編輯／存版本", desc: "逐段編輯、確認、存為版本（進版／不進版）、匯出 Markdown", who: "你操作" },
                ].map(s => {
                  const needsYou = s.who.startsWith("需要你") || s.who.startsWith("你");
                  return (
                    <div key={s.n} className="flex items-start gap-2.5">
                      <span className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold mt-px"
                        style={{ background: "rgba(107,92,240,0.1)", color: "#6B5CF0" }}>{s.n}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[12px] font-semibold" style={{ color: "#1d1d1f" }}>{s.icon} {s.title}</span>
                          <span className="text-[9.5px] px-1.5 py-0.5 rounded-full font-medium"
                            style={needsYou
                              ? { background: "rgba(245,158,11,0.12)", color: "#b45309" }
                              : { background: "rgba(0,0,0,0.05)", color: "#86868b" }}>
                            {s.who}
                          </span>
                        </div>
                        <p className="text-[11px] mt-0.5 leading-snug" style={{ color: "#6e6e73" }}>{s.desc}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Figma mode ────────────────────────────────────────────────────────── */}
      {inputMode === "figma" && (
        <div className="rounded-2xl overflow-hidden"
          style={{ border: "1px solid hsl(var(--border))", background: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
          <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: "hsl(var(--border))" }}>
            <div>
              <span style={{ color: "#6B5CF0" }}>● </span>
              <span className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">Figma 設計稿分析</span>
            </div>
            {figmaStep === "picking" ? (
              <button onClick={handleFigmaReset} className="text-[11px] transition-opacity hover:opacity-70"
                style={{ color: "#6e6e73" }}>
                ← 重新輸入連結
              </button>
            ) : oauthStatus?.connected ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px]" style={{ color: "#34c759" }}>● {oauthStatus.handle || oauthStatus.email}</span>
                <button onClick={handleOAuthDisconnect}
                  className="text-[10px] px-2 py-0.5 rounded-md transition-opacity hover:opacity-70"
                  style={{ color: "#6e6e73", border: "1px solid hsl(var(--border))" }}>
                  中斷連線
                </button>
              </div>
            ) : (
              <button onClick={handleOAuthConnect}
                className="text-[11px] font-medium px-3 py-1 rounded-lg transition-opacity hover:opacity-80"
                style={{ background: "var(--ns-accent)", color: "var(--ns-ink)" }}>
                Connect Figma
              </button>
            )}
          </div>

          {/* Step 1: URL input */}
          {figmaStep === "url" && (
            <div className="flex flex-col">
              <div className="p-4 flex flex-col gap-3">
                <p className="text-[13px] text-muted-foreground">貼上 Figma 分享連結，先取得 Frame 列表再選擇要分析的範圍。</p>
                <input
                  type="url"
                  value={figmaUrl}
                  onChange={(e) => { setFigmaUrl(e.target.value); setFigmaError(null); }}
                  placeholder="https://www.figma.com/design/..."
                  className="w-full rounded-xl px-3 py-2.5 text-[13px] outline-none transition-all"
                  style={{ border: "1px solid hsl(var(--border))", background: "rgba(0,0,0,0.02)", color: "#1d1d1f" }}
                  onKeyDown={(e) => { if (e.key === "Enter") handleListFrames(); }}
                />
                {figmaError && (
                  <p className="text-[12px]" style={{ color: "#b91c1c" }}>{figmaError}</p>
                )}
                <button
                  onClick={() => { handleListFrames(); }}
                  disabled={listLoading || !figmaUrl.trim() || !oauthStatus?.connected}
                  className="w-full py-3 rounded-xl font-semibold text-[15px] transition-opacity disabled:opacity-40"
                  style={{ background: "var(--ns-accent)", color: "var(--ns-ink)" }}
                >
                  {listLoading ? "載入中…" : "取得 Frame 列表"}
                </button>
                {!oauthStatus?.connected && figmaUrl.trim() && (
                  <p className="text-[12px] text-center" style={{ color: "#f59e0b" }}>
                    請先點擊右上角「Connect Figma」連接帳號
                  </p>
                )}
              </div>
              {figmaUrl.trim() && (
                <div className="border-t" style={{ borderColor: "hsl(var(--border))" }}>
                  <iframe
                    src={`https://www.figma.com/embed?embed_host=netspec&url=${encodeURIComponent(figmaUrl)}`}
                    className="w-full"
                    style={{ height: 320, border: "none", display: "block" }}
                    allowFullScreen
                  />
                </div>
              )}
            </div>
          )}

          {/* Step 2: Frame picker */}
          {figmaStep === "picking" && figmaFrameList && (
            <div className="flex flex-col gap-0">
              {/* File info */}
              <div className="px-4 py-2.5 border-b flex items-center gap-2"
                style={{ borderColor: "hsl(var(--border))", background: "rgba(107,92,240,0.03)" }}>
                <span className="text-[11px] font-mono text-muted-foreground truncate">{figmaFrameList.file_name}</span>
                <span className="ml-auto flex items-center gap-2 shrink-0">
                  {figmaFrameList.cached_at && (() => {
                    const d = new Date(figmaFrameList.cached_at * 1000);
                    const pad = (n: number) => String(n).padStart(2, "0");
                    const absolute = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
                    const mins = Math.floor((Date.now() / 1000 - figmaFrameList.cached_at) / 60);
                    const relative = mins < 1 ? "剛剛" : mins < 60 ? `${mins} 分鐘前` : `${Math.floor(mins / 60)} 小時前`;
                    const isToday = d.toDateString() === new Date().toDateString();
                    const display = isToday
                      ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
                      : `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
                    return (
                      <span className="text-[10px]" style={{ color: "#86868b" }} title={`快取時間：${absolute}（${relative}）`}>
                        上次獲取：{display}
                      </span>
                    );
                  })()}
                  <button
                    onClick={() => { handleListFrames(true); }}
                    disabled={listLoading}
                    className="text-[10px] font-medium px-2 py-0.5 rounded-md transition-opacity hover:opacity-70 disabled:opacity-40"
                    style={{ color: "#6B5CF0", border: "1px solid rgba(107,92,240,0.3)" }}
                    title="重新從 Figma 獲取最新資料"
                  >
                    {listLoading ? "更新中…" : "↻ 重新整理"}
                  </button>
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md"
                    style={{ background: "rgba(107,92,240,0.08)", color: "#6B5CF0" }}>
                    {figmaFrameList.frames.length} 個 Frame
                  </span>
                  {figmaFrameList.comments_count != null && figmaFrameList.comments_count > 0 && (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md"
                      title="Figma 設計評論已載入，將納入 AI 分析"
                      style={{ background: "rgba(52,199,89,0.1)", color: "#34c759" }}>
                      {figmaFrameList.comments_count} 則評論
                    </span>
                  )}
                </span>
              </div>

              {/* Select all toggle */}
              <div className="px-4 py-2 border-b flex items-center gap-2"
                style={{ borderColor: "hsl(var(--border))" }}>
                <button
                  onClick={handleToggleAll}
                  className="text-[11px] font-medium transition-opacity hover:opacity-70"
                  style={{ color: "#6B5CF0" }}
                >
                  {selectedFrameIds.size === figmaFrameList.frames.length ? "全部取消" : "全部選取"}
                </button>
                <span className="text-[11px] text-muted-foreground ml-auto">
                  已選 {selectedFrameIds.size} / {figmaFrameList.frames.length}
                </span>
              </div>

              {/* Frame list */}
              <div className="max-h-[260px] overflow-y-auto">
                {(() => {
                  const byPage: Record<string, typeof figmaFrameList.frames> = {};
                  for (const f of figmaFrameList.frames) {
                    (byPage[f.page] = byPage[f.page] ?? []).push(f);
                  }
                  return Object.entries(byPage).map(([page, frames]) => (
                    <div key={page}>
                      <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
                        style={{ color: "#86868b", background: "rgba(0,0,0,0.02)", borderBottom: "1px solid hsl(var(--border))" }}>
                        {page}
                      </div>
                      {frames.map(f => {
                        const checked = selectedFrameIds.has(f.frame_id);
                        return (
                          <button
                            key={f.frame_id}
                            onClick={() => handleToggleFrame(f.frame_id)}
                            className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors border-b"
                            style={{
                              borderColor: "hsl(var(--border))",
                              background: checked ? "rgba(107,92,240,0.04)" : "transparent",
                            }}
                          >
                            {/* Checkbox */}
                            <span
                              className="shrink-0 w-4 h-4 rounded flex items-center justify-center"
                              style={{
                                border: checked ? "none" : "1.5px solid #c7c7cc",
                                background: checked ? "#6B5CF0" : "transparent",
                              }}
                            >
                              {checked && (
                                <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                                  <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                              )}
                            </span>
                            <span className="flex-1 text-[13px] truncate" style={{ color: "#1d1d1f" }}>{f.frame_name}</span>
                            <span className="shrink-0 text-[10px] font-mono" style={{ color: "#86868b" }}>
                              {f.text_count} 文字
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ));
                })()}
              </div>

              {/* Error & submit */}
              <div className="p-4 flex flex-col gap-3">
                {figmaError && (
                  <p className="text-[12px]" style={{ color: "#b91c1c" }}>{figmaError}</p>
                )}
                <button
                  onClick={() => {
                    if (figmaFrameList) {
                      const selected = figmaFrameList.frames.filter(f => selectedFrameIds.has(f.frame_id));
                      const frames = selected.length > 0 ? selected : figmaFrameList.frames;
                      onStartStory?.(figmaFrameList.file_key, figmaFrameList.file_name, frames);
                    }
                  }}
                  disabled={selectedFrameIds.size === 0 || !figmaFrameList}
                  className="w-full py-3 rounded-xl font-semibold text-[15px] transition-opacity disabled:opacity-40"
                  style={{ background: "var(--ns-accent)", color: "var(--ns-ink)" }}
                >
                  生成功能 Story →
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Text mode content (only show when in text mode) ───────────────────── */}
      {inputMode === "text" && <>

      {/* ── Phase 0 Security: Block alert ─────────────────────────────────────── */}
      {securityState?.blocked && securityState.blockAlert && (
        <div className="rounded-2xl overflow-hidden"
          style={{ border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.05)" }}>
          <div className="flex items-center gap-2.5 px-4 py-3" style={{ borderBottom: "1px solid rgba(239,68,68,0.18)", background: "rgba(239,68,68,0.08)" }}>
            <span style={{ fontSize: 16 }}>🚫</span>
            <span className="font-semibold" style={{ fontSize: 13, color: "#b91c1c" }}>Phase 0 安全檢查：需求已攔截</span>
            <span className="ml-auto text-[10px] font-mono px-2 py-0.5 rounded-full"
              style={{ background: "rgba(239,68,68,0.12)", color: "#b91c1c" }}>
              Layer 2 · 攻擊性用途
            </span>
          </div>
          <div className="px-4 py-3 space-y-2.5">
            <p style={{ fontSize: 13, color: "#7f1d1d", lineHeight: 1.6 }}>{securityState.blockAlert.message}</p>
            {securityState.blockAlert.detected.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {securityState.blockAlert.detected.map((d, i) => (
                  <span key={i} className="rounded-md px-2 py-1 font-medium"
                    style={{ fontSize: 11, background: "rgba(239,68,68,0.10)", color: "#b91c1c" }}>
                    ⚠ {d}
                  </span>
                ))}
              </div>
            )}
            {securityState.blockAlert.suggestion && (
              <div className="flex items-start gap-2 rounded-xl px-3 py-2"
                style={{ background: "rgba(255,255,255,0.6)", border: "1px solid rgba(239,68,68,0.12)" }}>
                <span style={{ fontSize: 12, flexShrink: 0 }}>💡</span>
                <p style={{ fontSize: 12, color: "#374151", lineHeight: 1.55 }}>{securityState.blockAlert.suggestion}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Phase 0 Security: Warnings (sensitive info / injection stripped) ──── */}
      {!securityState?.blocked && securityState?.warnings && securityState.warnings.length > 0 && (
        <div className="rounded-2xl overflow-hidden"
          style={{ border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.04)" }}>
          <div className="flex items-center gap-2.5 px-4 py-3" style={{ borderBottom: "1px solid rgba(245,158,11,0.18)", background: "rgba(245,158,11,0.07)" }}>
            <span style={{ fontSize: 15 }}>⚠️</span>
            <span className="font-semibold" style={{ fontSize: 13, color: "#92400e" }}>Phase 0 安全提示</span>
            <span className="ml-auto text-[10px] font-mono px-2 py-0.5 rounded-full"
              style={{ background: "rgba(245,158,11,0.12)", color: "#92400e" }}>
              已自動處理，繼續分析
            </span>
          </div>
          <div className="px-4 py-3 space-y-2">
            {securityState.warnings.map((w, i) => (
              <div key={i} className="space-y-1">
                <p style={{ fontSize: 12.5, color: "#78350f", lineHeight: 1.6 }}>{w.message}</p>
                {w.suggestion && (
                  <p style={{ fontSize: 11.5, color: "#92400e", opacity: 0.75 }}>💡 {w.suggestion}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Rate Limit error card ─────────────────────────────────────────────── */}
      {rateLimitState && status === "error" && (
        <div className="rounded-2xl overflow-hidden"
          style={{ border: `1px solid ${rateLimitState.type === 'daily' ? 'rgba(139,92,246,0.35)' : 'rgba(245,158,11,0.35)'}`,
                   background: rateLimitState.type === 'daily' ? 'rgba(139,92,246,0.04)' : 'rgba(245,158,11,0.04)' }}>
          <div className="flex items-center gap-2.5 px-4 py-3"
            style={{ borderBottom: `1px solid ${rateLimitState.type === 'daily' ? 'rgba(139,92,246,0.18)' : 'rgba(245,158,11,0.18)'}`,
                     background: rateLimitState.type === 'daily' ? 'rgba(139,92,246,0.07)' : 'rgba(245,158,11,0.07)' }}>
            <span style={{ fontSize: 16 }}>{rateLimitState.type === 'daily' ? '📅' : '⏱'}</span>
            <span className="font-semibold flex-1" style={{ fontSize: 13, color: rateLimitState.type === 'daily' ? '#6d28d9' : '#92400e' }}>
              {rateLimitState.type === 'daily' ? '今日呼叫次數已達上限' : '請求頻率過高'}
            </span>
            {rateLimitState.type === 'rate' && countdown > 0 && (
              <span className="font-mono font-bold tabular-nums rounded-lg px-2.5 py-1"
                style={{ fontSize: 13, background: 'rgba(245,158,11,0.15)', color: '#92400e' }}>
                {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}
              </span>
            )}
          </div>
          <div className="px-4 py-3 space-y-2">
            <p style={{ fontSize: 13, color: rateLimitState.type === 'daily' ? '#4c1d95' : '#78350f', lineHeight: 1.6 }}>
              {rateLimitState.message}
            </p>
            {rateLimitState.type === 'rate' && countdown > 0 && (
              <div className="flex items-center gap-2">
                <div className="flex-1 rounded-full overflow-hidden" style={{ height: 3, background: 'hsl(var(--muted))' }}>
                  <div className="h-full rounded-full transition-all duration-1000"
                    style={{ width: `${(countdown / (rateLimitState.retryAfter ?? 600)) * 100}%`,
                             background: '#f59e0b' }} />
                </div>
                <span style={{ fontSize: 11, color: '#92400e' }}>冷卻中</span>
              </div>
            )}
            {rateLimitState.type === 'daily' && rateLimitState.used !== undefined && (
              <p style={{ fontSize: 11.5, color: '#6d28d9', opacity: 0.75 }}>
                今日已使用：{rateLimitState.used} / {rateLimitState.limit} 次，明日 00:00 重置
              </p>
            )}
          </div>
        </div>
      )}

      {/* Onboarding hero (4-step flow + roles) removed — flow explanation now lives under the subtitle */}



      {/* ── Heading — hidden when pipeline is running or in plan_confirm ── */}
      {!isRunning && interruptType !== "plan_confirm" && (
        <div className="space-y-2.5">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-[26px] font-extrabold tracking-[-0.03em] text-foreground leading-none">
              需求輸入
            </h1>
            <span className="text-[11px] font-bold px-2.5 py-1 rounded-full leading-none"
              style={{ color: "var(--ns-accent-deep)", background: "var(--ns-accent-soft)", border: "1px solid #DCEFA9" }}>
              PHASE 1
            </span>
          </div>
          <p className="text-[14px] text-muted-foreground leading-relaxed max-w-[560px]">
            用自然語言描述您的網通功能需求，NetSpec 會引導您補齊細節，並生成可交付的完整規格書。
          </p>

          {/* ── 流程解說（可展開小卡，置於副標題下方）── */}
          <div className="flex flex-col gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowFlow(v => !v)}
              className="inline-flex items-center gap-1.5 self-start text-[12.5px] font-semibold px-3 py-1.5 rounded-full transition-all hover:bg-[#6B5CF0]/[0.07]"
              style={{ color: "#6B5CF0", border: "1px solid rgba(107,92,240,0.25)", background: "rgba(107,92,240,0.04)" }}
              aria-expanded={showFlow}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
                <circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" />
              </svg>
              流程解說：這個 AI 會怎麼執行
              <span className="transition-transform" style={{ fontSize: 10, transform: showFlow ? "rotate(90deg)" : "none" }}>▸</span>
            </button>

            {showFlow && (
              <div className="rounded-2xl p-4 flex flex-col gap-2.5"
                style={{ background: "#fff", border: "1px solid hsl(var(--border))", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
                <p className="text-[11.5px] leading-snug" style={{ color: "#6e6e73" }}>
                  半自動流程，過程中會請你參與；產出是結構化的網通技術規格書（<span style={{ fontWeight: 600, color: "#1d1d1f" }}>FR / NFR / 驗收標準</span>），可再優化迭代。預計數分鐘（含社群情報搜尋）。
                </p>
                {[
                  { n: "1", icon: "🛡️", title: "安全檢查", desc: "三層檢查（敏感資訊／攻擊性用途／Prompt Injection），自動遮蔽或攔截", who: "AI 自動" },
                  { n: "2", icon: "💬", title: "蘇格拉底追問", desc: "從 10 個維度問問題、最多 5 輪，把模糊需求問清楚", who: "需要你作答（可跳過）" },
                  { n: "3", icon: "🔍", title: "搜尋規劃 + 確認", desc: "AI 規劃要查的社群／CVE／RFC 來源，你確認後開始", who: "需要你確認" },
                  { n: "4", icon: "🌐", title: "社群災情搜尋 + 邊界分析", desc: "爬取 CVE / RFC Errata / GitHub Issues 並分析風險與邊界條件（可在左側「執行進度／研究日誌」即時查看）", who: "AI 自動" },
                  { n: "5", icon: "📄", title: "PRD 生成 + 品質校驗", desc: "產生結構化規格（FR / NFR / AC / 開放問題）並自動評分", who: "AI 自動" },
                  { n: "6", icon: "✏️", title: "輸出 + 優化迭代", desc: "檢視規格書，可針對方向再優化重跑", who: "你操作" },
                ].map(s => {
                  const needsYou = s.who.startsWith("需要你") || s.who.startsWith("你");
                  return (
                    <div key={s.n} className="flex items-start gap-2.5">
                      <span className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold mt-px"
                        style={{ background: "rgba(107,92,240,0.1)", color: "#6B5CF0" }}>{s.n}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[12px] font-semibold" style={{ color: "#1d1d1f" }}>{s.icon} {s.title}</span>
                          <span className="text-[9.5px] px-1.5 py-0.5 rounded-full font-medium"
                            style={needsYou
                              ? { background: "rgba(245,158,11,0.12)", color: "#b45309" }
                              : { background: "rgba(0,0,0,0.05)", color: "#86868b" }}>
                            {s.who}
                          </span>
                        </div>
                        <p className="text-[11px] mt-0.5 leading-snug" style={{ color: "#6e6e73" }}>{s.desc}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Input card — hidden when running or in plan_confirm ──────────────── */}
      <div
        className={cn("rounded-2xl overflow-hidden transition-all duration-200", (isRunning || interruptType === "plan_confirm") && "hidden")}
        style={{
          background:  "hsl(var(--card))",
          border:      focused
            ? "1px solid #6B5CF0"
            : "1px solid hsl(var(--border))",
          boxShadow:   focused
            ? "0 0 0 3px #6B5CF01a, 0 2px 8px rgba(0,0,0,0.06)"
            : "0 1px 4px rgba(0,0,0,0.05)",
        }}
      >
        {/* Card chrome */}
        <div
          className="flex items-center gap-2 px-4 py-2.5 border-b select-none"
          style={{ borderColor: "hsl(var(--border))" }}
        >
          <span
            className="w-[7px] h-[7px] rounded-full shrink-0"
            style={{ background: "var(--ns-accent-deep)", boxShadow: "0 0 10px var(--ns-accent)" }}
          />
          <span className="text-[11px] font-medium text-muted-foreground tracking-widest uppercase">
            原始需求描述
          </span>
        </div>

        {/* Textarea */}
        <div className="px-4 pt-3 pb-1">
          <textarea
            ref={textareaRef}
            value={req}
            onChange={handleChange}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={handleKeyDown}
            disabled={isRunning}
            rows={7}
            placeholder="請詳細描述您的網路需求，例如：需要在核心交換器上實作 BGP 路由備援功能，當主路由發生故障時能在 500ms 內完成切換…"
            className={cn(
              "w-full resize-none bg-transparent border-0 outline-none ring-0",
              "text-[14.5px] leading-[1.7] text-foreground",
              "placeholder:text-muted-foreground/40",
              "disabled:opacity-40 disabled:cursor-not-allowed",
            )}
            style={{
              fontFamily: "inherit",
              minHeight: "168px",
              maxHeight: "320px",
            }}
          />
        </div>

        {/* Character counter */}
        {req.trim().length > 0 && (() => {
          const len = req.trim().length;
          const MAX = 500; const WARN = 400; const MIN = 10;
          const isOver  = len > MAX;
          const isWarn  = len > WARN && !isOver;
          const isShort = len > 0 && len < MIN;
          const pct = Math.min(len / MAX * 100, 100);
          const barColor = isOver ? "#ef4444" : isWarn ? "#f59e0b" : "#22c55e";
          return (
            <div className="px-4 pb-2 space-y-1">
              <div className="flex items-center justify-between">
                <span style={{ fontSize: 10.5, color: isOver ? "#dc2626" : isWarn ? "#92400e" : "hsl(var(--muted-foreground))", fontWeight: isOver || isWarn ? 600 : 400 }}>
                  {isOver  ? `⚠ 超出上限，請縮短至 ${MAX} 字以內` :
                   isShort ? `需至少 ${MIN} 字才能開始分析` :
                   isWarn  ? `接近上限，建議精簡需求` : ""}
                </span>
                <span className="font-mono tabular-nums"
                  style={{ fontSize: 10.5, color: isOver ? "#dc2626" : isWarn ? "#92400e" : "hsl(var(--muted-foreground))", fontWeight: isOver ? 700 : 400 }}>
                  {len} / {MAX}
                </span>
              </div>
              <div className="rounded-full overflow-hidden" style={{ height: 2, background: "hsl(var(--muted))" }}>
                <div className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${pct}%`, background: barColor }} />
              </div>
            </div>
          );
        })()}

        {/* Footer: score bar — shows AI score after parse, local estimate before */}
        <ScoreBar score={score} label={scoreLabel} />

        {/* Feedback row: detected keywords + missing hints */}
        {req.trim().length > 0 && (
          <div className="px-4 pb-3 space-y-2">
            {/* Detected protocols/actions */}
            {(detectedProtocols.length > 0 || detectedActions.length > 0) && (
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-[10px] text-muted-foreground/60 shrink-0">識別到：</span>
                {detectedProtocols.slice(0, 5).map(p => (
                  <span key={p} className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded"
                    style={{ background: "rgba(107,92,240,0.08)", color: "#6B5CF0" }}>
                    {p.toUpperCase()}
                  </span>
                ))}
                {detectedActions.slice(0, 3).map(a => (
                  <span key={a} className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: "rgba(52,199,89,0.08)", color: "#16a34a" }}>
                    {a}
                  </span>
                ))}
              </div>
            )}
            {/* Missing hints — only when score < 70 */}
            {score < 70 && missingHints.length > 0 && (
              <div className="flex items-start gap-1.5">
                <span className="text-[10px] shrink-0 mt-px" style={{ color: "#ff9500" }}>建議補充：</span>
                <span className="text-[10px] leading-relaxed" style={{ color: "#ff9500" }}>
                  {missingHints.join("、")}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Footer: char count */}
        <div
          className="flex items-center justify-between px-4 py-2 border-t"
          style={{ borderColor: "hsl(var(--border))", background: "hsl(var(--muted) / 0.3)" }}
        >
          <span className="text-[11px] text-muted-foreground/60 select-none">
            {req.length > 0 ? `${req.length} 字元` : "輸入您的需求描述"}
          </span>
          <span className="text-[11px] text-muted-foreground/40 select-none hidden sm:block">
            ⌘ Return 送出
          </span>
        </div>
      </div>

      {/* ── Quick fill ──────────────────────────────────────────────────────── */}
      {!isRunning && !interruptType && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[12px] font-bold tracking-[0.04em]" style={{ color: "var(--ns-muted)" }}>
            <span className="rounded-[3px]" style={{ width: 4, height: 13, background: "var(--ns-accent)" }} />
            快速範例
          </div>
          <div className="flex gap-3 flex-wrap">
            {QUICK_FILL.map(ex => (
              <button
                key={ex.label}
                type="button"
                onClick={() => handleQuickFill(ex.text)}
                title={`填入後清晰度約 ${ex.score} 分（已達標）`}
                className="group flex items-center gap-3 rounded-[13px] px-3.5 py-3 text-left transition-all duration-200 select-none active:scale-[0.99]"
                style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", minWidth: 200, flex: "1 1 200px", maxWidth: 300,
                         boxShadow: "0 1px 2px rgba(16,21,27,.03)" }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "#D6E4A8"; e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 10px 26px -16px rgba(16,21,27,.3)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "hsl(var(--border))"; e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "0 1px 2px rgba(16,21,27,.03)"; }}
              >
                <span className="grid place-items-center rounded-[9px] shrink-0" style={{ width: 30, height: 30, background: "var(--ns-violet-soft)", color: "var(--ns-violet)" }}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16 }}>{ex.icon}</svg>
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13.5px] font-bold leading-tight" style={{ color: "var(--ns-text)" }}>{ex.title}</span>
                  <span className="block text-[11px] font-semibold mt-px" style={{ color: "var(--ns-muted-2)" }}>{ex.sub}</span>
                </span>
                <ScoreRing score={ex.score} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Interrupt: Socratic ─────────────────────────────────────────────── */}
      {interruptType === "socratic" && interruptData && (
        <SocraticCard
          data={interruptData as SocraticInterrupt}
          onSubmit={onSubmitAnswers}
          onProceed={onProceed}
          onSkip={onSkip}
        />
      )}

      {/* ── Interrupt: plan_confirm ─────────────────────────────────────────── */}
      {interruptType === "plan_confirm" && interruptData && !showRevise && (
        <div className="flex items-center gap-2 px-1">
          <div className="flex items-center gap-1.5">
            <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white" style={{ background: "#8b5cf6" }}>2</span>
            <span className="text-[12px] font-medium text-muted-foreground">Phase 2 — 社群情報搜尋</span>
          </div>
          <div className="flex-1 h-px" style={{ background: "hsl(var(--border))" }} />
        </div>
      )}
      {interruptType === "plan_confirm" && interruptData && (
        renderPlanStep(interruptData as PlanConfirmInterrupt)
      )}

      {/* ── 規格詳細度選擇 ──────────────────────────────────────────────────── */}
      {!interruptType && !isRunning && (
        <section className="rounded-2xl p-5"
          style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", boxShadow: "0 1px 2px rgba(16,21,27,.04), 0 12px 32px -16px rgba(16,21,27,.10)" }}>
          <div className="flex items-center justify-between gap-3.5 flex-wrap">
            <span className="text-[15px] font-extrabold" style={{ color: "var(--ns-text)" }}>規格詳細度</span>
            <div className="flex gap-[3px] rounded-xl p-1" style={{ background: "#F1F3EC" }}>
              {([
                ["concise",       "精簡", "約 3 條需求，省略社群災情與開放問題，產出最短、生成最快"],
                ["standard",      "標準", "3–5 條需求，含中高風險邊界與完整章節，平衡（預設）"],
                ["comprehensive", "完整", "5–8 條需求，涵蓋所有邊界與技術深度，最詳盡"],
              ] as const).map(([v, label, tip]) => (
                <button
                  key={v}
                  type="button"
                  title={tip}
                  onClick={() => setDetailLevel(v)}
                  className="text-[13.5px] font-bold rounded-[9px] transition-all select-none"
                  style={{
                    padding: "8px 22px",
                    background: detailLevel === v ? "#fff" : "transparent",
                    color: detailLevel === v ? "var(--ns-text)" : "var(--ns-muted)",
                    boxShadow: detailLevel === v ? "0 2px 8px -3px rgba(16,21,27,.2)" : "none",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2 flex-wrap text-[13px] leading-[1.6] font-medium" style={{ color: "var(--ns-muted)" }}>
            {detailLevel === "concise" ? (
              <><span className={TK}>約 3 條需求</span>只列高風險邊界<span className={TK}>省略社群與開放問題</span>產出最短、生成最快。</>
            ) : detailLevel === "comprehensive" ? (
              <><span className={TK}>5–8 條需求</span>涵蓋所有風險等級邊界<span className={TK}>含技術深度與基準數值</span>最完整詳盡。</>
            ) : (
              <><span className={TK}>3–5 條需求</span>依複雜度生成<span className={TK}>含中高風險邊界</span><span className={TK}>完整章節</span>涵蓋社群、災情與開放問題 — 平衡且適合多數情境。</>
            )}
          </div>
        </section>
      )}

      {/* ── Start button ────────────────────────────────────────────────────── */}
      {!interruptType && (
        <button
          disabled={!canStart}
          onClick={handleStart}
          className={cn(
            "relative w-full py-[15px] rounded-[15px]",
            "text-[16px] font-extrabold tracking-[-0.01em]",
            "transition-all duration-200 select-none overflow-hidden",
            canStart
              ? "hover:brightness-105 active:scale-[0.992]"
              : "opacity-35 cursor-not-allowed",
          )}
          style={{ background: "var(--ns-accent)", color: "var(--ns-ink)",
                   boxShadow: canStart ? "0 14px 30px -12px rgba(166,220,27,.6)" : "none" }}
        >
          {/* Subtle gloss overlay */}
          <span
            className="pointer-events-none absolute inset-x-0 top-0 h-1/2 rounded-t-xl opacity-[0.12]"
            style={{ background: "linear-gradient(to bottom, white, transparent)" }}
          />
          <span className="relative">
            {isRunning ? (
              <span className="inline-flex items-center gap-2">
                <LoadingDots />
                分析中
              </span>
            ) : (
              "開始分析"
            )}
          </span>
        </button>
      )}

      </> /* end text mode */}
    </div>
  );
}

// ─── Loading dots ─────────────────────────────────────────────────────────────

function LoadingDots() {
  return (
    <span className="inline-flex items-end gap-[3px] h-[14px]">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="w-[4px] h-[4px] rounded-full bg-white/80 animate-bounce"
          style={{ animationDelay: `${i * 0.15}s`, animationDuration: "0.9s" }}
        />
      ))}
    </span>
  );
}
