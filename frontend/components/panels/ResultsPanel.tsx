"use client";

import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { cn } from "@/lib/utils";
import {
  Hexagon,
  RotateCcw,
  ExternalLink,
  AlertTriangle,
  FileText,
  MessageSquare,
  Search,
  PenLine,
  ArrowRight,
} from "lucide-react";
import type { SpecResult, Citation, EdgeCase, DisasterPattern, IssueDelta } from "@/lib/types";
import { useNetSpec } from "@/hooks/useNetSpec";
import { track } from "@/lib/track";

/* ─────────────────────────────────────────────────────────────────────────────
   Props
───────────────────────────────────────────────────────────────────────────── */

interface ResultsPanelProps {
  result: SpecResult | null;
  currentIteration: number;
  onIterate: (feedback?: string) => void;
  // (A4) surface optimize/iterate failures where iteration actually happens
  status?: string;
  error?: string | null;
  rateLimitState?: { type: 'rate' | 'daily'; message: string; retryAfter?: number; used?: number; limit?: number } | null;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────────────────────────── */

function getRiskLevel(edgeCases: EdgeCase[]): "HIGH" | "MED" | "LOW" {
  const highCount = edgeCases.filter((e) => e.risk === "high").length;
  if (highCount >= 3) return "HIGH";
  if (highCount >= 1) return "MED";
  return "LOW";
}

function riskBadgeStyle(level: "HIGH" | "MED" | "LOW") {
  if (level === "HIGH")
    return { background: "rgba(239,68,68,0.10)", color: "#b91c1c", border: "1px solid rgba(239,68,68,0.22)" };
  if (level === "MED")
    return { background: "rgba(245,158,11,0.10)", color: "#92400e", border: "1px solid rgba(245,158,11,0.22)" };
  return { background: "rgba(34,197,94,0.10)", color: "#166534", border: "1px solid rgba(34,197,94,0.22)" };
}

function edgeBarColor(risk: EdgeCase["risk"]): string {
  if (risk === "high") return "#ef4444";
  if (risk === "mid") return "#f59e0b";
  return "#22c55e";
}

function validationBarColor(issue: string): string {
  if (/error|fail|critical|high/i.test(issue)) return "#ef4444";
  if (/warn|mid|medium/i.test(issue)) return "#f59e0b";
  return "#3b82f6";
}

function scoreColor(score: number): string {
  if (score >= 80) return "#16a34a";
  if (score >= 60) return "#d97706";
  return "#dc2626";
}

/* ─────────────────────────────────────────────────────────────────────────────
   Citation icon
───────────────────────────────────────────────────────────────────────────── */

function CitationIcon({ source }: { source: Citation["source"] }) {
  if (source === "github") {
    return (
      <svg
        viewBox="0 0 24 24"
        className="shrink-0 fill-current"
        style={{ width: 15, height: 15, color: "#24292f" }}
        aria-hidden="true"
      >
        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.605-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12" />
      </svg>
    );
  }
  if (source === "reddit") {
    return (
      <svg
        viewBox="0 0 24 24"
        className="shrink-0 fill-current"
        style={{ width: 15, height: 15, color: "#ff4500" }}
        aria-hidden="true"
      >
        <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z" />
      </svg>
    );
  }
  // Hacker News
  return (
    <svg
      viewBox="0 0 24 24"
      className="shrink-0 fill-current"
      style={{ width: 15, height: 15, color: "#f97316" }}
      aria-hidden="true"
    >
      <path d="M0 0v24h24V0H0zm12.8 14.652V20h-1.6v-5.348L6.4 6h1.762l3.838 7.17L15.838 6H17.6l-4.8 8.652z" />
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Empty state
───────────────────────────────────────────────────────────────────────────── */

function EmptyState() {
  const STEPS = [
    {
      Icon: PenLine,
      title: "描述需求",
      desc: "輸入網通功能需求\nAI 即時評估清晰度",
      color: "#6B5CF0",
      bg: "rgba(107,92,240,0.08)",
      border: "rgba(107,92,240,0.15)",
    },
    {
      Icon: MessageSquare,
      title: "引導追問",
      desc: "最多 5 輪問答\n補充技術細節與邊界",
      color: "#8b5cf6",
      bg: "rgba(139,92,246,0.08)",
      border: "rgba(139,92,246,0.15)",
    },
    {
      Icon: Search,
      title: "社群情報",
      desc: "搜尋 GitHub / HN\n真實故障與解決方案",
      color: "#f59e0b",
      bg: "rgba(245,158,11,0.08)",
      border: "rgba(245,158,11,0.18)",
    },
    {
      Icon: FileText,
      title: "生成規格書",
      desc: "PRD + 邊界條件\n品質校驗報告",
      color: "#22c55e",
      bg: "rgba(34,197,94,0.08)",
      border: "rgba(34,197,94,0.18)",
    },
  ];

  return (
    <div className="flex flex-col items-center justify-center select-none"
      style={{ minHeight: 480, padding: "48px 24px" }}>

      {/* ── Central illustration ── */}
      <div className="relative mb-8">
        {/* outer glow ring */}
        <div className="absolute inset-0 rounded-3xl"
          style={{ background: "radial-gradient(circle, rgba(107,92,240,0.08) 0%, transparent 70%)", transform: "scale(2.5)" }} />
        <div className="relative flex items-center justify-center rounded-3xl"
          style={{ width: 80, height: 80, background: "linear-gradient(135deg, #F3F1FE 0%, #ECEAFB 100%)", border: "1px solid rgba(107,92,240,0.15)", boxShadow: "0 4px 24px rgba(107,92,240,0.12)" }}>
          <FileText style={{ width: 36, height: 36, color: "#6B5CF0", opacity: 0.85 }} strokeWidth={1.5} />
        </div>
      </div>

      {/* ── Heading ── */}
      <div className="text-center mb-10">
        <h2 className="font-semibold tracking-tight" style={{ fontSize: 20, color: "hsl(var(--foreground))", letterSpacing: "-0.3px" }}>
          規格書將在這裡顯示
        </h2>
        <p className="mt-2" style={{ fontSize: 13.5, color: "hsl(var(--muted-foreground))", lineHeight: 1.6 }}>
          完成左側「需求輸入」流程後，PRD 規格書會自動出現
        </p>
      </div>

      {/* ── Flow steps ── */}
      <div className="flex items-stretch gap-0 max-w-[600px] w-full">
        {STEPS.map((s, i) => (
          <div key={i} className="flex items-stretch gap-0 flex-1 min-w-0">
            {/* Step card */}
            <div className="flex-1 flex flex-col items-center gap-2 px-3 py-4 rounded-2xl text-center"
              style={{ background: s.bg, border: `1px solid ${s.border}` }}>
              <div className="flex items-center justify-center rounded-xl shrink-0"
                style={{ width: 36, height: 36, background: "rgba(255,255,255,0.7)", border: `1px solid ${s.border}` }}>
                <s.Icon style={{ width: 16, height: 16, color: s.color }} strokeWidth={2} />
              </div>
              <span className="font-semibold leading-none" style={{ fontSize: 12, color: s.color }}>
                {s.title}
              </span>
              <span style={{ fontSize: 10.5, color: "hsl(var(--muted-foreground))", lineHeight: 1.5, whiteSpace: "pre-line" }}>
                {s.desc}
              </span>
            </div>
            {/* Connector arrow */}
            {i < STEPS.length - 1 && (
              <div className="flex items-center px-1 shrink-0">
                <ArrowRight style={{ width: 12, height: 12, color: "hsl(var(--muted-foreground))", opacity: 0.35 }} />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── Hint ── */}
      <p className="mt-8" style={{ fontSize: 12, color: "hsl(var(--muted-foreground))", opacity: 0.5 }}>
        點選左側「需求輸入」開始分析 →
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Chip (small label pill)
───────────────────────────────────────────────────────────────────────────── */

function Chip({
  children,
  color = "violet",
}: {
  children: React.ReactNode;
  color?: "violet" | "amber" | "blue" | "emerald";
}) {
  const styles: Record<string, React.CSSProperties> = {
    violet: { background: "rgba(139,92,246,0.10)", color: "#6d28d9", border: "1px solid rgba(139,92,246,0.20)" },
    amber:  { background: "rgba(245,158,11,0.10)", color: "#92400e", border: "1px solid rgba(245,158,11,0.22)" },
    blue:   { background: "rgba(59,130,246,0.10)", color: "#1d4ed8", border: "1px solid rgba(59,130,246,0.20)" },
    emerald:{ background: "rgba(16,185,129,0.10)", color: "#065f46", border: "1px solid rgba(16,185,129,0.20)" },
  };
  return (
    <span
      className="inline-flex items-center font-mono font-semibold rounded-md px-2 py-[3px] leading-none"
      style={{ fontSize: 10, letterSpacing: "0.04em", ...styles[color] }}
    >
      {children}
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Markdown renderers
───────────────────────────────────────────────────────────────────────────── */

// REQ-XXX pill colour map
const REQ_COLORS: Record<string, { bg: string; color: string }> = {
  "REQ-001": { bg: "#ECEAFB", color: "#6B5CF0" },
  "REQ-002": { bg: "#edeafe", color: "#6d4adf" },
  "REQ-003": { bg: "#e8faf0", color: "#16a34a" },
  "REQ-004": { bg: "#fff7e8", color: "#d97706" },
  "REQ-005": { bg: "#fde8e8", color: "#dc2626" },
  "REQ-006": { bg: "#F3F1FE", color: "#0369a1" },
};
const REQ_RE = /^(REQ-\d+)\s+(.+)$/;

const markdownComponents: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  h1: ({ children }) => (
    <h1 style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.25, marginBottom: 16, paddingBottom: 10, borderBottom: "1px solid hsl(var(--border))" }}>
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.02em", marginTop: 24, marginBottom: 12 }}>
      {children}
    </h2>
  ),
  h3: ({ children }) => {
    const text = String(children ?? "");
    const m = REQ_RE.exec(text);
    if (m) {
      const c = REQ_COLORS[m[1]] ?? { bg: "#f0f0f5", color: "#555" };
      return (
        <h3 style={{ fontSize: 13, fontWeight: 600, marginTop: 16, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 6, background: c.bg, color: c.color, letterSpacing: "0.04em", flexShrink: 0 }}>
            {m[1]}
          </span>
          <span style={{ color: "hsl(var(--foreground))" }}>{m[2]}</span>
        </h3>
      );
    }
    return <h3 style={{ fontSize: 13, fontWeight: 600, marginTop: 16, marginBottom: 8, color: "#6B5CF0" }}>{children}</h3>;
  },
  p: ({ children }) => (
    <p style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 12, color: "hsl(var(--foreground) / 0.85)" }}>{children}</p>
  ),
  ul: ({ children }) => (
    <ul style={{ fontSize: 13, marginBottom: 12, paddingLeft: 4 }}>{children}</ul>
  ),
  li: ({ children }) => {
    const text = String(children ?? "");
    // Render "✅ ..." as checkbox-style item
    const isCheck = text.startsWith("✅");
    return (
      <li style={{ fontSize: 13, lineHeight: 1.65, marginBottom: 5, display: "flex", alignItems: "flex-start", gap: 7 }}>
        {isCheck ? (
          <span style={{ marginTop: 1, flexShrink: 0, width: 16, height: 16, borderRadius: 4, background: "rgba(52,199,89,0.12)", border: "1.5px solid #22c55e", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 9, color: "#16a34a", fontWeight: 700 }}>✓</span>
          </span>
        ) : (
          <span style={{ marginTop: 7, width: 4, height: 4, borderRadius: 9999, background: "hsl(var(--muted-foreground) / 0.5)", flexShrink: 0 }} />
        )}
        <span style={{ color: "hsl(var(--foreground) / 0.85)" }}>{isCheck ? text.slice(1).trim() : children}</span>
      </li>
    );
  },
  strong: ({ children }) => <strong style={{ fontWeight: 600, color: "hsl(var(--foreground))" }}>{children}</strong>,
  hr: () => <hr style={{ borderColor: "hsl(var(--border))", margin: "16px 0" }} />,
  code: ({ children }) => (
    <code style={{ fontSize: 12, fontFamily: "var(--font-mono)", background: "hsl(var(--muted))", padding: "2px 6px", borderRadius: 4 }}>
      {children}
    </code>
  ),
};

/* ─────────────────────────────────────────────────────────────────────────────
   PRD Document card
───────────────────────────────────────────────────────────────────────────── */

// 精簡檢視：只保留 §1 概述 / §2 需求 / §3 NFR / §6 依賴，略過 §4 邊界 / §5 社群 / §7 開放問題
function compactSpec(md: string): string {
  const KEEP = new Set(["1", "2", "3", "6"]);
  const out: string[] = [];
  let dropping = false;
  for (const ln of md.split("\n")) {
    const m = ln.match(/^##\s+(\d+)\.\s/);
    if (m) {
      dropping = !KEEP.has(m[1]);
      if (dropping) {
        while (out.length && (out[out.length - 1].trim() === "" || out[out.length - 1].trim() === "---")) out.pop();
        continue;
      }
    }
    if (ln.startsWith("_此文件")) dropping = false;   // always keep footer note
    if (!dropping) out.push(ln);
  }
  return out.join("\n");
}

// Printable export — always the FULL document, unaffected by on-screen sectioning.
function printSpec(doc: string, featureTitle: string, reqType: string) {
  const win = window.open("", "_blank", "width=900,height=700");
  if (!win) return;
  const html = doc
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^#{3} (.+)$/gm, "<h3>$1</h3>")
    .replace(/^#{2} (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^---$/gm, "<hr>")
    .replace(/^[-*] (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>(\n|$))+/g, (m) => `<ul>${m}</ul>`)
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/^(?!<[hul]|<hr|<\/[hul])(.+)/gm, "$1");

  win.document.write(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <title>${featureTitle}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
           font-size: 13px; line-height: 1.7; color: #1a1a1a;
           max-width: 800px; margin: 0 auto; padding: 48px 40px; }
    h1 { font-size: 22px; font-weight: 700; margin: 0 0 6px; }
    h2 { font-size: 16px; font-weight: 600; margin: 28px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #e5e5ea; }
    h3 { font-size: 13px; font-weight: 600; margin: 16px 0 6px; color: #6B5CF0; }
    p  { margin: 0 0 10px; }
    ul { margin: 0 0 10px 18px; }
    li { margin: 3px 0; }
    hr { border: none; border-top: 1px solid #e5e5ea; margin: 20px 0; }
    code { font-family: "SF Mono", monospace; font-size: 11px; background: #f2f2f7; padding: 1px 5px; border-radius: 4px; }
    strong { font-weight: 600; }
    .meta { font-size: 11px; color: #8e8e93; margin-bottom: 32px; }
    @media print {
      body { padding: 24px; }
      h2 { page-break-after: avoid; }
    }
  </style>
</head><body>
  <h1>${featureTitle}</h1>
  <p class="meta">${reqType.toUpperCase()} · NetSpec</p>
  <p>${html}</p>
  <script>window.onload = () => { window.print(); }<\/script>
</body></html>`);
  win.document.close();
}

/* ── Split PRD markdown into "## N. Title" sections (for sectioned reading) ── */
type PrdSection = { id: string; num: string; label: string; body: string };
function splitPrdSections(md: string): { preamble: string; sections: PrdSection[] } {
  const out: PrdSection[] = [];
  const pre: string[] = [];
  let cur: PrdSection | null = null;
  for (const ln of (md || "").split("\n")) {
    const m = ln.match(/^##\s+(\d+)\.\s+(.+?)\s*$/);
    if (m) {
      if (cur) out.push(cur);
      cur = { id: `prd-sec-${m[1]}`, num: m[1], label: m[2].trim().replace(/_/g, ""), body: "" };
      continue;
    }
    if (cur) cur.body += ln + "\n";
    else pre.push(ln);
  }
  if (cur) out.push(cur);
  // drop the H1 title line from the preamble (already shown in the header row)
  const preamble = pre.filter((l) => !/^#\s/.test(l)).join("\n").trim();
  return { preamble, sections: out };
}

// Identify a section by its title (language-tolerant) rather than its number —
// the backend now numbers sections contiguously, so numbers shift when optional
// sections are omitted; matching on role keeps the §4/§5 fold stable.
function sectionRole(label: string): "edges" | "disaster" | "openq" | "normal" {
  if (/邊界|edge|boundary/i.test(label))                 return "edges";
  if (/社群|災情|disaster|community|incident/i.test(label)) return "disaster";
  if (/開放問題|open question|open issue/i.test(label))   return "openq";
  return "normal";
}

// One-line "what is this section for" hint shown under each section title.
function sectionHint(label: string): string {
  if (/概述|overview|摘要|summary/i.test(label))     return "這個功能要解決什麼、範圍到哪";
  if (/功能需求|functional/i.test(label))            return "系統必須具備的能力與驗收標準";
  if (/非功能|nfr/i.test(label))                     return "效能、可靠性等品質門檻";
  if (/依賴|depend/i.test(label))                    return "需要哪些協定或子系統配合";
  if (/開放問題|open question|open issue/i.test(label)) return "尚待人工確認的決策";
  if (/範圍|scope/i.test(label))                     return "包含與不包含的事項";
  if (/驗收|acceptance/i.test(label))               return "如何判定功能完成";
  if (/架構|design|interface/i.test(label))          return "設計決策與介面契約";
  if (/測試|test|場景|scenario/i.test(label))        return "測試場景與通過條件";
  return "";
}

/* ── One PRD section rendered as a card (markdown sections only) ── */
function SectionCard({ id, title, hint, innerRef, children }: {
  id: string; title: string; hint?: string;
  innerRef: (el: HTMLElement | null) => void;
  children: React.ReactNode;
}) {
  // Contiguous section numbering lives in the side TOC; the card shows just the
  // title (+ a one-line hint) so folded rich-card sections never create number gaps.
  return (
    <section
      id={id}
      ref={innerRef}
      className="rounded-2xl overflow-hidden scroll-mt-4"
      style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}
    >
      <div className="flex items-baseline gap-2.5 px-5 py-3.5 flex-wrap" style={{ borderBottom: "1px solid hsl(var(--border))" }}>
        <span style={{ width: 4, height: 14, borderRadius: 2, background: "var(--ns-accent-deep)", flexShrink: 0, alignSelf: "center" }} />
        <span className="font-semibold tracking-tight" style={{ fontSize: 13.5, color: "hsl(var(--foreground))" }}>
          {title}
        </span>
        {hint && (
          <span style={{ fontSize: 11, color: "hsl(var(--muted-foreground))" }}>{hint}</span>
        )}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

/* ── Sticky section navigator (gives "tab-like" jumping without fragmenting the doc) ── */
function PrdToc({ items, activeId, onJump }: {
  items: { id: string; label: string }[];
  activeId: string;
  onJump: (id: string) => void;
}) {
  return (
    <nav className="flex flex-col gap-0.5">
      <p className="px-2.5 pb-1.5 font-semibold uppercase" style={{ fontSize: 10, letterSpacing: "0.07em", color: "hsl(var(--muted-foreground))" }}>章節</p>
      {items.map((it) => {
        const active = it.id === activeId;
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onJump(it.id)}
            className="text-left rounded-lg px-2.5 py-[7px] transition-colors truncate hover:bg-black/[0.04]"
            style={active
              ? { background: "rgba(107,92,240,0.10)", color: "#6B5CF0", fontWeight: 600, fontSize: 12 }
              : { color: "hsl(var(--muted-foreground))", fontSize: 12 }}
            title={it.label}
          >
            {it.label}
          </button>
        );
      })}
    </nav>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Edge Cases card
───────────────────────────────────────────────────────────────────────────── */

const RISK_CFG = {
  high: { label: "高風險", bar: "#ef4444", bg: "rgba(239,68,68,0.06)",  badge: "rgba(239,68,68,0.10)",  badgeText: "#b91c1c", border: "rgba(239,68,68,0.18)" },
  mid:  { label: "中風險", bar: "#f59e0b", bg: "rgba(245,158,11,0.05)", badge: "rgba(245,158,11,0.10)", badgeText: "#92400e", border: "rgba(245,158,11,0.18)" },
  low:  { label: "低風險", bar: "#22c55e", bg: "rgba(34,197,94,0.05)",  badge: "rgba(34,197,94,0.10)",  badgeText: "#166534", border: "rgba(34,197,94,0.18)" },
};

function EdgeCasesBlock({ edgeCases, compact = false }: { edgeCases: EdgeCase[]; compact?: boolean }) {
  const allEdges  = edgeCases;
  edgeCases = compact ? edgeCases.filter((e) => e.risk === "high") : edgeCases;
  const hiddenN   = allEdges.length - edgeCases.length;
  const highCount = edgeCases.filter((e) => e.risk === "high").length;
  const midCount  = edgeCases.filter((e) => e.risk === "mid").length;
  const lowCount  = edgeCases.filter((e) => e.risk === "low").length;

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>

      {/* ── Header ── */}
      <div className="flex items-center gap-2.5 px-5 py-3.5 flex-wrap" style={{ borderBottom: "1px solid hsl(var(--border))" }}>
        <Chip color="amber">邊界條件</Chip>
        <span style={{ fontSize: 11, color: "hsl(var(--muted-foreground))" }}>可能出錯的情境與風險，QA 測試重點</span>
        <div className="flex items-center gap-1.5">
          {highCount > 0 && (
            <span className="rounded-full px-2 py-[2px] font-semibold" style={{ fontSize: 10, background: "rgba(239,68,68,0.10)", color: "#b91c1c" }}>
              高 {highCount}
            </span>
          )}
          {midCount > 0 && (
            <span className="rounded-full px-2 py-[2px] font-semibold" style={{ fontSize: 10, background: "rgba(245,158,11,0.10)", color: "#92400e" }}>
              中 {midCount}
            </span>
          )}
          {lowCount > 0 && (
            <span className="rounded-full px-2 py-[2px] font-semibold" style={{ fontSize: 10, background: "rgba(34,197,94,0.10)", color: "#166534" }}>
              低 {lowCount}
            </span>
          )}
          {compact && hiddenN > 0 && (
            <span className="text-[10.5px]" style={{ color: "#86868b" }}>（精簡：略過 {hiddenN} 條低/中風險）</span>
          )}
        </div>
      </div>

      {/* ── Cases ── */}
      <div className="px-4 py-3 flex flex-col gap-2.5">
        {edgeCases.map((ec, idx) => {
          const cfg = RISK_CFG[ec.risk] ?? RISK_CFG.low;
          return (
            <div key={idx} className="rounded-xl overflow-hidden flex" style={{ border: `1px solid ${cfg.border}`, background: cfg.bg }}>
              {/* accent bar */}
              <div className="shrink-0 w-1" style={{ background: cfg.bar }} />

              <div className="flex-1 px-3.5 py-2.5 space-y-1.5">
                {/* title row */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold" style={{ fontSize: 13, color: "hsl(var(--foreground))" }}>
                    {ec.title}
                  </span>
                  <span className="rounded-md px-1.5 py-[2px] font-semibold uppercase tracking-wide"
                    style={{ fontSize: 9, background: cfg.badge, color: cfg.badgeText, letterSpacing: "0.06em" }}>
                    {cfg.label}
                  </span>
                </div>

                {/* description */}
                {ec.description && (
                  <p style={{ fontSize: 12.5, color: "hsl(var(--foreground) / 0.75)", lineHeight: 1.6 }}>
                    {ec.description}
                  </p>
                )}

                {/* trigger condition */}
                {ec.trigger_condition && (
                  <div className="flex items-start gap-1.5 rounded-lg px-2.5 py-1.5"
                    style={{ background: "rgba(255,255,255,0.55)", border: "1px solid rgba(255,255,255,0.8)" }}>
                    <span style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }}>⚡</span>
                    <p style={{ fontSize: 11.5, color: "hsl(var(--foreground) / 0.65)", lineHeight: 1.5 }}>
                      <span style={{ fontWeight: 600 }}>觸發條件：</span>{ec.trigger_condition}
                    </p>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Validation card
───────────────────────────────────────────────────────────────────────────── */

// Backend sends validation issues as objects: {severity, location, description, fix}
// The component accepts both shapes for robustness.
type ValidationIssueRaw = string | { severity?: string; location?: string; description?: string; fix?: string };

function validationIssueSeverity(issue: ValidationIssueRaw): string {
  if (typeof issue === "string") return "warning";
  return issue.severity || "warning";
}

const SEV_CONFIG: Record<string, { label: string; bg: string; color: string; border: string; bar: string }> = {
  critical: { label: "嚴重", bg: "rgba(239,68,68,0.07)",  color: "#b91c1c", border: "rgba(239,68,68,0.20)", bar: "#ef4444" },
  warning:  { label: "警告", bg: "rgba(245,158,11,0.07)", color: "#92400e", border: "rgba(245,158,11,0.22)", bar: "#f59e0b" },
  info:     { label: "資訊", bg: "rgba(59,130,246,0.07)", color: "#1d4ed8", border: "rgba(59,130,246,0.20)", bar: "#3b82f6" },
};

// Human label + readable text for a validation issue (severity vocab is broader than SEV_CONFIG).
const SEV_LABEL: Record<string, string> = {
  critical: "嚴重", high: "高", major: "主要", warning: "警告", minor: "次要", info: "資訊",
};
function issueText(i: ValidationIssueRaw): string {
  if (typeof i === "string") return i;
  return [i.location, i.description].filter(Boolean).join("：") || "（未描述）";
}
function sevLabelOf(i: ValidationIssueRaw): string {
  const s = validationIssueSeverity(i).toLowerCase();
  return SEV_LABEL[s] || s;
}
function isCritical(i: ValidationIssueRaw): boolean {
  return /^crit|^high/i.test(validationIssueSeverity(i));
}

/* ── Iteration delta — explains why the quality score moved after an optimize ── */
function IterationDeltaBlock({ delta }: { delta: IssueDelta }) {
  const resolved   = (delta.resolved ?? []) as ValidationIssueRaw[];
  const introduced = (delta.introduced ?? []) as ValidationIssueRaw[];
  const chg = delta.score_change;
  if (!resolved.length && !introduced.length && (chg == null || chg === 0)) return null;

  const critN = introduced.filter(isCritical).length;
  const up    = (chg ?? 0) > 0;
  const flat  = chg == null || chg === 0;
  const chgColor = up ? "#16a34a" : flat ? "#6e7882" : "#d97706";

  const Col = ({ title, color, items, withSev }: { title: string; color: string; items: ValidationIssueRaw[]; withSev?: boolean }) => (
    <div>
      <div className="text-[12px] font-bold mb-1.5" style={{ color }}>{title}</div>
      {items.length ? (
        <ul className="space-y-1">
          {items.map((it, k) => (
            <li key={k} className="text-[11.5px] leading-snug" style={{ color: "#3a3a3c" }}>
              {withSev && <b style={{ color: isCritical(it) ? "#b91c1c" : "#92400e" }}>[{sevLabelOf(it)}] </b>}
              {issueText(it)}
            </li>
          ))}
        </ul>
      ) : <p className="text-[11px]" style={{ color: "#86868b" }}>—</p>}
    </div>
  );

  return (
    <div className="rounded-2xl overflow-hidden scroll-mt-4"
      style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
      <div className="flex items-center gap-2.5 px-5 py-3.5 flex-wrap" style={{ borderBottom: "1px solid hsl(var(--border))" }}>
        <span style={{ width: 4, height: 14, borderRadius: 2, background: "var(--ns-violet)", flexShrink: 0 }} />
        <span className="font-semibold tracking-tight" style={{ fontSize: 13.5, color: "hsl(var(--foreground))" }}>本次優化變更</span>
        {chg != null && (
          <span className="font-bold tabular-nums" style={{ fontFamily: "var(--font-grotesk)", fontSize: 13, color: chgColor }}>
            {delta.prev_score ?? "—"} → {delta.score}{!flat && <> ({up ? "▲" : "▼"}{Math.abs(chg)})</>}
          </span>
        )}
      </div>
      <div className="px-5 py-3.5 grid gap-4 sm:grid-cols-2">
        <Col title={`✅ 已解決 ${resolved.length}`} color="#16a34a" items={resolved} />
        <Col title={`⚠️ 新出現 ${introduced.length}${critN ? `（含 ${critN} 嚴重）` : ""}`} color={introduced.length ? "#d97706" : "#86868b"} items={introduced} withSev />
      </div>
      {introduced.length > 0 && (chg ?? 0) <= 0 && (
        <div className="px-5 pb-3.5 -mt-1">
          <p className="text-[11px] leading-snug" style={{ color: "#92400e" }}>
            分數每一版都<strong>重新評分</strong>：這次在補強的同時新增了上述問題（嚴重度高的扣分多），所以分數未必上升。可再針對「新出現」項目優化。
          </p>
        </div>
      )}
    </div>
  );
}

function ValidationBlock({ issues, summary, selected, onToggle, onOptimize }: {
  issues: ValidationIssueRaw[]; summary: string;
  selected?: Set<number>; onToggle?: (i: number) => void; onOptimize?: () => void;
}) {
  if (!issues.length) return null;
  const selCount = selected?.size ?? 0;

  const counts = { critical: 0, warning: 0, info: 0 };
  issues.forEach(i => {
    const s = validationIssueSeverity(i) as keyof typeof counts;
    if (s in counts) counts[s]++;
  });

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: "hsl(var(--card))", border: "1px solid rgba(245,158,11,0.28)", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>

      {/* ── Header ── */}
      <div className="flex items-center gap-2.5 px-5 py-3.5" style={{ borderBottom: "1px solid rgba(245,158,11,0.18)" }}>
        <AlertTriangle style={{ width: 15, height: 15, color: "#d97706", flexShrink: 0 }} strokeWidth={2} />
        <span style={{ fontSize: 13, fontWeight: 600, color: "#92400e" }}>驗證問題</span>
        {/* severity breakdown chips */}
        <div className="flex items-center gap-1.5 ml-1">
          {counts.critical > 0 && (
            <span className="rounded-full px-2 py-[2px] font-semibold" style={{ fontSize: 10, background: "rgba(239,68,68,0.10)", color: "#b91c1c" }}>
              嚴重 {counts.critical}
            </span>
          )}
          {counts.warning > 0 && (
            <span className="rounded-full px-2 py-[2px] font-semibold" style={{ fontSize: 10, background: "rgba(245,158,11,0.12)", color: "#92400e" }}>
              警告 {counts.warning}
            </span>
          )}
          {counts.info > 0 && (
            <span className="rounded-full px-2 py-[2px] font-semibold" style={{ fontSize: 10, background: "rgba(59,130,246,0.10)", color: "#1d4ed8" }}>
              資訊 {counts.info}
            </span>
          )}
        </div>
      </div>

      {/* ── What this block is for ── */}
      <div className="px-5 pt-2.5 pb-0.5">
        <p style={{ fontSize: 11, color: "#92400e", lineHeight: 1.55 }}>
          這些是品質校驗找出、<strong>可再優化</strong>的點。{onToggle
            ? <>點下方項目可<strong>勾選</strong>，再按按鈕只針對選取的問題優化；不勾則一次修全部。</>
            : <>在上方輸入優化方向後按「優化」即可改善；留空白則自動針對下列問題修正。</>}
        </p>
      </div>

      {/* Optimize action — always visible & colocated with the checkboxes (label adapts) */}
      {onOptimize && (
        <div className="px-5 pt-1.5 pb-2 flex items-center gap-2 flex-wrap">
          <button type="button" onClick={onOptimize}
            className="inline-flex items-center gap-1.5 rounded-lg font-semibold transition-opacity hover:opacity-90"
            style={{ height: 30, padding: "0 12px", fontSize: 12.5, background: "var(--ns-accent)", color: "var(--ns-ink)", fontWeight: 800, boxShadow: "0 8px 20px -10px rgba(166,220,27,.6)" }}>
            <RotateCcw style={{ width: 12, height: 12 }} strokeWidth={2.4} />
            {selCount > 0 ? `針對選取的 ${selCount} 項優化` : "一次修正全部問題"}
          </button>
          {selCount > 0 && (
            <span style={{ fontSize: 11, color: "#92400e" }}>已選 {selCount} 項（藍框）</span>
          )}
        </div>
      )}

      {/* ── Summary ── */}
      {summary && (
        <div className="px-5 pt-2 pb-1">
          <p style={{ fontSize: 12, color: "hsl(var(--muted-foreground))", lineHeight: 1.65 }}>{summary}</p>
        </div>
      )}

      {/* ── Issue list ── */}
      <div className="px-4 py-3 flex flex-col gap-2.5">
        {issues.map((issue, idx) => {
          const sev  = validationIssueSeverity(issue);
          const cfg  = SEV_CONFIG[sev] ?? SEV_CONFIG.warning;
          const desc = typeof issue === "string" ? issue : (issue.description || "");
          const fix  = typeof issue !== "string" ? issue.fix : undefined;
          const loc  = typeof issue !== "string" ? issue.location : undefined;
          const isSel = !!selected?.has(idx);

          return (
            <div key={idx}
              onClick={onToggle ? () => onToggle(idx) : undefined}
              className="rounded-xl overflow-hidden flex"
              style={{ border: `1px solid ${isSel ? cfg.bar : cfg.border}`, background: cfg.bg,
                       cursor: onToggle ? "pointer" : "default",
                       boxShadow: isSel ? `0 0 0 1px ${cfg.bar}` : "none" }}>
              {/* left accent bar */}
              <div className="shrink-0 w-1 rounded-l-xl" style={{ background: cfg.bar }} />

              <div className="flex-1 px-3.5 py-2.5 space-y-1.5">
                {/* top row: checkbox (if selectable) + severity badge + location */}
                <div className="flex items-center gap-2 flex-wrap">
                  {onToggle && (
                    <span className="inline-flex items-center justify-center shrink-0"
                      style={{ width: 14, height: 14, borderRadius: 4,
                               border: `1.5px solid ${isSel ? cfg.bar : "hsl(var(--border))"}`,
                               background: isSel ? cfg.bar : "transparent" }}>
                      {isSel && <span style={{ fontSize: 9, color: "#fff", fontWeight: 700 }}>✓</span>}
                    </span>
                  )}
                  <span className="rounded-md px-1.5 py-[2px] font-semibold tracking-wide uppercase"
                    style={{ fontSize: 9, background: cfg.bar, color: "#fff", letterSpacing: "0.06em" }}>
                    {cfg.label}
                  </span>
                  {loc && (
                    <span className="font-mono rounded px-1.5 py-[1px]"
                      style={{ fontSize: 10, background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))", border: "1px solid hsl(var(--border))" }}>
                      {loc}
                    </span>
                  )}
                </div>

                {/* description */}
                {desc && (
                  <p style={{ fontSize: 12.5, color: "hsl(var(--foreground))", lineHeight: 1.6, fontWeight: 450 }}>
                    {desc}
                  </p>
                )}

                {/* fix suggestion */}
                {fix && (
                  <div className="flex items-start gap-1.5 rounded-lg px-2.5 py-2 mt-0.5"
                    style={{ background: "rgba(255,255,255,0.55)", border: "1px solid rgba(255,255,255,0.8)" }}>
                    <span style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }}>💡</span>
                    <p style={{ fontSize: 11.5, color: "hsl(var(--foreground) / 0.75)", lineHeight: 1.55 }}>
                      <span style={{ fontWeight: 600 }}>建議：</span>{fix}
                    </p>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Citations sidebar block
───────────────────────────────────────────────────────────────────────────── */

function CitationsBlock({ citations }: { citations: Citation[] }) {
  if (!citations.length) return null;

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
      <div className="flex items-center gap-2.5 px-5 py-3.5 flex-wrap" style={{ borderBottom: "1px solid hsl(var(--border))" }}>
        <Chip color="blue">引用來源</Chip>
        <span style={{ fontSize: 11, color: "hsl(var(--muted-foreground))" }}>規格參考的社群資料連結</span>
      </div>

      <div className="px-3 py-2.5 flex flex-col gap-0.5">
        {citations.map((c, idx) => (
          <a
            key={idx}
            href={c.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-start gap-2.5 rounded-lg px-2 py-2 transition-colors"
            style={{ textDecoration: "none" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "hsl(var(--muted) / 0.6)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            {/* favicon-style icon */}
            <span
              className="shrink-0 flex items-center justify-center rounded-md mt-[1px]"
              style={{
                width: 22,
                height: 22,
                background: "hsl(var(--muted))",
                border: "1px solid hsl(var(--border))",
              }}
            >
              <CitationIcon source={c.source} />
            </span>

            <div className="flex-1 min-w-0">
              <p className="leading-snug line-clamp-2"
                style={{ fontSize: 12, color: "hsl(var(--foreground) / 0.85)" }}>
                {c.title}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <p className="truncate"
                  style={{ fontSize: 10, color: "hsl(var(--muted-foreground))" }}>
                  {(() => { try { return new URL(c.url).hostname; } catch { return c.url; } })()}
                </p>
                {c.source === "github" && c.stars != null && (
                  <span className="shrink-0 flex items-center gap-0.5 rounded px-1 py-px"
                    style={{ fontSize: 9.5, background: "rgba(36,41,47,0.07)", color: "#24292f", fontWeight: 600 }}>
                    ⭐ {c.stars >= 1000 ? `${(c.stars / 1000).toFixed(1)}k` : c.stars}
                  </span>
                )}
              </div>
            </div>

            <ExternalLink
              style={{ width: 11, height: 11, color: "hsl(var(--muted-foreground) / 0.5)", flexShrink: 0, marginTop: 3 }}
              strokeWidth={1.8}
            />
          </a>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Disaster patterns sidebar block
───────────────────────────────────────────────────────────────────────────── */

// Source badge colors per platform
const SOURCE_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  github: { bg: "#24292f", color: "#fff",    label: "GitHub" },
  reddit: { bg: "#ff4500", color: "#fff",    label: "Reddit" },
  hn:     { bg: "#ff6600", color: "#fff",    label: "HN" },
};

function DisasterPatternsBlock({ patterns }: { patterns: (DisasterPattern & { source_urls?: { source: string; title: string; url: string }[] })[] }) {
  if (!patterns.length) return null;

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>

      {/* Header — consistent with the other section cards */}
      <div className="flex items-center gap-2.5 px-5 py-3.5" style={{ borderBottom: "1px solid hsl(var(--border))" }}>
        <Chip color="amber">社群災情</Chip>
        <span style={{ fontSize: 11, color: "hsl(var(--muted-foreground))" }}>社群真實踩過的雷，點來源可追溯原文</span>
      </div>

      <div className="px-4 py-3 flex flex-col gap-2.5">
        {patterns.map((p, idx) => {
          // frequency_percent removed (A10): show the real scraped pattern + source links only.
          const sourceUrls = (p as any).source_urls as { source: string; title: string; url: string }[] | undefined;
          const seen = new Set<string>();
          const unique = (sourceUrls || []).filter(s => {
            if (!s.url || seen.has(s.source)) return false;
            seen.add(s.source); return true;
          }).slice(0, 2);

          return (
            <div key={idx} className="rounded-xl overflow-hidden flex"
              style={{ border: "1px solid rgba(245,158,11,0.18)", background: "rgba(245,158,11,0.05)" }}>
              <div className="shrink-0 w-1" style={{ background: "#f59e0b" }} />
              <div className="flex-1 px-3.5 py-2.5 space-y-1.5">
                <span className="font-semibold leading-snug block" style={{ fontSize: 12.5, color: "hsl(var(--foreground))" }}>
                  {p.title}
                </span>
                {p.description && (
                  <p style={{ fontSize: 11.5, color: "hsl(var(--foreground) / 0.7)", lineHeight: 1.55 }}>{p.description}</p>
                )}
                {p.root_cause && (
                  <p style={{ fontSize: 11, color: "hsl(var(--muted-foreground))", lineHeight: 1.5 }}>
                    <span style={{ fontWeight: 600 }}>根因：</span>{p.root_cause}
                  </p>
                )}
                {p.mitigation && (
                  <div className="flex items-start gap-1.5 rounded-lg px-2.5 py-1.5"
                    style={{ background: "rgba(255,255,255,0.55)", border: "1px solid rgba(255,255,255,0.8)" }}>
                    <span style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }}>🛡</span>
                    <p style={{ fontSize: 11, color: "hsl(var(--foreground) / 0.7)", lineHeight: 1.5 }}>
                      <span style={{ fontWeight: 600 }}>緩解：</span>{p.mitigation}
                    </p>
                  </div>
                )}
                {unique.length > 0 && (
                  <div className="flex items-center gap-1.5 pt-0.5">
                    <span style={{ fontSize: 10, color: "hsl(var(--muted-foreground))" }}>來源：</span>
                    {unique.map((src, si) => {
                      const style = SOURCE_STYLE[src.source] || { bg: "#6b7280", color: "#fff", label: src.source.toUpperCase() };
                      return (
                        <a key={si} href={src.url} target="_blank" rel="noopener noreferrer" title={src.title}
                          className="inline-flex items-center gap-1 rounded-md transition-opacity hover:opacity-80"
                          style={{ padding: "2px 6px", background: style.bg, color: style.color, fontSize: 10, fontWeight: 600, textDecoration: "none" }}>
                          {style.label}
                          <ExternalLink style={{ width: 9, height: 9, opacity: 0.8 }} />
                        </a>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Main component
───────────────────────────────────────────────────────────────────────────── */

export function ResultsPanel({ result, currentIteration, onIterate, status, error, rateLimitState }: ResultsPanelProps) {
  const { cachedTranslation, saveTranslation, iterations, generateRoleView, roleViewLoading } = useNetSpec();
  const [activeView, setActiveView] = useState<"pm" | "architect" | "qa">("pm");
  const [feedback, setFeedback] = useState("");
  const [selectedIssues, setSelectedIssues] = useState<Set<number>>(new Set());   // 優化時要針對的驗證問題
  const [lang, setLang] = useState<"zh" | "en">("zh");
  const [compactView, setCompactView] = useState(false);   // 精簡檢視（純前端，不重生）
  const [enSpec,           setEnSpec]           = useState<string | null>(null);
  const [enEdgeCases,      setEnEdgeCases]      = useState<any[] | null>(null);
  const [enValidation,     setEnValidation]     = useState<any[] | null>(null);
  const [enDisaster,       setEnDisaster]       = useState<any[] | null>(null);
  const [isTranslating,    setIsTranslating]    = useState(false);
  // Each translate call gets a version; stale completions are discarded
  const translateVersionRef = useRef(0);

  // ── Sectioned-PRD navigation (TOC + scroll-spy) ──
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const tocRootRef  = useRef<HTMLDivElement>(null);
  const tocIdsRef   = useRef<string[]>([]);
  const [activeSec, setActiveSec] = useState<string>("");

  // Highlight the section nearest the top of the scroll viewport (Radix ScrollArea).
  useEffect(() => {
    if (!result) return;
    const container = tocRootRef.current?.closest("[data-radix-scroll-area-viewport]") as HTMLElement | null;
    if (!container) return;
    const onScroll = () => {
      const cTop = container.getBoundingClientRect().top;
      let cur = tocIdsRef.current[0] ?? "";
      for (const id of tocIdsRef.current) {
        const el = sectionRefs.current[id];
        if (!el) continue;
        if (el.getBoundingClientRect().top - cTop <= 96) cur = id;
      }
      setActiveSec(cur);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => container.removeEventListener("scroll", onScroll);
  }, [result?.spec_document, enSpec, lang, compactView]);

  const jumpToSection = (id: string) => {
    sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSec(id);
  };

  // Restore cached EN translation when loading a history session
  useEffect(() => {
    if (cachedTranslation) {
      if (cachedTranslation.spec_document)     setEnSpec(cachedTranslation.spec_document);
      if (cachedTranslation.edge_cases)        setEnEdgeCases(cachedTranslation.edge_cases);
      if (cachedTranslation.validation_issues) setEnValidation(cachedTranslation.validation_issues);
    }
  }, [cachedTranslation]);

  // Reset EN caches + cancel in-progress translation when result changes
  useEffect(() => {
    translateVersionRef.current++;   // invalidates any in-flight translation
    setIsTranslating(false);
    setLang("zh");
    setSelectedIssues(new Set());    // selection is per-version
    if (!cachedTranslation) {
      setEnSpec(null);
      setEnEdgeCases(null);
      setEnValidation(null);
      setEnDisaster(null);
    }
  }, [result?.spec_document]);

  if (!result) {
    return <EmptyState />;
  }

  const riskLevel   = getRiskLevel(result.edge_cases);
  const score       = result.validation_score;
  const featureTitle =
    result.spec_sections?.feature_name?.trim() ||
    `${result.req_type.toUpperCase()} 功能規格書`;

  // The currently displayed spec document
  const activeSpecDocument = lang === "en" && enSpec ? enSpec : result.spec_document;

  const handleIterate = () => {
    let note = feedback.trim();
    // If the user checked specific validation issues, target those (zh text → the model).
    if (selectedIssues.size > 0) {
      const picked = (result.validation_issues as any[])
        .map((iss, i) => ({ iss, i }))
        .filter((x) => selectedIssues.has(x.i))
        .map((x, n) => {
          const iss: any = x.iss;
          const text = typeof iss === "string" ? iss : [iss.location, iss.description].filter(Boolean).join("：");
          return `${n + 1}. ${text}`;
        });
      const sel = `請優先修正以下驗證問題：\n${picked.join("\n")}`;
      note = note ? `${sel}\n\n另外：${note}` : sel;
    }
    // Which validation issues a user chooses to fix — and how many they ignore —
    // is what tells us whether the validator is pointing at the right things.
    track("iterate_submitted", {
      selected_issue_count: selectedIssues.size,
      total_issue_count: result.validation_issues?.length ?? 0,
      free_text_chars: feedback.trim().length,
      from_iteration: currentIteration,
    });
    onIterate(note || undefined);
    // Don't clear feedback — user may want to iterate again with same direction
  };

  const translateText = async (text: string) => {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec_document: text, target_lang: "en" }),
    });
    return res.ok ? (await res.json()).translated as string : text;
  };

  const handleLangToggle = async (target: "zh" | "en") => {
    if (target === lang) return;
    track("language_toggled", { from: lang, to: target, cached: Boolean(enSpec) });

    if (target === "en") {
      // Already cached → instant switch
      if (enSpec && enEdgeCases && enValidation) { setLang("en"); return; }

      // Stamp this translation call; if result changes mid-flight, we discard
      const myVersion = ++translateVersionRef.current;
      setIsTranslating(true);
      try {
        const [specEn, ecText, valText, disText] = await Promise.all([
          enSpec ? Promise.resolve(enSpec) : translateText(result.spec_document),

          enEdgeCases ? Promise.resolve(null) : (async () => {
            const joined = result.edge_cases
              .map(e => `${e.title}|||${e.description || ""}|||${e.trigger_condition || ""}`)
              .join("\n");
            return translateText(joined);
          })(),

          enValidation ? Promise.resolve(null) : (async () => {
            const joined = result.validation_issues
              .map((i: any) => `${i.description || ""}|||${i.fix || ""}|||${i.location || ""}`)
              .join("\n");
            return translateText(joined);
          })(),

          (enDisaster || !result.disaster_patterns.length) ? Promise.resolve(null) : (async () => {
            const joined = result.disaster_patterns
              .map((d: any) => `${d.title || ""}|||${d.description || ""}|||${d.root_cause || ""}|||${d.mitigation || ""}`)
              .join("\n");
            return translateText(joined);
          })(),
        ]);

        // Discard result if result changed (reset/navigation happened)
        if (translateVersionRef.current !== myVersion) return;

        const finalSpec = enSpec || specEn;
        if (!enSpec) setEnSpec(specEn);

        let finalEdgeCases = enEdgeCases;
        if (!enEdgeCases && ecText) {
          const lines = ecText.split("\n");
          finalEdgeCases = result.edge_cases.map((e, i) => {
            const parts = (lines[i] || "").split("|||");
            return { ...e, title: parts[0]?.trim() || e.title, description: parts[1]?.trim() || e.description, trigger_condition: parts[2]?.trim() || e.trigger_condition };
          });
          setEnEdgeCases(finalEdgeCases);
        }

        let finalValidation = enValidation;
        if (!enValidation && valText) {
          const lines = valText.split("\n");
          finalValidation = result.validation_issues.map((i: any, idx: number) => {
            const parts = (lines[idx] || "").split("|||");
            return { ...i, description: parts[0]?.trim() || i.description, fix: parts[1]?.trim() || i.fix, location: parts[2]?.trim() || i.location };
          });
          setEnValidation(finalValidation);
        }

        if (!enDisaster && disText) {
          const lines = disText.split("\n");
          const finalDisaster = result.disaster_patterns.map((d: any, idx: number) => {
            const parts = (lines[idx] || "").split("|||");
            // keep source_urls (links) untouched — only the prose fields are translated
            return { ...d, title: parts[0]?.trim() || d.title, description: parts[1]?.trim() || d.description,
                     root_cause: parts[2]?.trim() || d.root_cause, mitigation: parts[3]?.trim() || d.mitigation };
          });
          setEnDisaster(finalDisaster);
        }

        saveTranslation({
          spec_document: finalSpec,
          edge_cases: finalEdgeCases ?? undefined,
          validation_issues: finalValidation ?? undefined,
        }).catch(() => null);

        setLang("en");
      } finally {
        // Only clear spinner if this is still the active translation
        if (translateVersionRef.current === myVersion) setIsTranslating(false);
      }
    } else {
      setLang("zh");
    }
  };

  // ── Build the sectioned reading plan ──
  // PM view = full PRD (folds §4/§5 into rich cards + validation/citations).
  // Role views (architect/qa) = pure markdown sections derived from the confirmed PM spec.
  const roleKey  = activeView === "pm" ? null : activeView;
  const roleView = roleKey ? result.role_views?.[roleKey] : null;
  const activeDoc = activeView === "pm" ? activeSpecDocument : (roleView?.document ?? "");
  const isPM = activeView === "pm";

  const { preamble, sections } = splitPrdSections(activeDoc);
  const edgeData     = lang === "en" && enEdgeCases?.length ? enEdgeCases : result.edge_cases;
  const valData      = lang === "en" && enValidation?.length ? enValidation : result.validation_issues;
  const disasterData = lang === "en" && enDisaster?.length ? enDisaster : result.disaster_patterns;
  // Structured-data-driven inclusion: a section appears iff its structured data exists.
  const edgeN       = isPM ? edgeData.length : 0;
  const disasterN   = isPM && !compactView ? result.disaster_patterns.length : 0;
  const validationN = isPM && !compactView ? valData.length : 0;
  const citationsN  = isPM && !compactView ? result.citations.length : 0;

  type PrdItem =
    | { kind: "md"; sec: PrdSection; id: string; label: string }
    | { kind: "edges" | "disaster" | "validation" | "citations"; id: string; label: string };
  const CARD = {
    edges:      { id: "prd-sec-edges",      label: "邊界條件" },
    disaster:   { id: "prd-sec-disaster",   label: "社群災情" },
    validation: { id: "prd-sec-validation", label: "驗證問題" },
    citations:  { id: "prd-sec-citations",  label: "引用來源" },
  } as const;
  const mdItem = (s: PrdSection): PrdItem => ({ kind: "md", sec: s, id: s.id, label: s.label });

  const items: PrdItem[] = [];
  let edgesPlaced = false, disasterPlaced = false;
  for (const s of sections) {
    if (isPM) {
      const role = sectionRole(s.label);
      if (role === "edges") {
        // structured edges → rich card; empty structured data → keep markdown body (never drop)
        if (edgeN > 0) { items.push({ kind: "edges", ...CARD.edges }); edgesPlaced = true; }
        else { items.push(mdItem(s)); }
        continue;
      }
      if (role === "disaster") {
        if (disasterN > 0) { items.push({ kind: "disaster", ...CARD.disaster }); disasterPlaced = true; }
        else if (!compactView && result.disaster_patterns.length === 0) { items.push(mdItem(s)); }
        // (精簡檢視 intentionally drops the 社群 section)
        continue;
      }
      if (compactView && role !== "normal") continue;   // 精簡：摺疊開放問題等
    }
    items.push(mdItem(s));
  }
  if (isPM) {
    // disaster data exists but markdown lacked §社群 → insert at canonical position (after 邊界)
    if (disasterN > 0 && !disasterPlaced) {
      const ei = items.findIndex((x) => x.kind === "edges");
      items.splice(ei >= 0 ? ei + 1 : items.length, 0, { kind: "disaster", ...CARD.disaster });
    }
    if (edgeN > 0 && !edgesPlaced) {
      const di = items.findIndex((x) => x.kind === "disaster");
      items.splice(di >= 0 ? di : items.length, 0, { kind: "edges", ...CARD.edges });
    }
    if (validationN > 0) items.push({ kind: "validation", ...CARD.validation });
    if (citationsN > 0) items.push({ kind: "citations", ...CARD.citations });
  }
  // Contiguous numbering lives ONLY in the side TOC → no number gaps in the document.
  const tocItems = items.map((it, i) => ({ id: it.id, label: `${i + 1}. ${it.label}` }));
  tocIdsRef.current = tocItems.map((t) => t.id);
  const setRef = (id: string) => (el: HTMLElement | null) => { sectionRefs.current[id] = el; };

  return (
    <div className="flex flex-col gap-4 w-full min-h-0">

        {/* ── HEADER ROW ─────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-2">
          {/* top line */}
          <div className="flex items-center gap-2.5 flex-wrap">

            {/* feature title */}
            <span
              className="font-semibold tracking-tight"
              style={{ fontSize: 19, color: "hsl(var(--foreground))", letterSpacing: "-0.025em" }}
            >
              {featureTitle}
            </span>

            {/* risk badge */}
            <span
              className="inline-flex items-center font-semibold rounded-full px-2.5 py-[3px] uppercase"
              style={{ fontSize: 10, letterSpacing: "0.06em", ...riskBadgeStyle(riskLevel) }}
            >
              {riskLevel}
            </span>

            {/* version badge */}
            <span
              className="inline-flex items-center font-mono rounded-full px-2.5 py-[3px]"
              style={{
                fontSize: 11,
                letterSpacing: "0.02em",
                background: "hsl(var(--muted))",
                color: "hsl(var(--muted-foreground))",
                border: "1px solid hsl(var(--border))",
              }}
            >
              v{currentIteration}
            </span>

            {/* Language toggle — instant switch (EN cached after first translation) */}
            <div className="inline-flex items-center rounded-full overflow-hidden shrink-0"
              style={{ border: "1px solid hsl(var(--border))", fontSize: 11 }}>
              <button
                type="button"
                onClick={() => handleLangToggle("zh")}
                className="px-2.5 py-[3px] font-medium transition-colors"
                style={{
                  background: lang === "zh" ? "#6B5CF0" : "transparent",
                  color: lang === "zh" ? "#fff" : "hsl(var(--muted-foreground))",
                }}
                title="繁體中文"
              >
                中
              </button>
              <button
                type="button"
                onClick={() => handleLangToggle("en")}
                disabled={isTranslating}
                className="px-2.5 py-[3px] font-medium transition-colors flex items-center gap-1"
                style={{
                  background: lang === "en" ? "#6B5CF0" : "transparent",
                  color: lang === "en" ? "#fff" : "hsl(var(--muted-foreground))",
                }}
                title={isTranslating ? "翻譯中，可繼續瀏覽中文內容…" : enSpec ? "English（已快取，即時切換）" : cachedTranslation ? "English（已快取，點擊載入）" : "English（點擊翻譯，約 30-60 秒）"}
              >
                {isTranslating && (
                  <span className="w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin inline-block" style={{ opacity: 0.7 }} />
                )}
                EN
              </button>
            </div>

            {/* 精簡檢視 toggle（純前端：摺疊邊界/社群/開放問題，方便快速閱讀與交付） */}
            <button
              type="button"
              onClick={() => { track("compact_view_toggled", { enabled: !compactView }); setCompactView(v => !v); }}
              className="rounded-lg px-2.5 py-[5px] text-[11.5px] font-medium transition-all"
              style={compactView
                ? { background: "rgba(107,92,240,0.1)", color: "#6B5CF0", border: "1px solid rgba(107,92,240,0.25)" }
                : { background: "transparent", color: "hsl(var(--muted-foreground))", border: "1px solid hsl(var(--border))" }}
              title="精簡檢視：只看核心需求，摺疊邊界明細／社群情報／開放問題（不影響已生成內容）"
            >
              {compactView ? "✓ 精簡檢視" : "精簡檢視"}
            </button>

            {/* Print / export full spec */}
            <button
              type="button"
              onClick={() => {
                track("spec_printed", { view: activeView, iteration: currentIteration, lang, chars: activeDoc.length });
                printSpec(activeDoc, featureTitle, result.req_type);
              }}
              title="列印 / 匯出 PDF（目前檢視的文件）"
              className="rounded-lg px-2.5 py-[5px] text-[11.5px] font-medium transition-colors hover:bg-black/[0.05]"
              style={{ color: "hsl(var(--muted-foreground))", border: "1px solid hsl(var(--border))" }}
            >
              🖨 列印
            </button>

            {/* Export Markdown (current view) — next to 列印 */}
            <button
              type="button"
              onClick={() => {
                track("spec_exported", {
                  format: "md", view: activeView, iteration: currentIteration,
                  lang, chars: activeDoc.length,
                });
                const blob = new Blob([activeDoc], { type: "text/markdown;charset=utf-8" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `${featureTitle}_${activeView === "pm" ? "PM" : activeView}_v${currentIteration}.md`;
                a.click();
                URL.revokeObjectURL(a.href);
              }}
              title="匯出 Markdown（目前檢視的文件）"
              className="rounded-lg px-2.5 py-[5px] text-[11.5px] font-medium transition-colors hover:bg-black/[0.05]"
              style={{ color: "hsl(var(--muted-foreground))", border: "1px solid hsl(var(--border))" }}
            >
              ⬇ 匯出 MD
            </button>

            {/* quality score with tooltip */}
            <span
              className="ml-auto font-semibold tabular-nums cursor-help"
              style={{ fontSize: 13, color: scoreColor(score) }}
              title={`品質分數 ${score}/100\n\n計算方式：\n• 需求完整性：需求條目有無可測量的驗收標準\n• SLA 合理性：效能指標在此協定下是否可達\n• 邊界條件覆蓋：HIGH 風險情境是否有對應需求\n• 邏輯一致性：需求之間有無矛盾\n\n85+ 優秀 · 70–84 良好 · 50–69 需改進 · <50 需優化`}
            >
              品質 {score}
              <span style={{ fontSize: 10, marginLeft: 3, opacity: 0.5 }}>ⓘ</span>
            </span>
          </div>

          {/* iteration row — PM view only (優化 only applies to the PM spec) */}
          {isPM && (() => {
            const maxIter = iterations.length > 0 ? Math.max(...iterations.map(i => i.iteration)) : currentIteration;
            const isOldVersion = currentIteration > 0 && currentIteration < maxIter;
            return (
              <div className="flex flex-col gap-1.5">
                {/* "based on v?" indicator when viewing older version */}
                {isOldVersion && (
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg"
                    style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)" }}>
                    <span style={{ fontSize: 11 }}>⚠️</span>
                    <span style={{ fontSize: 11, color: "#92400e", lineHeight: 1.4 }}>
                      目前查看 v{currentIteration}，優化將以 <strong>v{currentIteration}</strong> 為基礎（而非最新 v{maxIter}）
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder={selectedIssues.size > 0 ? "補充方向（選填，將與選取的問題一起修）" : "優化方向（選填，空白則自動修正驗證問題）"}
                    onKeyDown={(e) => { if (e.key === "Enter") handleIterate(); }}
                    className="flex-1 rounded-lg px-3 text-[13px] leading-none outline-none transition-shadow"
                    style={{ height: 32, background: "hsl(var(--muted))", border: "1px solid hsl(var(--border))",
                             color: "hsl(var(--foreground))", maxWidth: 320 }}
                  />
                  <button
                    onClick={handleIterate}
                    title={selectedIssues.size > 0 ? `基於 v${currentIteration}、針對選取的 ${selectedIssues.size} 個問題優化` : `基於 v${currentIteration} 優化迭代`}
                    className="inline-flex items-center gap-1.5 rounded-lg font-medium transition-opacity hover:opacity-80 active:opacity-70 shrink-0"
                    style={{ height: 32, padding: "0 12px", fontSize: 13, background: "var(--ns-accent)",
                             color: "var(--ns-ink)", border: "none", cursor: "pointer", fontWeight: 800,
                             boxShadow: "0 10px 24px -12px rgba(166,220,27,.6)" }}
                  >
                    <RotateCcw style={{ width: 13, height: 13 }} strokeWidth={2.2} />
                    {selectedIssues.size > 0 ? `優化 v${currentIteration}（${selectedIssues.size} 項）` : `優化 v${currentIteration}`}
                  </button>
                </div>
                {selectedIssues.size > 0 && (
                  <span className="text-[11px]" style={{ color: "#92400e" }}>
                    已選 {selectedIssues.size} 個驗證問題（下方藍框）· <button type="button" onClick={() => setSelectedIssues(new Set())} className="underline" style={{ color: "#6B5CF0" }}>清除</button>
                  </span>
                )}
              </div>
            );
          })()}
        </div>

        {/* ── Translation progress banner ─────────────────────────────────── */}
        {isTranslating && (
          <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl"
            style={{ background: "rgba(107,92,240,0.07)", border: "1px solid rgba(107,92,240,0.18)" }}>
            <div className="w-3.5 h-3.5 rounded-full border-2 border-[#6B5CF0] border-t-transparent animate-spin shrink-0" />
            <span style={{ fontSize: 12.5, color: "#6B5CF0", fontWeight: 500 }}>
              正在翻譯英文版本，約需 30–60 秒，完成後自動切換…
            </span>
            <span style={{ fontSize: 11.5, color: "#6B5CF0", opacity: 0.6, marginLeft: "auto" }}>
              可繼續閱讀中文內容
            </span>
          </div>
        )}

        {/* ── (A4) Optimize/iteration error banner ───────────────────────────── */}
        {status === "error" && (error || rateLimitState) && (
          <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl"
            style={rateLimitState
              ? { background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)" }
              : { background: "rgba(239,68,68,0.07)", border: "1px solid rgba(239,68,68,0.22)" }}>
            <span className="shrink-0 text-[15px] mt-px">{rateLimitState ? "⏳" : "⚠️"}</span>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold" style={{ color: rateLimitState ? "#b45309" : "#b91c1c" }}>
                {rateLimitState?.type === "daily" ? "今日優化次數已達上限"
                  : rateLimitState?.type === "rate" ? "請求太頻繁，請稍候再優化"
                  : "優化失敗"}
              </p>
              <p className="text-[12px] mt-0.5 leading-snug" style={{ color: "#6e6e73" }}>
                {rateLimitState?.message || error}
                {rateLimitState?.type === "rate" && rateLimitState.retryAfter ? `（約 ${rateLimitState.retryAfter} 秒後可重試）` : ""}
                {rateLimitState?.type === "daily" && rateLimitState.limit ? `（${rateLimitState.used ?? "?"}/${rateLimitState.limit}）` : ""}
              </p>
              <p className="text-[11.5px] mt-1" style={{ color: "#86868b" }}>目前仍顯示上一版規格，未受影響。</p>
            </div>
            {!rateLimitState && (
              <button
                onClick={() => onIterate(feedback.trim() || undefined)}
                className="shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all"
                style={{ background: "rgba(107,92,240,0.08)", color: "#6B5CF0", border: "1px solid rgba(107,92,240,0.2)" }}
              >
                重試
              </button>
            )}
          </div>
        )}

      {/* ── View switcher: PM 規格 / 架構師 / QA ── */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <span className="text-[11.5px] font-medium" style={{ color: "#6e6e73" }}>視圖</span>
        <div className="flex p-[3px] rounded-[10px]" style={{ background: "rgba(0,0,0,0.05)" }}>
          {([["pm", "規格 (PM)"], ["architect", "架構師"], ["qa", "QA 測試"]] as const).map(([v, label]) => {
            const generated = v !== "pm" && !!result.role_views?.[v];
            return (
              <button
                key={v}
                type="button"
                onClick={() => {
                  track("role_view_switched", { from: activeView, to: v, already_generated: v === "pm" || generated });
                  setActiveView(v);
                }}
                className="text-[12px] font-medium px-3 py-[5px] rounded-[7px] transition-all select-none inline-flex items-center gap-1.5"
                style={{
                  background: activeView === v ? "#fff" : "transparent",
                  color: activeView === v ? "#6B5CF0" : "#6e6e73",
                  boxShadow: activeView === v ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                }}
              >
                {label}
                {generated && <span style={{ width: 5, height: 5, borderRadius: 9999, background: "#34c759" }} />}
              </button>
            );
          })}
        </div>
        {!isPM && (
          <span className="text-[10.5px]" style={{ color: "#86868b" }}>以 PM 規格 v{currentIteration} 為基礎衍生</span>
        )}
      </div>

      {/* ── Sectioned document + sticky section navigator ── */}
      <div ref={tocRootRef} className="flex gap-5 items-start">

        {/* sticky TOC (hidden in 精簡檢視) */}
        {!compactView && tocItems.length > 0 && (
          <div className="shrink-0 sticky top-2 self-start" style={{ width: 168 }}>
            <PrdToc items={tocItems} activeId={activeSec} onJump={jumpToSection} />
          </div>
        )}

        {/* document column */}
        <div className="flex-1 min-w-0 flex flex-col gap-4">

          {/* role view not yet generated → empty state + generate button */}
          {roleKey && !roleView && (
            <div className="rounded-2xl flex flex-col items-center justify-center text-center gap-3 py-12 px-6"
              style={{ border: "1px dashed hsl(var(--border))", background: "hsl(var(--card))" }}>
              <p className="text-[14px] font-semibold" style={{ color: "hsl(var(--foreground))" }}>
                {roleKey === "architect" ? "架構師視圖" : "QA 測試視圖"}尚未生成
              </p>
              <p className="text-[12px] max-w-[440px] leading-relaxed" style={{ color: "#6e6e73" }}>
                {roleKey === "architect"
                  ? "依目前 PM 規格推導設計決策（ADR）、介面契約與架構級 NFR，並對齊各 REQ。"
                  : "依目前 PM 規格把驗收標準轉成 Given/When/Then 場景、結構化 AC 與測試環境，並連結 REQ / 邊界。"}
              </p>
              <button
                type="button"
                disabled={!!roleViewLoading[roleKey]}
                onClick={() => generateRoleView(roleKey)}
                className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-extrabold transition-opacity"
                style={{ background: "var(--ns-accent)", color: "var(--ns-ink)", opacity: roleViewLoading[roleKey] ? 0.6 : 1, cursor: roleViewLoading[roleKey] ? "default" : "pointer", boxShadow: "0 10px 24px -12px rgba(166,220,27,.6)" }}
              >
                {roleViewLoading[roleKey]
                  ? <><span className="w-3.5 h-3.5 rounded-full border-2 border-[#0F1318] border-t-transparent animate-spin" />生成中…（約 30–60 秒）</>
                  : <>生成{roleKey === "architect" ? "架構師" : "QA"}視圖（以 PM 規格 v{currentIteration} 為基礎）</>}
              </button>
            </div>
          )}

          {/* role view stale (PM iterated since generation) → suggest regenerate */}
          {roleKey && roleView && roleView.based_on_iteration !== currentIteration && (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg"
              style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)" }}>
              <span style={{ fontSize: 11 }}>⚠️</span>
              <span style={{ fontSize: 11, color: "#92400e", lineHeight: 1.4 }}>
                此視圖以 PM 規格 <strong>v{roleView.based_on_iteration}</strong> 生成，PM 已更新至 <strong>v{currentIteration}</strong>，建議重新生成。
              </span>
              <button
                type="button"
                disabled={!!roleViewLoading[roleKey]}
                onClick={() => generateRoleView(roleKey)}
                className="ml-auto shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all"
                style={{ background: "rgba(107,92,240,0.08)", color: "#6B5CF0", border: "1px solid rgba(107,92,240,0.2)" }}
              >
                {roleViewLoading[roleKey] ? "生成中…" : "重新生成"}
              </button>
            </div>
          )}

          {/* Why did the score move? (only on iterated PM versions) */}
          {isPM && !compactView && result.issue_delta && (
            <IterationDeltaBlock delta={result.issue_delta} />
          )}

          {preamble && (
            <div className="px-1 -mb-1">
              <ReactMarkdown components={markdownComponents}>{preamble}</ReactMarkdown>
            </div>
          )}

          {items.map((it) => {
            if (it.kind === "md")
              return (
                <SectionCard key={it.id} id={it.id} title={it.label} hint={sectionHint(it.label)} innerRef={setRef(it.id)}>
                  <ReactMarkdown components={markdownComponents}>{it.sec.body.trim()}</ReactMarkdown>
                </SectionCard>
              );
            if (it.kind === "edges")
              return (
                <section key="edges" id="prd-sec-edges" ref={setRef("prd-sec-edges")} className="scroll-mt-4">
                  <EdgeCasesBlock edgeCases={edgeData} compact={compactView} />
                </section>
              );
            if (it.kind === "disaster")
              return (
                <section key="disaster" id="prd-sec-disaster" ref={setRef("prd-sec-disaster")} className="scroll-mt-4">
                  <DisasterPatternsBlock patterns={disasterData} />
                </section>
              );
            if (it.kind === "validation")
              return (
                <section key="validation" id="prd-sec-validation" ref={setRef("prd-sec-validation")} className="scroll-mt-4">
                  <ValidationBlock issues={valData} summary={result.validation_summary}
                    selected={selectedIssues}
                    onToggle={(i) => setSelectedIssues((prev) => {
                      const n = new Set(prev);
                      n.has(i) ? n.delete(i) : n.add(i);
                      return n;
                    })}
                    onOptimize={handleIterate} />
                </section>
              );
            return (
              <section key="citations" id="prd-sec-citations" ref={setRef("prd-sec-citations")} className="scroll-mt-4">
                <CitationsBlock citations={result.citations} />
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default ResultsPanel;
