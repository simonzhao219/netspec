"use client";

import { useState, useRef, useEffect } from "react";
import { PlanConfirmInterrupt } from "@/lib/types";
import { ArrowRight, SkipForward, Pencil, Check, X } from "lucide-react";

interface ResearchPlanCardProps {
  data: PlanConfirmInterrupt;
  onConfirm: (modifiedKeywords?: string[]) => void;
}

const SOURCE_CFG: Record<string, { label: string; color: string; bg: string; border: string }> = {
  github: { label: "GH",     color: "#24292f", bg: "#f6f8fa",             border: "#d0d7de" },
  hn:     { label: "HN",     color: "#c05621", bg: "rgba(255,102,0,0.07)", border: "rgba(255,102,0,0.25)" },
  reddit: { label: "Reddit", color: "#b44900", bg: "rgba(255,69,0,0.07)",  border: "rgba(255,69,0,0.25)" },
};
const FALLBACK_CFG = { label: "?", color: "#6b7280", bg: "#f9fafb", border: "#e5e7eb" };

const CATEGORY_CFG: Record<string, { label: string; color: string; bg: string }> = {
  known_bug:          { label: "🐛 已知 Bug",    color: "#b91c1c", bg: "rgba(239,68,68,0.08)"  },
  security_cve:       { label: "🔒 CVE 安全",    color: "#7c2d12", bg: "rgba(234,88,12,0.08)"  },
  production_failure: { label: "⚡ 生產故障",    color: "#92400e", bg: "rgba(245,158,11,0.09)" },
  rfc_interop:        { label: "📋 RFC / 互通", color: "#1d4ed8", bg: "rgba(59,130,246,0.08)" },
  performance:        { label: "📊 效能",        color: "#065f46", bg: "rgba(16,185,129,0.08)" },
};

/* ── Inline editable keyword row ── */
function KeywordRow({ query, idx, onChange }: {
  query: { keyword: string; source: string; rationale?: string; category?: string };
  idx: number;
  onChange: (idx: number, val: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(query.keyword);
  const inputRef = useRef<HTMLInputElement>(null);
  const cfg = SOURCE_CFG[query.source] ?? FALLBACK_CFG;

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed) onChange(idx, trimmed);
    else setDraft(query.keyword); // revert if empty
    setEditing(false);
  };

  return (
    <div className="flex items-start gap-2.5 rounded-xl px-3 py-2.5 group transition-colors hover:bg-black/[0.025]"
      style={{ border: "1px solid hsl(var(--border))", background: "hsl(var(--card))" }}>
      {/* Source badge */}
      <span className="shrink-0 mt-[1px] rounded-md px-1.5 py-[2px] font-bold text-[10px] leading-none"
        style={{ color: cfg.color, background: cfg.bg, border: `1px solid ${cfg.border}`, letterSpacing: "0.03em" }}>
        {cfg.label}
      </span>

      <div className="flex-1 min-w-0 space-y-1">
        {/* Category badge */}
        {query.category && CATEGORY_CFG[query.category] && (
          <span className="inline-block rounded-md px-1.5 py-[1px] text-[9.5px] font-semibold"
            style={{ color: CATEGORY_CFG[query.category].color, background: CATEGORY_CFG[query.category].bg, letterSpacing: "0.02em" }}>
            {CATEGORY_CFG[query.category].label}
          </span>
        )}
        {/* Editable keyword */}
        {editing ? (
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(query.keyword); setEditing(false); } }}
              className="flex-1 text-[13px] font-medium border rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-[#6B5CF0]/20 focus:border-[#6B5CF0]"
              style={{ background: "#fff", borderColor: "#6B5CF0", color: "hsl(var(--foreground))", fontFamily: "inherit" }}
            />
            <button type="button" onClick={commit}
              className="shrink-0 p-1 rounded-lg text-emerald-600 hover:bg-emerald-50 transition-colors">
              <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
            </button>
            <button type="button" onClick={() => { setDraft(query.keyword); setEditing(false); }}
              className="shrink-0 p-1 rounded-lg text-rose-500 hover:bg-rose-50 transition-colors">
              <X className="w-3.5 h-3.5" strokeWidth={2.5} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-medium text-foreground/85 flex-1">
              {query.keyword}
            </span>
            <button type="button" onClick={() => setEditing(true)}
              className="shrink-0 opacity-0 group-hover:opacity-100 p-1 rounded-md text-muted-foreground hover:text-[#6B5CF0] hover:bg-[#6B5CF0]/[0.06] transition-all"
              title="編輯關鍵字">
              <Pencil className="w-3 h-3" strokeWidth={2} />
            </button>
          </div>
        )}

        {/* Rationale */}
        {query.rationale && (
          <p className="text-[11px] text-muted-foreground/60 leading-snug">{query.rationale}</p>
        )}
      </div>
    </div>
  );
}

/* ── Main card ── */
export default function ResearchPlanCard({ data, onConfirm }: ResearchPlanCardProps) {
  // Local copy of keywords so edits don't affect parent until confirmed
  const [keywords, setKeywords] = useState<string[]>(
    data.plan.map(q => q.keyword)
  );

  const handleChange = (idx: number, val: string) => {
    setKeywords(prev => prev.map((k, i) => (i === idx ? val : k)));
  };

  const isModified = keywords.some((k, i) => k !== data.plan[i]?.keyword);

  // Source distribution counts
  const sourceCounts = data.plan.reduce((acc, q) => {
    acc[q.source] = (acc[q.source] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="w-full rounded-2xl overflow-hidden"
      style={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>

      {/* ── Header ── */}
      <div className="px-5 py-3.5 flex items-center gap-2.5"
        style={{ borderBottom: "1px solid hsl(var(--border))", background: "rgba(245,158,11,0.04)" }}>
        <span className="flex items-center justify-center w-7 h-7 rounded-lg shrink-0"
          style={{ background: "rgba(245,158,11,0.12)" }}>
          <span style={{ fontSize: 14 }}>🔍</span>
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold tracking-tight" style={{ fontSize: 14, color: "#92400e" }}>
            Agent 研究計畫
          </h2>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            {Object.entries(sourceCounts).map(([src, n]) => {
              const c = SOURCE_CFG[src] ?? FALLBACK_CFG;
              return (
                <span key={src} className="rounded-full px-2 py-[1px] font-semibold"
                  style={{ fontSize: 10, color: c.color, background: c.bg, border: `1px solid ${c.border}` }}>
                  {c.label} ×{n}
                </span>
              );
            })}
            <span className="text-[10px] text-muted-foreground/50">· Hover 關鍵字可編輯</span>
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="px-4 py-4 space-y-4">

        {/* Research summary */}
        {data.research_summary && (
          <div className="px-3 py-2.5 rounded-xl"
            style={{ background: "rgba(245,158,11,0.05)", border: "1px solid rgba(245,158,11,0.15)" }}>
            <p className="text-[11px] font-semibold text-amber-700 uppercase tracking-widest mb-1">研究摘要</p>
            <p className="text-[12.5px] text-amber-900/80 leading-relaxed italic">{data.research_summary}</p>
          </div>
        )}

        {/* Editable keyword rows */}
        <div className="space-y-2">
          <p className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-widest px-1">
            搜尋關鍵字（共 {data.plan.length} 組）
          </p>
          {data.plan.map((query, idx) => (
            <KeywordRow
              key={idx}
              query={{ ...query, keyword: keywords[idx], category: (query as any).category }}
              idx={idx}
              onChange={handleChange}
            />
          ))}
        </div>

        {isModified && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg"
            style={{ background: "rgba(107,92,240,0.06)", border: "1px solid rgba(107,92,240,0.15)" }}>
            <span style={{ fontSize: 11 }}>✏️</span>
            <span style={{ fontSize: 11.5, color: "#6B5CF0" }}>
              已修改 {keywords.filter((k, i) => k !== data.plan[i]?.keyword).length} 個關鍵字，確認後生效
            </span>
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div className="px-4 pb-4 flex flex-col gap-2">
        <button
          onClick={() => onConfirm(isModified ? keywords : undefined)}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-[13px] font-semibold text-white transition-opacity hover:opacity-90 active:opacity-80"
          style={{ background: "#6B5CF0" }}>
          {isModified ? "套用修改並開始搜尋" : "確認，開始搜尋"}
          <ArrowRight className="w-3.5 h-3.5 shrink-0" />
        </button>
        {/* 只在有修改時顯示「還原原計畫」選項 */}
        {isModified && (
          <button
            onClick={() => onConfirm()}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-[12.5px] font-medium transition-colors hover:bg-black/[0.04]"
            style={{ color: "hsl(var(--muted-foreground))", background: "transparent" }}>
            <SkipForward className="w-3.5 h-3.5 shrink-0" />
            捨棄修改，使用 AI 原始計畫
          </button>
        )}
      </div>
    </div>
  );
}
