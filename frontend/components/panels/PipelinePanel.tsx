"use client";

import { useState, useEffect } from "react";
import { Check, Loader2, Wrench, Clock, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolCallEvent } from "@/lib/types";

// ─── Data ────────────────────────────────────────────────────────────────────

type Phase = "Phase1" | "Phase2" | "Phase3";

interface Step {
  step: number; id: string; title: string; desc: string; agent: string; phase: Phase;
}

const PHASE_META: Record<Phase, { label: string; color: string; light: string; steps: string }> = {
  Phase1: { label: "Phase 1", color: "#6B5CF0", light: "rgba(107,92,240,0.08)",  steps: "需求理解" },
  Phase2: { label: "Phase 2", color: "#8b5cf6", light: "rgba(139,92,246,0.08)", steps: "社群情報" },
  Phase3: { label: "Phase 3", color: "#22c55e", light: "rgba(34,197,94,0.08)",  steps: "規格生成" },
};

const PHASE_GROUPS: { phase: Phase; steps: number[] }[] = [
  { phase: "Phase1", steps: [1, 2] },
  { phase: "Phase2", steps: [3, 4, 5] },
  { phase: "Phase3", steps: [6, 7, 8] },
];

const STEPS: Step[] = [
  { step: 1, id: "parse",        title: "需求解析",        desc: "解析需求語意、識別協定與清晰度評分",           agent: "LLM",    phase: "Phase1" },
  { step: 2, id: "socratic",     title: "需求引導追問",     desc: "蘇格拉底式動態追問，最多 5 輪",               agent: "LLM",    phase: "Phase1" },
  { step: 3, id: "plan_search",  title: "搜尋規劃",        desc: "依協定生成針對性社群搜尋關鍵字",               agent: "LLM",    phase: "Phase2" },
  { step: 4, id: "scrape",       title: "社群情報爬蟲",     desc: "GitHub Issues / HN 並行抓取",               agent: "httpx",  phase: "Phase2" },
  { step: 5, id: "analyze",      title: "社群災情分析",     desc: "從社群資料萃取高頻故障模式",                   agent: "LLM",    phase: "Phase2" },
  { step: 6, id: "detect_edges", title: "邊界情境偵測",     desc: "列舉協定邊界條件與風險等級",                   agent: "LLM",    phase: "Phase3" },
  { step: 7, id: "gherkin",      title: "PRD 規格書生成",   desc: "生成完整 PRD（需求、SLA、驗收標準）",          agent: "LLM",    phase: "Phase3" },
  { step: 8, id: "validate",     title: "品質交叉校驗",     desc: "驗證規格完整性、SLA 合理性與邊界覆蓋",         agent: "LLM",    phase: "Phase3" },
];

// ─── Step icon ────────────────────────────────────────────────────────────────

function StepBullet({ state, step, color }: { state: "done" | "active" | "pending"; step: number; color: string }) {
  if (state === "done") {
    return (
      <div className="flex items-center justify-center rounded-full shrink-0"
        style={{ width: 24, height: 24, background: "#22c55e" }}>
        <Check style={{ width: 12, height: 12, color: "#fff" }} strokeWidth={3} />
      </div>
    );
  }
  if (state === "active") {
    return (
      <div className="flex items-center justify-center rounded-full shrink-0 relative"
        style={{ width: 24, height: 24, background: color, boxShadow: `0 0 0 4px ${color}25` }}>
        <Loader2 style={{ width: 12, height: 12, color: "#fff" }} strokeWidth={2.5} className="animate-spin" />
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center rounded-full shrink-0 border-2"
      style={{ width: 24, height: 24, borderColor: "hsl(var(--border))", background: "hsl(var(--background))" }}>
      <span style={{ fontSize: 9, fontWeight: 700, color: "hsl(var(--muted-foreground))", opacity: 0.4 }}>{step}</span>
    </div>
  );
}

// ─── Tool call summary (inline, compact) ──────────────────────────────────────

function ToolCallSummary({ tc }: { tc: ToolCallEvent }) {
  const dur = tc.duration_ms >= 1000 ? `${(tc.duration_ms / 1000).toFixed(1)}s` : `${tc.duration_ms}ms`;
  return (
    <div className="flex items-start gap-2 px-3 py-2 rounded-lg"
      style={{ background: "rgba(107,92,240,0.04)", border: "1px solid rgba(107,92,240,0.10)" }}>
      <Wrench style={{ width: 10, height: 10, color: "#6B5CF0", flexShrink: 0, marginTop: 2 }} strokeWidth={2} />
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] font-semibold text-[#6B5CF0] truncate">{tc.tool}()</span>
          <span className="shrink-0 text-[9px] text-muted-foreground/50 flex items-center gap-0.5">
            <Clock style={{ width: 8, height: 8 }} />{dur}
          </span>
        </div>
        <p style={{ fontSize: 10.5, color: "hsl(var(--muted-foreground))", lineHeight: 1.4 }}>{tc.output_summary}</p>
      </div>
    </div>
  );
}

// ─── StepRow with timeline connector ─────────────────────────────────────────

function StepRow({ s, idx, done, isLastInPhase, toolCalls, currentThought, thoughtHistory, stepAgents, stepModels }: {
  s: Step; idx: number; done: number; isLastInPhase: boolean;
  toolCalls: ToolCallEvent[]; currentThought: string;
  thoughtHistory: { step: number; thought: string }[];
  stepAgents: Record<number, string>; stepModels: Record<number, string>;
}) {
  const state: "done" | "active" | "pending" =
    s.step <= done ? "done" : s.step === done + 1 ? "active" : "pending";
  const { color } = PHASE_META[s.phase];
  const stepCalls = toolCalls.filter(tc => tc.step === s.step);
  const stepThought = thoughtHistory.find(t => t.step === s.step)?.thought;
  const agentLabel = stepAgents[s.step]
    ? stepAgents[s.step]
    : s.id === "scrape" ? "httpx"
    : s.agent === "LLM" ? (stepModels[s.step] ?? "LLM")
    : s.agent;

  const connectorColor = state === "done" ? "#22c55e"
    : state === "active" ? color
    : "hsl(var(--border))";

  return (
    <div className="flex gap-3">
      {/* Timeline column */}
      <div className="flex flex-col items-center shrink-0" style={{ width: 24 }}>
        <StepBullet state={state} step={s.step} color={color} />
        {!isLastInPhase && (
          <div className="flex-1 w-[2px] my-1 rounded-full transition-colors duration-500"
            style={{ background: state === "done" ? "#22c55e33" : "hsl(var(--border) / 0.5)", minHeight: 12 }} />
        )}
      </div>

      {/* Content column */}
      <div className={cn("flex-1 min-w-0 pb-4", isLastInPhase && "pb-1")}>
        {/* Main row */}
        <div className={cn(
          "flex items-start gap-2 rounded-xl px-3 py-2.5 transition-all duration-200",
          state === "active" && "shadow-sm",
        )}
          style={{
            background: state === "active" ? `${color}08` : "transparent",
            border: state === "active" ? `1px solid ${color}20` : "1px solid transparent",
          }}>
          <div className="flex-1 min-w-0 space-y-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={cn(
                "text-[13px] font-semibold leading-snug",
                state === "done" && "text-muted-foreground",
                state === "pending" && "text-muted-foreground/50",
              )}
                style={state === "active" ? { color } : undefined}>
                {s.title}
              </span>
              {state === "done" && (
                <span style={{ fontSize: 9.5, color: "#22c55e", fontWeight: 600 }}>✓ 完成</span>
              )}
              {state === "active" && (
                <span className="rounded-full px-1.5 py-px text-[9px] font-semibold"
                  style={{ background: `${color}15`, color }}>進行中</span>
              )}
            </div>
            <p className={cn("text-[11.5px] leading-snug", state === "pending" ? "text-muted-foreground/35" : "text-muted-foreground/60")}>
              {s.desc}
            </p>
          </div>
          {/* Agent badge */}
          <span className="shrink-0 mt-0.5 font-mono rounded-md px-1.5 py-[2px]"
            style={{
              fontSize: 9.5,
              letterSpacing: "0.03em",
              background: state === "done" ? "rgba(34,197,94,0.08)" :
                          state === "active" ? `${color}12` : "hsl(var(--muted))",
              color: state === "done" ? "#16a34a" :
                     state === "active" ? color : "hsl(var(--muted-foreground))",
              opacity: state === "pending" ? 0.4 : 1,
            }}>
            {agentLabel}
          </span>
        </div>

        {/* Thought bubble — active only */}
        {state === "active" && currentThought && (
          <div className="mt-1.5 mx-1 flex items-start gap-2 px-3 py-2 rounded-xl"
            style={{ background: `${color}06`, border: `1px solid ${color}18` }}>
            <span className="shrink-0 text-[12px]">🤔</span>
            <p style={{ fontSize: 11.5, color, lineHeight: 1.55, fontStyle: "italic" }}>{currentThought}</p>
          </div>
        )}

        {/* Completed: thought + tool calls */}
        {state === "done" && (stepThought || stepCalls.length > 0) && (
          <div className="mt-1.5 mx-1 space-y-1">
            {stepThought && stepCalls.length === 0 && (
              <div className="flex items-start gap-1.5 px-3 py-1.5 rounded-lg"
                style={{ background: "hsl(var(--muted)/0.4)" }}>
                <span style={{ fontSize: 10, opacity: 0.5, flexShrink: 0, marginTop: 1 }}>💬</span>
                <span style={{ fontSize: 10.5, color: "hsl(var(--muted-foreground))", fontStyle: "italic", lineHeight: 1.5 }}>{stepThought}</span>
              </div>
            )}
            {stepCalls.map((tc, i) => <ToolCallSummary key={i} tc={tc} />)}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Phase section ─────────────────────────────────────────────────────────────

function PhaseSection({ phase, steps, done, ...rowProps }: {
  phase: Phase; steps: Step[]; done: number;
  toolCalls: ToolCallEvent[]; currentThought: string;
  thoughtHistory: { step: number; thought: string }[];
  stepAgents: Record<number, string>; stepModels: Record<number, string>;
}) {
  const { label, color, light, steps: stepsLabel } = PHASE_META[phase];
  const minStep = Math.min(...steps.map(s => s.step));
  const maxStep = Math.max(...steps.map(s => s.step));
  const phaseState: "done" | "active" | "pending" =
    done >= maxStep ? "done" : done >= minStep - 1 ? "active" : "pending";

  return (
    <div className="rounded-2xl overflow-hidden"
      style={{
        border: `1px solid ${phaseState === "pending" ? "hsl(var(--border))" : phaseState === "active" ? `${color}25` : "rgba(34,197,94,0.2)"}`,
        background: phaseState === "active" ? light : "hsl(var(--card))",
        transition: "all 0.4s ease",
      }}>
      {/* Phase header */}
      <div className="flex items-center gap-2.5 px-4 py-3"
        style={{
          borderBottom: `1px solid ${phaseState === "pending" ? "hsl(var(--border))" : `${color}18`}`,
          background: phaseState === "done" ? "rgba(34,197,94,0.04)" :
                      phaseState === "active" ? `${color}0a` : undefined,
        }}>
        <div className="flex items-center justify-center rounded-lg shrink-0"
          style={{ width: 24, height: 24,
                   background: phaseState === "pending" ? "hsl(var(--muted))" :
                               phaseState === "done" ? "rgba(34,197,94,0.15)" : `${color}18` }}>
          <span style={{ fontSize: 11, fontWeight: 800,
                         color: phaseState === "pending" ? "hsl(var(--muted-foreground))" :
                                phaseState === "done" ? "#16a34a" : color,
                         opacity: phaseState === "pending" ? 0.4 : 1 }}>
            {label.split(" ")[1]}
          </span>
        </div>
        <div>
          <p className="font-semibold" style={{ fontSize: 12, color: phaseState === "pending" ? "hsl(var(--muted-foreground))" : phaseState === "done" ? "#16a34a" : color, opacity: phaseState === "pending" ? 0.5 : 1 }}>
            {label} — {stepsLabel}
          </p>
          <p style={{ fontSize: 10, color: "hsl(var(--muted-foreground))", opacity: phaseState === "pending" ? 0.4 : 0.7 }}>
            步驟 {minStep}~{maxStep}
          </p>
        </div>
        {phaseState === "done" && (
          <span className="ml-auto text-[10px] font-semibold rounded-full px-2 py-0.5"
            style={{ background: "rgba(34,197,94,0.12)", color: "#16a34a" }}>✓ 完成</span>
        )}
        {phaseState === "active" && (
          <span className="ml-auto text-[10px] font-semibold rounded-full px-2 py-0.5 flex items-center gap-1"
            style={{ background: `${color}12`, color }}>
            <Loader2 style={{ width: 9, height: 9 }} className="animate-spin" />進行中
          </span>
        )}
      </div>

      {/* Steps */}
      <div className="px-3 pt-3 pb-2">
        {steps.map((s, idx) => (
          <StepRow key={s.id} s={s} idx={idx} done={done}
            isLastInPhase={idx === steps.length - 1}
            {...rowProps} />
        ))}
      </div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────

export interface PipelinePanelProps {
  stepsCompleted?: number;
  status?: string;
  toolCalls?: ToolCallEvent[];
  currentThought?: string;
  thoughtHistory?: { step: number; thought: string }[];
  stepAgents?: Record<number, string>;
  llmMode?: "ollama" | "api";
  onRestart?: () => void;
}

export function PipelinePanel({
  stepsCompleted = 0, status, toolCalls = [],
  currentThought = "", thoughtHistory = [],
  stepAgents = {}, llmMode = "ollama", onRestart,
}: PipelinePanelProps) {
  const [stepModels, setStepModels] = useState<Record<number, string>>({});
  useEffect(() => {
    fetch("/api/health")
      .then(r => r.json())
      .then(d => {
        if (d.step_models) {
          const m: Record<number, string> = {};
          for (const [k, v] of Object.entries(d.step_models)) m[Number(k)] = v as string;
          setStepModels(m);
        }
      })
      .catch(() => {});
  }, []);

  const done = Math.min(Math.max(0, stepsCompleted), 8);
  const pct  = Math.round((done / 8) * 100);

  const isRunning  = status === "running";
  const isComplete = status === "complete" || done === 8;
  const isError    = status === "error";
  const isIdle     = !isRunning && !isComplete && !isError && done === 0;

  const subtitle =
    isError    ? "執行時發生錯誤" :
    isComplete ? "所有步驟已完成 🎉" :
    isRunning  ? `步驟 ${done + 1} / 8 進行中…` :
    `已完成 ${done} / 8 步驟`;

  // When idle: pass done=-1 so all steps render as "pending" (no spinner on step 1)
  const effectiveDone = isIdle ? -1 : done;
  const rowProps = { toolCalls, currentThought, thoughtHistory, stepAgents, stepModels };

  return (
    <div className="w-full max-w-[1400px] mx-auto space-y-4 pt-1">

      {/* ── Header (Astra style — matches 需求輸入 / 規格輸出) ── */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="space-y-1.5">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-[26px] font-extrabold tracking-[-0.03em] text-foreground leading-none">執行進度</h1>
            <span className="text-[11px] font-bold px-2.5 py-1 rounded-full leading-none"
              style={{ color: "var(--ns-violet)", background: "var(--ns-violet-soft)", border: "1px solid #DAD5F7" }}>
              PIPELINE
            </span>
          </div>
          {!isIdle && (
            <p className={cn("text-[14px] leading-relaxed", isError ? "text-red-600 font-medium" : isComplete ? "text-emerald-600 font-medium" : "text-muted-foreground")}>
              {subtitle}
            </p>
          )}
        </div>
        {done > 0 && (
          <span className="font-bold tabular-nums pb-0.5"
            style={{ fontSize: 20, fontFamily: "var(--font-grotesk)", color: isComplete ? "#22c55e" : isError ? "#ef4444" : "#6B5CF0" }}>
            {pct}%
          </span>
        )}
      </div>

      {/* ── Overall progress bar (only when running/done/error) ── */}
      {!isIdle && (
        <div className="rounded-2xl px-4 py-3 space-y-2.5"
          style={{ border: "1px solid hsl(var(--border))", background: "hsl(var(--card))" }}>
          <div className="flex items-center gap-3">
            <div className="flex-1 h-[5px] rounded-full overflow-hidden" style={{ background: "hsl(var(--muted))" }}>
              <div className="h-full rounded-full transition-all duration-700 ease-out"
                style={{ width: `${pct}%`, background: isComplete ? "#22c55e" : isError ? "#ef4444" : "#6B5CF0" }} />
            </div>
            <span className="text-[11px] font-mono text-muted-foreground shrink-0">{done}/8</span>
          </div>
          {/* Phase dots */}
          <div className="flex items-center gap-4 flex-wrap">
            {PHASE_GROUPS.map(({ phase, steps }) => {
              const min = Math.min(...steps), max = Math.max(...steps);
              const ps: "done" | "active" | "pending" =
                done >= max ? "done" : done >= min - 1 ? "active" : "pending";
              const { label, color } = PHASE_META[phase];
              return (
                <div key={phase} className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full shrink-0 transition-all duration-500"
                    style={{ background: ps === "pending" ? "hsl(var(--muted-foreground))" : ps === "done" ? "#22c55e" : color,
                             opacity: ps === "pending" ? 0.2 : 1,
                             boxShadow: ps === "active" ? `0 0 0 3px ${color}20` : undefined }} />
                  <span style={{ fontSize: 10.5, fontWeight: 500,
                                 color: ps === "pending" ? "hsl(var(--muted-foreground))" : ps === "done" ? "#16a34a" : color,
                                 opacity: ps === "pending" ? 0.35 : 1 }}>
                    {label}
                  </span>
                  {ps === "done" && <span style={{ fontSize: 9, color: "#16a34a" }}>✓</span>}
                </div>
              );
            })}
            {toolCalls.length > 0 && (
              <div className="ml-auto flex items-center gap-1">
                <Wrench style={{ width: 9, height: 9, color: "#6B5CF0" }} />
                <span style={{ fontSize: 10, color: "#6B5CF0", fontWeight: 600 }}>{toolCalls.length} 次工具呼叫</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Error banner ── */}
      {isError && (
        <div className="rounded-xl flex items-start gap-3 px-4 py-3"
          style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)" }}>
          <AlertTriangle style={{ width: 15, height: 15, color: "#dc2626", flexShrink: 0, marginTop: 1 }} strokeWidth={2} />
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 12.5, fontWeight: 600, color: "#b91c1c" }}>
              第 {done + 1} 步（{STEPS[done]?.title ?? ""}）發生錯誤
            </p>
            <p style={{ fontSize: 11.5, color: "#92400e", marginTop: 3 }}>
              通常是 LLM 逾時或 JSON 格式問題。社群情報等非必要步驟已會自動略過；若整體中斷，可直接重新開始。
            </p>
            {onRestart && (
              <button
                type="button"
                onClick={onRestart}
                className="mt-2.5 text-[11.5px] font-semibold px-3 py-[5px] rounded-lg transition-opacity hover:opacity-85"
                style={{ background: "#dc2626", color: "#fff" }}
              >
                重新開始
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Phase sections (always visible; idle uses effectiveDone=-1 → all pending) ── */}
      {PHASE_GROUPS.map(({ phase, steps: stepNums }) => (
        <PhaseSection
          key={phase}
          phase={phase}
          steps={STEPS.filter(s => stepNums.includes(s.step))}
          done={effectiveDone}
          {...rowProps}
        />
      ))}

      {/* ── Idle hint ── */}
      {isIdle && (
        <p className="text-center text-[13px] text-muted-foreground py-2 select-none">
          前往「需求輸入」輸入需求並送出後，Pipeline 執行進度將在此顯示
        </p>
      )}
    </div>
  );
}

export default PipelinePanel;
