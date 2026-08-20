"use client";

import { useEffect, useState, useCallback } from "react";
import {
  FileText, Workflow, BookOpen, ScrollText, PenSquare, BookText, Radar,
  Wifi, WifiOff, Trash2, CheckSquare, Square, ChevronRight,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { IterationMeta } from "@/lib/types";

/* ─── types ── */

interface AppSidebarProps {
  currentPanel: "input" | "pipeline" | "results" | "log" | "story" | "monitor";
  onPanelChange: (p: string) => void;
  workflowMode: "text" | "figma";
  onWorkflowModeChange: (mode: "text" | "figma") => void;
  iterations: IterationMeta[];
  currentIteration: number;
  onLoadIteration: (n: number) => void;
  onLoadHistorySession: (sessionId: string) => void;
  onLoadFigmaHistory: (sessionId: string) => void;
  loadedFigmaId: string | null;
  onResetToHome: () => void;
  onGoLanding: () => void;
  loadedHistoryId: string | null;
  stepsCompleted: number;
  status: string;
}

/* ─── static data ── */

const TEXT_NAV_ITEMS = [
  { id: "input",    label: "需求輸入", icon: FileText   },
  { id: "pipeline", label: "執行進度", icon: Workflow   },
  { id: "log",      label: "研究日誌", icon: ScrollText },
  { id: "results",  label: "規格輸出", icon: BookOpen   },
] as const;

const FIGMA_NAV_ITEMS = [
  { id: "input",   label: "URL 輸入", icon: PenSquare },
  { id: "story",   label: "User Story 輸出", icon: BookText  },
  { id: "monitor", label: "Frame 監控", icon: Radar },
] as const;

/* ─── helpers ── */

function scoreColor(score: number) {
  if (score >= 75) return { bar: "#22c55e", text: "#16a34a", bg: "rgba(34,197,94,0.10)" };
  if (score >= 55) return { bar: "#f59e0b", text: "#92400e", bg: "rgba(245,158,11,0.10)" };
  return { bar: "#ef4444", text: "#b91c1c", bg: "rgba(239,68,68,0.10)" };
}

function formatDate(ts: string | number): string {
  try {
    const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
    return d.toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" });
  } catch { return ""; }
}

function formatTime(ts: string | number): string {
  try {
    const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
    return d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

// Date + time with relative "今天 / 昨天" prefix, and year only when not the current year.
function formatStamp(ts: string | number): string {
  try {
    const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
    const now = new Date();
    const hm = d.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString())  return `今天 ${hm}`;
    if (d.toDateString() === yest.toDateString()) return `昨天 ${hm}`;
    const md = d.toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" });
    return d.getFullYear() !== now.getFullYear() ? `${d.getFullYear()}/${md} ${hm}` : `${md} ${hm}`;
  } catch { return ""; }
}

/* ─── ScoreBar ── */

function ScoreBar({ score, width = 44 }: { score: number; width?: number }) {
  const c = scoreColor(score);
  return (
    <div className="flex items-center gap-1.5">
      <div className="rounded-full overflow-hidden" style={{ width, height: 3, background: "hsl(var(--muted))" }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${score}%`, background: c.bar }} />
      </div>
      <span className="font-mono font-semibold tabular-nums"
        style={{ fontSize: 10, color: c.text }}>
        {score}
      </span>
    </div>
  );
}

/* ─── Divider ── */

function Divider() {
  return <div role="separator" className="mx-3 shrink-0" style={{ height: 1, background: "hsl(var(--border) / 0.7)" }} />;
}

/* ─── Logo ── */

function LogoBadge() {
  return (
    <div aria-hidden="true"
      className="flex items-center justify-center rounded-xl font-bold shrink-0 select-none"
      style={{ width: 34, height: 34, fontSize: 13, background: "var(--ns-accent)", color: "var(--ns-ink)",
               fontFamily: "var(--font-grotesk)", letterSpacing: "-0.04em",
               boxShadow: "0 6px 18px -6px rgba(197,242,60,.6)" }}>
      NS
    </div>
  );
}

/* ─── VersionRow — single iteration within current session ── */

function VersionRow({ iter, idx, allIters, isCurrent, onClick, hideScore = false }: {
  iter: IterationMeta;
  idx: number;
  allIters: IterationMeta[];
  isCurrent: boolean;
  onClick: () => void;
  hideScore?: boolean;   // Figma stories have no quality score → show label instead
}) {
  const prev = idx > 0 ? allIters[idx - 1].quality_score : null;
  const trend = prev !== null
    ? iter.quality_score > prev ? "▲" : iter.quality_score < prev ? "▼" : "─"
    : null;
  const trendColor = trend === "▲" ? "var(--ns-accent-deep)" : trend === "▼" ? "var(--ns-amber)" : "#9AA3AD";

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-2 py-[7px] rounded-[9px] text-left transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[#C5F23C]/30"
      style={isCurrent ? { background: "linear-gradient(100deg,rgba(197,242,60,.14),transparent)" } : undefined}
      onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = "#1E252D"; }}
      onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = "transparent"; }}
    >
      {/* Version badge */}
      <span className="shrink-0 grid place-items-center font-mono font-bold text-[11px]"
        style={{ width: 30, height: 22, borderRadius: 7, letterSpacing: "0.02em",
                 fontFamily: "var(--font-grotesk)",
                 background: isCurrent ? "var(--ns-accent)" : "#262E37",
                 color: isCurrent ? "var(--ns-ink)" : "#C4CCD4" }}>
        v{iter.iteration}
      </span>

      {/* Time (date + time, in the version row) */}
      <span className="shrink-0 text-[12px] tabular-nums" style={{ color: "#9AA3AD" }}>
        {formatStamp(iter.timestamp)}
      </span>

      {hideScore ? (
        /* Figma: show optional label note, no score/trend */
        <span className="flex-1 text-right text-[10px] truncate" style={{ color: "#8A929C" }}>
          {iter.feature_name && iter.feature_name !== "故事" ? iter.feature_name : ""}
        </span>
      ) : (
        <>
          <span className="flex-1" />
          {trend && trend !== "─" && (
            <span style={{ fontSize: 9, color: trendColor, lineHeight: 1, flexShrink: 0 }}>{trend}</span>
          )}
          <span className="shrink-0 font-bold tabular-nums text-[14px]"
            style={{ color: "#fff", fontFamily: "var(--font-grotesk)" }}>
            {iter.quality_score}
          </span>
        </>
      )}
    </button>
  );
}

/* ─── CurrentSessionCard ── */

function CurrentSessionCard({ iterations, currentIteration, onLoadIteration }: {
  iterations: IterationMeta[];
  currentIteration: number;
  onLoadIteration: (n: number) => void;
}) {
  if (iterations.length === 0) return null;

  const latest = iterations[iterations.length - 1];
  const title = latest.feature_name?.trim() || "規格書";
  const bestScore = Math.max(...iterations.map(i => i.quality_score));
  const verCount = iterations.length;

  return (
    <div className="mx-2 mb-1 rounded-[14px] overflow-hidden"
      style={{ border: "1px solid #232A32", background: "var(--ns-ink-2)" }}>
      {/* Card header */}
      <div className="px-3 py-2.5 flex items-start gap-2" style={{ borderBottom: "1px solid #232A32" }}>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-extrabold leading-snug"
            style={{ color: "#fff", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {title}
          </p>
          <div className="flex items-center gap-2 mt-1">
            <ScoreBar score={bestScore} width={40} />
            <span className="text-[9.5px] text-muted-foreground/50">最高分</span>
            <span className="text-[9.5px] text-muted-foreground/40">·</span>
            <span className="text-[9.5px] text-muted-foreground/50">{verCount} 版</span>
          </div>
        </div>
      </div>
      {/* Version rows */}
      <div className="px-1.5 py-1.5 space-y-0.5">
        {iterations.map((iter, idx) => (
          <VersionRow
            key={iter.iteration}
            iter={iter}
            idx={idx}
            allIters={iterations}
            isCurrent={iter.iteration === currentIteration}
            onClick={() => {
              track("version_switched", { to_iteration: iter.iteration, from_iteration: currentIteration });
              onLoadIteration(iter.iteration);
            }}
          />
        ))}
      </div>
    </div>
  );
}

/* ─── HistoryCard ── */

function HistoryCard({ row, isSelected, isManaging, isLoaded, onLoad, onToggle, onDelete }: {
  row: any;
  isSelected: boolean;
  isManaging: boolean;
  isLoaded: boolean;
  onLoad: () => void;
  onToggle: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const title = row.feature_name?.trim() || row.requirement?.substring(0, 20) || "規格書";
  const req   = row.requirement || "";
  const score = row.best_score || 0;
  const c     = scoreColor(score);
  const iterCount = row.iteration_count || 1;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => isManaging ? onToggle() : onLoad()}
      onKeyDown={(e) => e.key === "Enter" && (isManaging ? onToggle() : onLoad())}
      className={cn(
        "group relative mx-2 rounded-xl px-3 py-2.5 cursor-pointer",
        "transition-all duration-150 outline-none",
        "focus-visible:ring-2 focus-visible:ring-[#C5F23C]/30",
        isSelected ? "bg-[#C5F23C]/[0.10] border border-[#C5F23C]/25" :
        isLoaded   ? "bg-white/[0.05] border border-white/[0.08]" :
                     "hover:bg-white/[0.04] border border-transparent"
      )}
    >
      <div className="flex items-start gap-2">
        {/* Left: checkbox or dot */}
        {isManaging ? (
          <span className="shrink-0 mt-[1px]">
            {isSelected
              ? <CheckSquare className="w-3.5 h-3.5 text-[#C5F23C]" strokeWidth={2} />
              : <Square className="w-3.5 h-3.5 text-muted-foreground/40" strokeWidth={1.5} />
            }
          </span>
        ) : (
          <span className="shrink-0 mt-[4px] rounded-full" style={{ width: 5, height: 5, background: c.bar, flexShrink: 0 }} />
        )}

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-1">
          {/* Feature name */}
          <p className="text-[12px] font-medium leading-snug text-foreground/80"
            style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {title}
          </p>
          {/* Requirement preview */}
          {req && req !== title && (
            <p className="text-[10.5px] text-muted-foreground/50 leading-snug"
              style={{ display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {req}
            </p>
          )}
          {/* Meta row */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground/45">{formatStamp(row.created_at)}</span>
            {iterCount > 1 && (
              <span className="text-[9.5px] px-1.5 py-px rounded-md font-medium"
                style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}>
                {iterCount} 版
              </span>
            )}
            <div className="ml-auto">
              <ScoreBar score={score} width={32} />
            </div>
          </div>
        </div>

        {/* Delete button (hover only) */}
        {!isManaging && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onDelete(e); }}
            onKeyDown={(e) => e.key === "Enter" && onDelete(e as any)}
            className="opacity-0 group-hover:opacity-100 shrink-0 p-1 rounded-lg transition-all hover:bg-red-50 hover:text-red-500 cursor-pointer text-muted-foreground/40"
            title="刪除"
          >
            <Trash2 className="w-3 h-3" strokeWidth={1.8} />
          </span>
        )}
      </div>

      {/* Loaded indicator */}
      {isLoaded && !isManaging && (
        <div className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full" style={{ background: "var(--ns-accent)" }} />
      )}
    </div>
  );
}

/* ─── Main component ── */

// iteration detail fetched for each history session
type HistIter = { iteration_num: number; quality_score: number; created_at: number; feature_name: string };
// figma version detail fetched for each figma story session
type FigmaVer = { version_num: number; created_at: number; label: string; feature_count: number };

import { useNetSpec } from "@/hooks/useNetSpec";
import { track } from "@/lib/track";

export default function AppSidebar({
  currentPanel, onPanelChange,
  workflowMode, onWorkflowModeChange,
  iterations, currentIteration, onLoadIteration,
  onLoadHistorySession, onLoadFigmaHistory, loadedFigmaId,
  onResetToHome, onGoLanding,
  loadedHistoryId, stepsCompleted, status,
}: AppSidebarProps) {
  const { syncLlmMode } = useNetSpec();
  const [dbHistory, setDbHistory] = useState<any[]>([]);      // merged: each item has `kind`
  const [histIters, setHistIters] = useState<Record<string, HistIter[]>>({});       // text iterations
  const [figmaVers, setFigmaVers] = useState<Record<string, FigmaVer[]>>({});        // figma versions
  const [isManaging, setIsManaging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const refreshHistory = useCallback(() => {
    const textP  = fetch("/api/history?limit=30").then(r => r.ok ? r.json() : []).catch(() => []);
    const figmaP = fetch("/api/figma/history?limit=30").then(r => r.ok ? r.json() : []).catch(() => []);
    Promise.all([textP, figmaP]).then(async ([textS, figmaS]: [any[], any[]]) => {
      const merged = [
        ...(Array.isArray(textS) ? textS : []).map((s: any) => ({ ...s, kind: "text" })),
        ...(Array.isArray(figmaS) ? figmaS : []).map((s: any) => ({ ...s, kind: "figma" })),
      ].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      setDbHistory(merged);

      // Text iteration details (only multi-version sessions)
      const tEntries = await Promise.all((Array.isArray(textS) ? textS : []).map(async (s: any) => {
        if ((s.iteration_count ?? 1) <= 1) return [s.id, []] as [string, HistIter[]];
        const iters = await fetch(`/api/history/${s.id}/iterations`)
          .then(r => r.ok ? r.json() : []).catch(() => []);
        return [s.id, iters] as [string, HistIter[]];
      }));
      setHistIters(Object.fromEntries(tEntries));

      // Figma version details (only multi-version sessions)
      const fEntries = await Promise.all((Array.isArray(figmaS) ? figmaS : []).map(async (s: any) => {
        if ((s.version_count ?? 1) <= 1) return [s.id, []] as [string, FigmaVer[]];
        const vers = await fetch(`/api/figma/history/${s.id}/versions`)
          .then(r => r.ok ? r.json() : []).catch(() => []);
        return [s.id, vers] as [string, FigmaVer[]];
      }));
      setFigmaVers(Object.fromEntries(fEntries));
    }).catch(() => {});
  }, []);

  const toggleSelect = (id: string) =>
    setSelected(prev => { const s = new Set(prev); if (s.has(id)) s.delete(id); else s.add(id); return s; });

  // Show only the ACTIVE workflow's own history.
  // Text mode: text sessions (loaded one moves to 本次分析). Figma mode: figma sessions.
  const visibleHistory = dbHistory.filter(r =>
    workflowMode === "figma"
      ? r.kind === "figma"
      : r.kind === "text" && r.id !== loadedHistoryId
  );

  const deleteEndpoint = (id: string) => {
    const item = dbHistory.find(r => r.id === id);
    return item?.kind === "figma"
      ? `/api/figma/history/${id}`
      : `/api/history/${id}`;
  };

  const deleteSelected = async () => {
    if (!selected.size) return;
    setDeleting(true);
    track("history_deleted", { count: selected.size, mode: "bulk" });
    try {
      await Promise.all([...selected].map(id =>
        fetch(deleteEndpoint(id), { method: "DELETE" })
      ));
      setSelected(new Set()); setIsManaging(false); refreshHistory();
    } finally { setDeleting(false); }
  };

  const deleteSingle = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("確定刪除這筆記錄？")) {
      track("history_delete_cancelled", { mode: "single" });
      return;
    }
    track("history_deleted", {
      count: 1, mode: "single",
      kind: dbHistory.find(r => r.id === id)?.kind ?? "unknown",
    });
    await fetch(deleteEndpoint(id), { method: "DELETE" });
    refreshHistory();
  };

  // LLM mode + usage polling moved to TopBarControls (TopBar). Sidebar keeps the
  // mode in sync for history filtering via the store.
  useEffect(() => { syncLlmMode(); }, [syncLlmMode]);

  useEffect(() => { refreshHistory(); }, [iterations, refreshHistory]);

  // Refresh when a Figma story version is saved in another panel.
  useEffect(() => {
    const h = () => refreshHistory();
    window.addEventListener("figma-history-changed", h);
    return () => window.removeEventListener("figma-history-changed", h);
  }, [refreshHistory]);

  const hasContent = (workflowMode === "text" && iterations.length > 0) || visibleHistory.length > 0;

  return (
    <aside className="flex flex-col h-full shrink-0 overflow-hidden relative"
      style={{
        width: 248, minWidth: 248, maxWidth: 248,
        background: "var(--ns-ink)",
        // Scope dark theme vars so neutral children (text-foreground / muted / card / border) flip to light:
        ["--foreground" as any]: "210 16% 91%",
        ["--muted-foreground" as any]: "214 9% 60%",
        ["--card" as any]: "212 24% 11%",
        ["--muted" as any]: "213 18% 20%",
        ["--secondary" as any]: "213 18% 20%",
        ["--border" as any]: "213 14% 18%",
        color: "#E7EAEE",
      } as React.CSSProperties}>

      {/* lime radial glow at top */}
      <div aria-hidden className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(420px 200px at 20% -8%, rgba(197,242,60,.10), transparent 70%)" }} />

      {/* ── Logo — 回首頁（返回 Landing 首頁）── */}
      <button type="button"
        onClick={() => {
          if (status === "running") {
            // Walking out mid-run is the abandonment signal the PoC is after —
            // record both the intent and whether they went through with it.
            if (!confirm("正在執行中，確定要回到首頁嗎？（分析會在背景保留）")) {
              track("leave_while_running_cancelled", { steps_completed: stepsCompleted });
              return;
            }
            track("left_while_running", { steps_completed: stepsCompleted });
          }
          onGoLanding();
        }}
        className="relative z-[1] flex items-center gap-3 px-4 pt-5 pb-4 shrink-0 w-full text-left hover:bg-white/[0.04] transition-colors"
        title="回首頁">
        <LogoBadge />
        <div className="flex flex-col gap-[1px] min-w-0">
          <span className="font-extrabold leading-[1.2] tracking-[-0.02em] truncate" style={{ fontSize: 16, color: "#fff" }}>NetSpec</span>
          <span className="leading-[1.3] truncate" style={{ fontSize: 10.5, color: "#8A929C" }}>網通規格生成平台</span>
        </div>
      </button>

      <Divider />

      {/* Workflow tabs (文字輸入 / Figma 分析) now live in the topbar — see app/page.tsx TopBar */}

      {/* ── Running banner — shown when pipeline or iteration is active ── */}
      {status === "running" && workflowMode === "text" && (
        <div className="relative z-[1] mx-2 mt-2 mb-0 flex items-center gap-2 px-3 py-2 rounded-xl"
          style={{ background: "rgba(197,242,60,0.10)", border: "1px solid rgba(197,242,60,0.25)" }}>
          <div className="w-2 h-2 rounded-full shrink-0 animate-pulse" style={{ background: "var(--ns-accent)", boxShadow: "0 0 8px var(--ns-accent)" }} />
          <span style={{ fontSize: 11, color: "var(--ns-accent)", fontWeight: 600 }}>
            {stepsCompleted >= 6 ? "規格書優化中…" : "分析執行中…"}
          </span>
        </div>
      )}

      {/* ── Navigation ── */}
      <nav className="relative z-[1] flex flex-col gap-[3px] px-3 py-2.5 shrink-0" aria-label="主選單">
        <div className="px-1 pb-1.5 text-[10.5px] font-bold uppercase tracking-[0.12em]" style={{ color: "#5E6772" }}>工作流程</div>
        {(workflowMode === "text" ? TEXT_NAV_ITEMS : FIGMA_NAV_ITEMS).map(({ id, label, icon: Icon }) => {
          const active = currentPanel === id;
          const showBadge = id === "pipeline" && stepsCompleted > 0;
          const blocked = status === "running" && id === "input" && workflowMode === "text";
          return (
            <button key={`${workflowMode}-${id}`} type="button" aria-current={active ? "page" : undefined}
              disabled={blocked}
              onClick={() => !blocked && onPanelChange(id)}
              className={cn(
                "group relative flex items-center gap-3 w-full px-3 py-[9px] rounded-[11px]",
                "text-[14px] font-semibold text-left transition-all duration-150 outline-none",
                "focus-visible:ring-2 focus-visible:ring-[#C5F23C]/40",
                blocked ? "opacity-35 cursor-not-allowed" : "",
              )}
              style={
                blocked ? undefined :
                active
                  ? { background: "linear-gradient(100deg, rgba(197,242,60,.16), rgba(197,242,60,.05))", color: "#fff" }
                  : { color: "#AEB6BF" }
              }
              onMouseEnter={(e) => { if (!active && !blocked) e.currentTarget.style.background = "#181E25"; }}
              onMouseLeave={(e) => { if (!active && !blocked) e.currentTarget.style.background = "transparent"; }}>
              {active && !blocked && (
                <span aria-hidden className="absolute" style={{ left: -12, top: 9, bottom: 9, width: 3, borderRadius: "0 3px 3px 0", background: "var(--ns-accent)" }} />
              )}
              <Icon className="shrink-0" style={{ width: 18, height: 18, color: active ? "var(--ns-accent)" : undefined, opacity: active ? 1 : 0.85 }} strokeWidth={active ? 2.1 : 1.8} />
              <span className="flex-1 leading-none">{label}</span>
              {showBadge && (
                <span className="text-[10px] font-mono px-1.5 py-[2px] rounded-md leading-none"
                  style={active ? { background: "rgba(197,242,60,.18)", color: "var(--ns-accent)" } : { background: "rgba(255,255,255,.06)", color: "#8A929C" }}>
                  {stepsCompleted}/8
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <Divider />

      {/* ── Specs / history section (unified: text + figma) ── */}
      <div className="relative z-[1] flex flex-col flex-1 overflow-hidden">

        {/* Empty state */}
        {!hasContent && (
          <div className="flex flex-col items-center justify-center flex-1 gap-2 select-none px-4">
            <div className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: "hsl(var(--muted))" }}>
              <BookOpen style={{ width: 18, height: 18, color: "hsl(var(--muted-foreground))", opacity: 0.4 }} />
            </div>
            <p className="text-[11.5px] text-muted-foreground/50 text-center leading-relaxed">
              完成分析後<br />結果會顯示在這裡
            </p>
          </div>
        )}

        {hasContent && (
          <ScrollArea className="flex-1 min-h-0">
            <div className="py-3 space-y-4">

              {/* ── 本次分析（文字流程）── */}
              {workflowMode === "text" && iterations.length > 0 && (
                <section>
                  <p className="px-4 pb-2 text-[10px] font-semibold text-muted-foreground/50 tracking-[0.1em] uppercase select-none">
                    本次分析
                  </p>
                  <CurrentSessionCard
                    iterations={iterations}
                    currentIteration={currentIteration}
                    onLoadIteration={onLoadIteration}
                  />
                </section>
              )}

              {/* ── 歷史記錄 ── */}
              {visibleHistory.length > 0 && (
                <section>
                  <div className="px-4 pb-2 flex items-center justify-between">
                    <p className="text-[10px] font-semibold text-muted-foreground/50 tracking-[0.1em] uppercase select-none">
                      歷史記錄 <span style={{ opacity: 0.7 }}>{visibleHistory.length}</span>
                    </p>
                    <button type="button"
                      onClick={() => { setIsManaging(v => !v); setSelected(new Set()); }}
                      className="text-[10px] font-medium transition-colors"
                      style={{ color: isManaging ? "var(--ns-accent-deep)" : "hsl(var(--muted-foreground))" }}>
                      {isManaging ? "完成" : "管理"}
                    </button>
                  </div>

                  {/* Manage toolbar */}
                  {isManaging && (
                    <div className="flex items-center gap-2 px-3 pb-2">
                      <button type="button"
                        onClick={() => selected.size === visibleHistory.length ? setSelected(new Set()) : setSelected(new Set(visibleHistory.map(r => r.id)))}
                        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
                        {selected.size === visibleHistory.length
                          ? <CheckSquare className="w-3.5 h-3.5 text-[#C5F23C]" strokeWidth={2} />
                          : <Square className="w-3.5 h-3.5" strokeWidth={1.8} />}
                        {selected.size === visibleHistory.length ? "取消全選" : "全選"}
                      </button>
                      <span className="flex-1" />
                      {selected.size > 0 && (
                        <button type="button" onClick={deleteSelected} disabled={deleting}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium"
                          style={{ background: "rgba(239,68,68,0.1)", color: "#dc2626" }}>
                          <Trash2 className="w-3 h-3" strokeWidth={2} />
                          {deleting ? "刪除中…" : `刪除 ${selected.size} 筆`}
                        </button>
                      )}
                    </div>
                  )}

                  <div className="space-y-2">
                    {visibleHistory.map((row: any) => {
                      // ── Figma story session card ──────────────────────────
                      if (row.kind === "figma") {
                        const fTitle    = row.file_name?.trim() || "Figma 故事";
                        const frameStr  = Array.isArray(row.frame_names) ? row.frame_names.join("、") : "";
                        const featCount = row.feature_count || 0;
                        const verCount  = row.version_count || 1;
                        const vers: FigmaVer[] = figmaVers[row.id] ?? [];
                        const isLoaded  = row.id === loadedFigmaId;
                        const verMetas: IterationMeta[] = vers.length > 0
                          ? vers.map(v => ({
                              iteration: v.version_num,
                              timestamp: v.created_at,
                              quality_score: 0,
                              validation_passed: false,
                              feature_name: v.label || "故事",
                            }))
                          : [{ iteration: 1, timestamp: row.created_at, quality_score: 0,
                               validation_passed: false, feature_name: "故事" }];
                        return (
                          <div key={`fg-${row.id}`} className="mx-2 rounded-xl overflow-hidden relative"
                            style={{
                              border: isLoaded ? "1px solid rgba(139,92,246,0.3)" : "1px solid hsl(var(--border))",
                              background: isLoaded ? "rgba(139,92,246,0.04)" : "hsl(var(--card))",
                            }}>
                            {isLoaded && (
                              <div className="absolute left-0 inset-y-0 w-[3px] rounded-l-xl" style={{ background: "#8b5cf6" }} />
                            )}
                            <div className="pl-4 pr-3 py-2.5 flex items-start gap-2 group"
                              style={{ borderBottom: "1px solid hsl(var(--border) / 0.6)", cursor: isManaging ? "default" : "pointer" }}
                              onClick={() => !isManaging && onLoadFigmaHistory(row.id)}>
                              {isManaging ? (
                                <button type="button" onClick={(e) => { e.stopPropagation(); toggleSelect(row.id); }} className="shrink-0 mt-[1px]">
                                  {selected.has(row.id)
                                    ? <CheckSquare className="w-3.5 h-3.5 text-[#C5F23C]" strokeWidth={2} />
                                    : <Square className="w-3.5 h-3.5 text-muted-foreground/40" strokeWidth={1.5} />}
                                </button>
                              ) : null}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="shrink-0 text-[8.5px] font-bold px-1 py-px rounded leading-none"
                                    style={{ background: "rgba(139,92,246,0.12)", color: "#7c3aed" }}>
                                    FIGMA
                                  </span>
                                  <p className="flex-1 text-[12px] font-semibold leading-snug text-foreground/85 truncate">
                                    {fTitle}
                                  </p>
                                </div>
                                {frameStr && (
                                  <p className="text-[10px] text-muted-foreground/55 leading-snug mt-0.5"
                                    style={{ display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                                    {frameStr}
                                  </p>
                                )}
                                <div className="flex items-center gap-2 mt-1">
                                  <span className="text-[9.5px] text-muted-foreground/50">{formatDate(row.created_at)}</span>
                                  {featCount > 0 && (
                                    <span className="text-[9px] px-1.5 py-px rounded-md font-medium"
                                      style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}>
                                      {featCount} 功能
                                    </span>
                                  )}
                                  {verCount > 1 && (
                                    <span className="text-[9px] px-1.5 py-px rounded-md font-medium"
                                      style={{ background: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }}>
                                      {verCount} 版
                                    </span>
                                  )}
                                </div>
                              </div>
                              {!isManaging && (
                                <span role="button" onClick={(e) => { e.stopPropagation(); deleteSingle(row.id, e); }}
                                  className="opacity-0 group-hover:opacity-100 shrink-0 p-1 rounded-lg text-muted-foreground/40 hover:text-red-500 hover:bg-red-50 transition-all cursor-pointer"
                                  title="刪除">
                                  <Trash2 className="w-3 h-3" strokeWidth={1.8} />
                                </span>
                              )}
                            </div>
                            <div className="px-1.5 py-1.5 space-y-0.5">
                              {verMetas.map((iter, idx) => (
                                <VersionRow
                                  key={iter.iteration}
                                  iter={iter}
                                  idx={idx}
                                  allIters={verMetas}
                                  isCurrent={isLoaded}
                                  hideScore
                                  onClick={() => { if (isManaging) toggleSelect(row.id); else onLoadFigmaHistory(row.id); }}
                                />
                              ))}
                            </div>
                          </div>
                        );
                      }

                      // ── Text spec session card ────────────────────────────
                      const iters: HistIter[] = histIters[row.id] ?? [];
                      const title = row.feature_name?.trim() || row.requirement?.substring(0, 20) || "規格書";
                      const bestScore = row.best_score || 0;
                      const isLoaded = row.id === loadedHistoryId;

                      // Build IterationMeta-like array for VersionRow
                      const iterMetas: IterationMeta[] = iters.length > 0
                        ? iters.map(it => ({
                            iteration: it.iteration_num,
                            timestamp: it.created_at,
                            quality_score: it.quality_score,
                            validation_passed: false,
                            feature_name: it.feature_name || title,
                          }))
                        : [{ iteration: 1, timestamp: row.created_at, quality_score: bestScore,
                             validation_passed: false, feature_name: title }];

                      return (
                        <div key={`db-${row.id}`} className="mx-2 rounded-xl overflow-hidden relative"
                          style={{
                            border: isLoaded ? "1px solid rgba(197,242,60,0.30)" : "1px solid hsl(var(--border))",
                            background: isLoaded ? "rgba(197,242,60,0.05)" : "hsl(var(--card))",
                          }}>
                          {/* Left accent for loaded */}
                          {isLoaded && (
                            <div className="absolute left-0 inset-y-0 w-[3px] rounded-l-xl" style={{ background: "var(--ns-accent)" }} />
                          )}

                          {/* Card header */}
                          <div className="pl-4 pr-3 py-2.5 flex items-start gap-2 group"
                            style={{ borderBottom: "1px solid hsl(var(--border) / 0.6)", cursor: isManaging ? "default" : "pointer" }}
                            onClick={() => !isManaging && onLoadHistorySession(row.id)}>
                            {isManaging ? (
                              <button type="button" onClick={(e) => { e.stopPropagation(); toggleSelect(row.id); }} className="shrink-0 mt-[1px]">
                                {selected.has(row.id)
                                  ? <CheckSquare className="w-3.5 h-3.5 text-[#C5F23C]" strokeWidth={2} />
                                  : <Square className="w-3.5 h-3.5 text-muted-foreground/40" strokeWidth={1.5} />}
                              </button>
                            ) : null}
                            <div className="flex-1 min-w-0">
                              <p className="text-[12px] font-semibold leading-snug text-foreground/85"
                                style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                                {title}
                              </p>
                              <div className="flex items-center gap-2 mt-1">
                                <ScoreBar score={bestScore} width={36} />
                                <span className="text-[9.5px] text-muted-foreground/50">{formatDate(row.created_at)}</span>
                              </div>
                            </div>
                            {!isManaging && (
                              <span role="button" onClick={(e) => { e.stopPropagation(); deleteSingle(row.id, e); }}
                                className="opacity-0 group-hover:opacity-100 shrink-0 p-1 rounded-lg text-muted-foreground/40 hover:text-red-500 hover:bg-red-50 transition-all cursor-pointer"
                                title="刪除">
                                <Trash2 className="w-3 h-3" strokeWidth={1.8} />
                              </span>
                            )}
                          </div>

                          {/* Version rows — same as CurrentSessionCard */}
                          <div className="px-1.5 py-1.5 space-y-0.5">
                            {iterMetas.map((iter, idx) => (
                              <VersionRow
                                key={iter.iteration}
                                iter={iter}
                                idx={idx}
                                allIters={iterMetas}
                                isCurrent={isLoaded && iter.iteration === currentIteration}
                                onClick={() => {
                                  if (isManaging) { toggleSelect(row.id); return; }
                                  if (isLoaded) {
                                    onLoadIteration(iter.iteration);
                                  } else {
                                    onLoadHistorySession(row.id);
                                  }
                                }}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* Footer removed — LLM mode + today's usage moved to the TopBar (top-right). */}
    </aside>
  );
}
