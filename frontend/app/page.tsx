"use client";

import { useState, useEffect, useRef } from "react";
import { useNetSpec } from "@/hooks/useNetSpec";
import AppSidebar from "@/components/AppSidebar";
import InputPanel from "@/components/panels/InputPanel";
import PipelinePanel from "@/components/panels/PipelinePanel";
import ResultsPanel from "@/components/panels/ResultsPanel";
import FigmaStoryPanel from "@/components/panels/FigmaStoryPanel";
import FigmaMonitorPanel from "@/components/panels/FigmaMonitorPanel";
import LandingPage from "@/components/LandingPage";
import type { FigmaFrameListResult } from "@/lib/api";
import { track, setWorkflow } from "@/lib/track";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowRight, BookText, Layers, MessageCircle, ListChecks } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PanelId = "input" | "pipeline" | "results" | "log" | "story" | "monitor";

// ---------------------------------------------------------------------------
// Phase configuration
// ---------------------------------------------------------------------------

const PHASES = [
  { label: "Phase 1", color: "#6B5CF0", steps: [1, 2] },
  { label: "Phase 2", color: "#8b5cf6", steps: [3, 4, 5] },
  { label: "Phase 3", color: "#34c759", steps: [6, 7, 8] },
] as const;

type PhaseState = "done" | "active" | "pending";

/**
 * Compute phase dot state.
 *
 * isSocraticActive = true whenever the pipeline is in Phase 1 (steps 1-2),
 * regardless of whether status is "running" or "interrupted".
 * This covers both the socratic rounds themselves AND the running period
 * between rounds (when the user submits answers and the next round generates).
 */
function getPhaseState(
  phase: { steps: readonly number[] },
  stepsCompleted: number,
  isSocraticActive: boolean
): PhaseState {
  const maxStep = Math.max(...phase.steps);
  const minStep = Math.min(...phase.steps);

  if (isSocraticActive) {
    // Phase 1 (contains step 2): show as active — we're still in it
    if (phase.steps.includes(2)) return "active";
    // Phase 2+: not started yet
    return "pending";
  }

  if (stepsCompleted >= maxStep) return "done";
  if (stepsCompleted >= minStep - 1) return "active";
  return "pending";
}

// ---------------------------------------------------------------------------
// Step titles for progress overlay
// ---------------------------------------------------------------------------

const STEP_TITLES: Record<number, string> = {
  1: "需求解析 + 清晰度評分",
  2: "需求引導追問",
  3: "自主搜尋規劃器",
  4: "社群情報爬蟲",
  5: "長文本聚類分析",
  6: "邊界情境偵測引擎",
  7: "PRD 規格書生成",
  8: "交叉校驗",
};

// ---------------------------------------------------------------------------
// TopBar
// ---------------------------------------------------------------------------

interface TopBarProps {
  currentPanel: PanelId;
  stepsCompleted: number;
  isSocraticActive: boolean;
  specDocument: string | null;
  onExportMd: () => void;
  workflowMode: "text" | "figma";
  onWorkflowModeChange: (mode: "text" | "figma") => void;
  showMenu?: boolean;
  onMenuClick?: () => void;
}

// High-level pipeline steps shown in the topbar (text workflow).
const TOPBAR_STEPS = [
  { label: "需求", phase: PHASES[0] },
  { label: "分析", phase: PHASES[1] },
  { label: "規格", phase: PHASES[2] },
] as const;

// One independent LLM-mode toggle chip, parameterized by which backend service
// it talks to. text-spec and figma-service each have their own /health +
// /switch-mode (or /figma/health + /figma/switch-mode) — switching one never
// affects the other, since they're two separate processes/ports.
function LlmModeChip({
  label, healthPath, switchPath, title,
}: { label: string; healthPath: string; switchPath: string; title: string }) {
  const [llmMode, setLlmMode] = useState<"ollama" | "api">("ollama");
  const [connected, setConnected] = useState(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    const check = async () => {
      try {
        const d = await fetch(healthPath).then(r => (r.ok ? r.json() : null));
        setConnected(!!d);
        if (d) setLlmMode(d.use_ollama ? "ollama" : "api");
      } catch { setConnected(false); }
    };
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, [healthPath]);

  const switchMode = async () => {
    const next = llmMode === "ollama" ? "api" : "ollama";
    setSwitching(true);
    try {
      const res = await fetch(switchPath, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: next }),
      });
      if (res.ok) setLlmMode(next);
    } finally { setSwitching(false); }
  };

  const isApi = llmMode === "api";
  return (
    <button type="button" disabled={switching || !connected} onClick={switchMode} title={title}
      className="flex items-center gap-2 rounded-full transition-all"
      style={{ padding: "7px 13px", background: "#fff", border: "1px solid hsl(var(--border))",
               fontSize: 12.5, fontWeight: 700, color: "hsl(var(--foreground))",
               cursor: switching || !connected ? "not-allowed" : "pointer", opacity: switching ? 0.6 : 1 }}>
      <span style={{ width: 14, height: 14, borderRadius: 4,
        background: isApi ? "conic-gradient(from 220deg,#34C3FF,#6B5CF0,#34C3FF)" : "#cbd5e1" }} />
      <span style={{ color: "var(--ns-muted)", fontWeight: 600 }}>{label}</span>
      {switching ? "切換中" : (isApi ? "Azure" : "本地")}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        style={{ width: 14, height: 14, color: "var(--ns-muted)" }}><path d="M6 9l6 6 6-6" /></svg>
    </button>
  );
}

// Global controls (LLM mode ×2 services + today's usage) — lives top-right in the TopBar.
function TopBarControls() {
  const { syncLlmMode } = useNetSpec();
  const [rate, setRate] = useState<{ start_used: number; start_limit: number; iterate_used: number; iterate_limit: number } | null>(null);
  const [isApi, setIsApi] = useState(false);

  useEffect(() => {
    const check = async () => {
      try {
        const d = await fetch("/api/health").then(r => (r.ok ? r.json() : null));
        if (d) { setIsApi(d.rate_limit_mode === "api"); syncLlmMode(); }
        const rs = await fetch("/api/rate-status").then(r => (r.ok ? r.json() : null));
        if (rs) setRate(rs);
      } catch { /* leave last-known state */ }
    };
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, [syncLlmMode]);

  const startPct = rate && rate.start_limit ? Math.min((rate.start_used / rate.start_limit) * 100, 100) : 0;

  const usageColor = startPct > 80 ? "#E5604D" : startPct > 50 ? "var(--ns-amber)" : "var(--ns-accent-deep)";
  return (
    <div className="flex items-center gap-2.5 shrink-0">
      {/* 今日用量 chip（text-spec 專屬 — 每日配額只存在於文字輸入服務） */}
      {isApi && rate && (
        <span className="hidden md:flex items-center gap-2 rounded-full"
          style={{ padding: "7px 13px", background: "#fff", border: "1px solid hsl(var(--border))", fontSize: 12.5, fontWeight: 700 }}
          title={`今日用量\n分析 ${rate.start_used}/${rate.start_limit}\n迭代 ${rate.iterate_used}/${rate.iterate_limit}`}>
          <span style={{ color: "var(--ns-muted)" }}>今日</span>
          <b style={{ fontFamily: "var(--font-grotesk)", fontVariantNumeric: "tabular-nums" }}>{rate.start_used} / {rate.start_limit}</b>
          <span style={{ width: 46, height: 5, borderRadius: 5, background: "#EAEDE4", overflow: "hidden", display: "inline-block" }}>
            <span style={{ display: "block", height: "100%", width: `${startPct}%`, borderRadius: 5, background: usageColor }} />
          </span>
        </span>
      )}
      {/* LLM provider chips — one per backend service, switch independently */}
      <LlmModeChip label="文字" healthPath="/api/health" switchPath="/api/switch-mode" title="點擊切換文字輸入服務的 LLM 模式" />
      <LlmModeChip label="Figma" healthPath="/api/figma/health" switchPath="/api/figma/switch-mode" title="點擊切換 Figma 服務的 LLM 模式" />
    </div>
  );
}

function TopBar({ stepsCompleted, isSocraticActive, workflowMode, onWorkflowModeChange, showMenu, onMenuClick }: TopBarProps) {
  return (
    <header
      className="flex items-center justify-between gap-4 shrink-0 border-b"
      style={{
        height: 58,
        padding: "0 24px",
        borderColor: "hsl(var(--border))",
        background: "rgba(243,245,239,0.82)",
        backdropFilter: "blur(12px) saturate(160%)",
        WebkitBackdropFilter: "blur(12px) saturate(160%)",
        zIndex: 10,
        position: "relative",
      }}
    >
      {/* LEFT — (menu when collapsed) + workflow tabs (segmented pill, active = dark ink) */}
      <div className="flex items-center gap-3 shrink-0">
        {showMenu && (
          <button
            type="button"
            onClick={onMenuClick}
            aria-label="開啟側欄"
            className="flex items-center justify-center rounded-[10px] shrink-0 transition-colors hover:bg-black/[0.03]"
            style={{ width: 38, height: 38, background: "#fff", border: "1px solid hsl(var(--border))", color: "var(--ns-ink)" }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 18, height: 18 }}>
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}
        <div
          className="flex"
          style={{ background: "#fff", border: "1px solid hsl(var(--border))", borderRadius: 11, padding: 3 }}
        >
          {([["text", "文字輸入"], ["figma", "Figma 分析"]] as const).map(([mode, label]) => {
            const on = workflowMode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => onWorkflowModeChange(mode)}
                className="text-[13px] font-semibold transition-all select-none"
                style={{
                  padding: "7px 16px",
                  borderRadius: 8,
                  background: on ? "var(--ns-ink)" : "transparent",
                  color: on ? "#fff" : "hsl(var(--muted-foreground))",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* CENTER — high-level pipeline steps (text workflow only) */}
      {workflowMode === "text" ? (
        <div className="hidden md:flex items-center">
          {TOPBAR_STEPS.map((s, i) => {
            const state = getPhaseState(s.phase, stepsCompleted, isSocraticActive);
            const on = state === "active" || state === "done";
            const active = state === "active";
            return (
              <div key={s.label} className="flex items-center">
                <span
                  className="flex items-center gap-2 text-[12.5px] font-bold transition-colors"
                  style={{ color: on ? "hsl(var(--foreground))" : "var(--ns-muted-2)" }}
                >
                  <span
                    className="rounded-full transition-all"
                    style={{
                      width: 9,
                      height: 9,
                      background: on ? "var(--ns-accent-deep)" : "#D4D8CE",
                      boxShadow: active ? "0 0 0 4px var(--ns-accent-soft)" : "none",
                    }}
                  />
                  {s.label}
                </span>
                {i < TOPBAR_STEPS.length - 1 && (
                  <span style={{ width: 34, height: 2, borderRadius: 2, background: "hsl(var(--border))", margin: "0 12px" }} />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex-1" />
      )}

      {/* RIGHT — chips: 今日用量 + LLM provider */}
      <TopBarControls />
    </header>
  );
}

// ---------------------------------------------------------------------------
// Progress overlay
// ---------------------------------------------------------------------------

const STEP_DESC: Record<number, string> = {
  1: "分析需求文字，評估覆蓋哪些技術維度",
  2: "根據缺少的維度，生成針對性問題",
  3: "規劃要搜尋哪些關鍵字和社群來源",
  4: "從 GitHub Issues 和 HN 爬取真實故障案例",
  5: "從爬蟲資料中提取可重現的災情模式",
  6: "偵測協定競態、資源限制、異常場景",
  7: "撰寫功能需求、SLA 指標與驗收標準",
  8: "審查需求完整性、SLA 合理性、邊界覆蓋",
};

// Estimated seconds per step based on qwen2.5:7b on CPU
const STEP_EST: Record<number, number> = {
  1: 30, 2: 60, 3: 60, 4: 10, 5: 60, 6: 70, 7: 80, 8: 50,
};

interface ProgressOverlayProps {
  stepsCompleted: number;
  activeStepFromStore: number;
  isSocraticActive: boolean;
  currentThought?: string;
  logEntries?: LogEntry[];
}

function ProgressOverlay({ stepsCompleted, activeStepFromStore, isSocraticActive, currentThought, logEntries }: ProgressOverlayProps) {
  // Prefer store's activeStep (from step_start SSE) over stepsCompleted+1
  const activeStep = activeStepFromStore > 0 ? activeStepFromStore : Math.min(stepsCompleted + 1, 8);
  const progressPct = Math.round((stepsCompleted / 8) * 100);
  const estRemain = Object.entries(STEP_EST)
    .filter(([k]) => parseInt(k) > stepsCompleted)
    .reduce((s, [, v]) => s + v, 0);
  const estMin = Math.ceil(estRemain / 60);

  return (
    <div
      className="absolute inset-0 flex items-center justify-center z-20"
      style={{
        background: "rgba(248,249,250,0.97)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
      }}
    >
      <div
        className="apple-card flex flex-col gap-5"
        style={{ width: 320, padding: "28px 28px 24px" }}
      >
        {/* Header */}
        <div className="flex flex-col items-center gap-1 text-center">
          <span
            className="text-muted-foreground font-medium"
            style={{ fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase" }}
          >
            步驟 {Math.min(stepsCompleted + 1, 8)}&thinsp;/&thinsp;8
            {estMin > 0 && (
              <span style={{ fontWeight: 400, marginLeft: 6, opacity: 0.6 }}>
                · 約剩 {estMin} 分鐘
              </span>
            )}
          </span>
          <span
            className="text-foreground font-semibold mt-0.5"
            style={{ fontSize: 14, lineHeight: 1.4, letterSpacing: "-0.01em" }}
          >
            {STEP_TITLES[activeStep] ?? "處理中…"}
          </span>
          {/* Step description */}
          {STEP_DESC[activeStep] && (
            <span className="text-muted-foreground" style={{ fontSize: 12, lineHeight: 1.5 }}>
              {STEP_DESC[activeStep]}
            </span>
          )}
          {/* Agent thought — dynamic per-step */}
          {currentThought && (
            <div className="w-full flex items-start gap-2 px-3 py-2 rounded-xl mt-1"
              style={{ background: "rgba(107,92,240,0.06)", border: "1px solid rgba(107,92,240,0.14)" }}>
              <span className="shrink-0 text-[13px] animate-pulse">🤔</span>
              <span style={{ fontSize: 11, color: "#6B5CF0", lineHeight: 1.6, textAlign: "left", fontStyle: "italic" }}>
                {currentThought}
              </span>
            </div>
          )}
        </div>

        {/* Thin progress bar */}
        <div className="flex flex-col gap-1.5">
          <div
            className="w-full rounded-full overflow-hidden"
            style={{ height: 3, background: "rgba(0,0,0,0.07)" }}
          >
            <div
              className="h-full rounded-full transition-all duration-700 ease-out"
              style={{
                width: `${progressPct}%`,
                background: "#6B5CF0",
              }}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="font-mono text-muted-foreground" style={{ fontSize: 10 }}>
              {progressPct}%
            </span>
            {stepsCompleted >= 4 && stepsCompleted <= 5 && (
              <span style={{ fontSize: 10, color: "#8b5cf6", fontWeight: 500 }}>
                社群資料爬取中…
              </span>
            )}
          </div>
        </div>

        {/* 3 phase labels */}
        <div className="flex items-center justify-between pt-0.5">
          {PHASES.map((phase) => {
            const state = getPhaseState(phase, stepsCompleted, isSocraticActive);
            const isDone = state === "done";
            const isActive = state === "active";

            return (
              <div key={phase.label} className="flex flex-col items-center gap-1.5">
                <span
                  className="relative flex items-center justify-center"
                  style={{ width: 10, height: 10 }}
                >
                  {isActive && (
                    <span
                      className="absolute inset-0 rounded-full animate-ping"
                      style={{
                        backgroundColor: phase.color,
                        opacity: 0.4,
                        animationDuration: "1.4s",
                      }}
                    />
                  )}
                  <span
                    className="rounded-full transition-all duration-500"
                    style={{
                      width: 9,
                      height: 9,
                      backgroundColor:
                        isDone || isActive ? phase.color : "rgba(0,0,0,0.1)",
                    }}
                  />
                </span>
                <span
                  className="font-medium"
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.03em",
                    color: isDone || isActive ? phase.color : "rgba(0,0,0,0.28)",
                  }}
                >
                  {phase.label}
                </span>
              </div>
            );
          })}
        </div>

        {/* Live findings feed — watch the agents actually work (newest brightest) */}
        {logEntries && logEntries.length > 0 && (
          <div className="flex flex-col gap-1 pt-3" style={{ borderTop: "1px solid rgba(0,0,0,0.06)" }}>
            <span className="font-medium" style={{ fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(0,0,0,0.32)" }}>
              即時發現
            </span>
            {logEntries.slice(-4).map((e, i, arr) => {
              const meta = resolveAgentMeta(e.agent);
              const op = arr.length <= 1 ? 1 : 0.4 + 0.6 * (i / (arr.length - 1));
              return (
                <div key={`${e.time}-${i}`} className="flex items-center gap-1.5" style={{ opacity: op, transition: "opacity .4s ease" }}>
                  <span className="shrink-0 rounded-full" style={{ width: 5, height: 5, background: meta.color }} />
                  <span className="flex-1 min-w-0 truncate leading-snug" style={{ fontSize: 10.5, color: "#3a3a3c" }} title={e.text}>
                    {e.text}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LogPanel
// ---------------------------------------------------------------------------

interface LogEntry {
  time: string;
  agent: string;
  text: string;
}

interface LogPanelProps {
  logEntries: LogEntry[];
}

// Agent → color/label mapping
const AGENT_META: Record<string, { color: string; bg: string; label: string }> = {
  "qwen2.5":          { color: "#6B5CF0", bg: "rgba(107,92,240,0.10)",   label: "LLM" },
  "claude":           { color: "#8b5cf6", bg: "rgba(139,92,246,0.10)",  label: "LLM" },
  "playwright":       { color: "#f59e0b", bg: "rgba(245,158,11,0.10)",  label: "爬蟲" },
  "kimi":             { color: "#8b5cf6", bg: "rgba(139,92,246,0.10)",  label: "LLM" },
  "gpt":              { color: "#34c759", bg: "rgba(52,199,89,0.10)",   label: "LLM" },
};

function resolveAgentMeta(agent: string) {
  const key = agent.toLowerCase();
  for (const [k, v] of Object.entries(AGENT_META)) {
    if (key.includes(k)) return { ...v, name: agent };
  }
  return { color: "#6b7280", bg: "rgba(107,114,128,0.10)", label: "Agent", name: agent };
}

function LogPanel({ logEntries }: LogPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logEntries]);

  return (
    <div className="w-full max-w-[1400px] mx-auto flex flex-col gap-4">
      {/* ── Header (Astra style — matches 需求輸入 / 規格輸出) ── */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="space-y-1.5">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-[26px] font-extrabold tracking-[-0.03em] text-foreground leading-none">研究日誌</h2>
            <span className="text-[11px] font-bold px-2.5 py-1 rounded-full leading-none"
              style={{ color: "var(--ns-violet)", background: "var(--ns-violet-soft)", border: "1px solid #DAD5F7" }}>
              LOG
            </span>
          </div>
          <p className="text-[14px] text-muted-foreground leading-relaxed">Pipeline 各 Agent 執行記錄</p>
        </div>
        {logEntries.length > 0 && (
          <span className="text-[12px] text-muted-foreground/50 pb-0.5" style={{ fontFamily: "var(--font-grotesk)" }}>
            {logEntries.length} 筆記錄
          </span>
        )}
      </div>

      <div className="rounded-2xl overflow-hidden"
        style={{ border: "1px solid hsl(var(--border))", background: "hsl(var(--card))", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        <ScrollArea style={{ height: "calc(100vh - 230px)" }}>
          {logEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3 select-none">
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center"
                style={{ background: "hsl(var(--muted))" }}>
                <span style={{ fontSize: 22, opacity: 0.4 }}>📋</span>
              </div>
              <p className="text-[13px] text-muted-foreground">Pipeline 執行後，日誌將在此顯示</p>
            </div>
          ) : (
            <div className="divide-y divide-[hsl(var(--border))]">
              {logEntries.map((entry, idx) => {
                const meta = resolveAgentMeta(entry.agent);
                const isLast = idx === logEntries.length - 1;
                return (
                  <div key={idx}
                    className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-black/[0.015] group"
                    style={isLast ? { background: "rgba(107,92,240,0.02)" } : undefined}>
                    {/* Index */}
                    <span className="shrink-0 font-mono tabular-nums select-none"
                      style={{ fontSize: 10, color: "hsl(var(--muted-foreground))", opacity: 0.35, minWidth: 24, paddingTop: 2 }}>
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    {/* Agent badge */}
                    <div className="shrink-0 flex flex-col items-center gap-0.5 pt-0.5">
                      <span className="rounded-md px-1.5 font-semibold uppercase"
                        style={{ fontSize: 8.5, height: 16, lineHeight: "16px", display: "block",
                                 letterSpacing: "0.06em", color: meta.color, background: meta.bg }}>
                        {meta.label}
                      </span>
                    </div>
                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-medium truncate" style={{ fontSize: 11.5, color: meta.color }}>
                          {entry.agent}
                        </span>
                        <span className="font-mono tabular-nums shrink-0"
                          style={{ fontSize: 10, color: "hsl(var(--muted-foreground))", opacity: 0.45 }}>
                          {entry.time}
                        </span>
                        {isLast && (
                          <span className="shrink-0 rounded-full px-1.5 py-px font-semibold"
                            style={{ fontSize: 8.5, background: "rgba(107,92,240,0.10)", color: "#6B5CF0" }}>
                            最新
                          </span>
                        )}
                      </div>
                      <p className="text-[12px] leading-relaxed break-words"
                        style={{ color: "hsl(var(--foreground) / 0.75)" }}>
                        {entry.text}
                      </p>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} className="h-px" />
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Home() {
  const {
    status,
    error,
    rateLimitState,
    stepsCompleted,
    activeStep,
    requirement: storedRequirement,
    backendClarityScore,
    currentInterruptType,
    currentInterruptData,
    result,
    iterations,
    currentIteration,
    logEntries,
    resumeSocratic,
    proceedFromSocratic,
    skipSocratic,
    continueMoreQuestions,
    confirmPlan,
    triggerIteration,
    loadIteration,
    loadHistorySession,
    resetToHome,
    loadedHistoryId,
    startAnalysis,
    lastSocraticData,
    currentThought,
    thoughtHistory,
    toolCalls,
    stepAgents,
    llmMode,
  } = useNetSpec();

  const [currentPanel, setCurrentPanel] = useState<PanelId>("input");
  // Skip landing when ?enter=1 or running inside Databricks Apps (NEXT_PUBLIC_API_URL set)
  const [showLanding, setShowLanding] = useState(() => {
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      if (p.get("enter") === "1") return false;
    }
    return !process.env.NEXT_PUBLIC_SKIP_LANDING;
  });
  const [workflowMode, setWorkflowMode] = useState<"text" | "figma">("text");
  // Responsive sidebar: auto-collapse to an overlay below 1100px so the main area can go full-width.
  const [narrow, setNarrow] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [figmaData, setFigmaData] = useState<{
    fileKey: string; fileName: string;
    frames: FigmaFrameListResult["frames"];
    // present only when loaded from history → FigmaStoryPanel boots into done phase
    initialDone?: {
      cacheKey: string;
      versionNum: number;
      roles: string[];
      features: { id: string; name: string; description: string }[];
      stories: Record<string, Record<string, string>>;
    };
  } | null>(null);
  const [loadedFigmaId, setLoadedFigmaId] = useState<string | null>(null);

  // isSocraticActive: true whenever the pipeline is executing steps 1-2 (Phase 1).
  // This covers:
  //   - step_start for step 1 or 2 (activeStep <= 2)
  //   - interrupted state waiting for socratic answers
  //   - running state between socratic rounds (user submitted, next round pending)
  // It becomes false only when step_start for step 3+ fires (plan_search etc.)
  const isSocraticActive =
    (status === "running" || status === "interrupted") &&
    activeStep <= 2 &&
    activeStep > 0;

  // One page_view per mount, and keep the ambient workflow tag in sync so every
  // later event says which half of the product it came from.
  useEffect(() => {
    track("page_view", { view: showLanding ? "landing" : "app", workflow: workflowMode });
    // Intentionally mount-only: this is the arrival event, not a re-render event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setWorkflow(workflowMode);
  }, [workflowMode]);

  // Auto-collapse the sidebar (→ overlay) when the viewport gets narrow.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1100px)");
    const apply = () => { setNarrow(mq.matches); if (!mq.matches) setMobileSidebarOpen(false); };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // After Figma OAuth, the backend redirects to /?figma_connected=1 — a full
  // document load that resets React state to workflowMode="text". Restore Figma
  // mode here (page.tsx owns workflowMode, which gates InputPanel's OAuth-status
  // effect). The param is left in the URL so InputPanel's now-active effect can
  // strip it and refetch the connection status.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("figma_connected") === "1") {
      track("figma_oauth_returned", { connected: true });
      setWorkflowMode("figma");
      setCurrentPanel("input");
    }
  }, []);

  // Auto-switch panels on status transitions (text workflow only)
  useEffect(() => {
    if (workflowMode !== "text") return;
    if (status === "interrupted") {
      setCurrentPanel("input");          // socratic / plan-confirm UI lives in the input panel
    } else if (status === "complete") {
      setCurrentPanel("results");
    } else if (status === "error") {
      // Show the progress panel (which step failed + reason) instead of dumping the
      // user back to the blank input form, which looked like the run silently vanished.
      setCurrentPanel("pipeline");
    } else if (status === "running" && activeStep >= 3) {
      // Past Socratic (steps 3-8) → follow live progress instead of sitting on input.
      setCurrentPanel("pipeline");
    }
  }, [status, workflowMode, activeStep]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Esc: ONLY for Socratic interrupt — never fire during plan_confirm or other states
      if (e.key === "Escape" && status === "interrupted" && currentInterruptType === "socratic") {
        e.preventDefault();
        if (currentInterruptData && "threshold_met" in currentInterruptData && currentInterruptData.threshold_met) {
          proceedFromSocratic();
        } else {
          skipSocratic();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [status, currentInterruptType, currentInterruptData, proceedFromSocratic, skipSocratic]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleExportMd = () => {
    if (!result?.spec_document) return;
    // Exporting is the strongest signal a spec was actually useful to someone.
    track("spec_exported", {
      format: "md",
      iteration: currentIteration,
      chars: result.spec_document.length,
      quality_score: result.validation_score ?? null,
    });
    const blob = new Blob([result.spec_document], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const featureName =
      result.spec_sections?.feature_name?.replace(/\s+/g, "_") || "spec";
    a.download = `${featureName}_v${currentIteration}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleWorkflowModeChange = (mode: "text" | "figma") => {
    track("workflow_switched", { from: workflowMode, to: mode });
    setWorkflowMode(mode);
    setCurrentPanel("input");
  };

  const handlePanelChange = (panel: string) => {
    // Which panels users actually open — and which they never do — is the
    // "which features go unused" question the PoC is meant to answer.
    track("panel_viewed", { panel, from: currentPanel, workflow: workflowMode });
    setCurrentPanel(panel as PanelId);
  };

  const handleStart = (requirement: string, detailLevel?: string) => {
    startAnalysis(requirement, detailLevel);
  };

  const handleFigmaLoaded = (fileKey: string, fileName: string, frames: FigmaFrameListResult["frames"]) => {
    track("figma_frames_loaded", { file_key: fileKey, frame_count: frames.length });
    setFigmaData({ fileKey, fileName, frames });
  };

  const handleStartStory = (fileKey: string, fileName: string, frames: FigmaFrameListResult["frames"]) => {
    track("figma_story_started", { file_key: fileKey, frame_count: frames.length });
    setFigmaData({ fileKey, fileName, frames });
    setLoadedFigmaId(null);   // fresh generation, not a history view
    setCurrentPanel("story");
  };

  // Load a Figma story session from history → boot FigmaStoryPanel into done phase
  const handleLoadFigmaHistory = async (sessionId: string) => {
    try {
      const versions = await fetch(`/api/figma/history/${sessionId}/versions`)
        .then(r => (r.ok ? r.json() : []));
      if (!Array.isArray(versions) || versions.length === 0) return;
      const latest = versions[versions.length - 1];
      const v = await fetch(`/api/figma/history/${sessionId}/versions/${latest.version_num}`)
        .then(r => (r.ok ? r.json() : null));
      if (!v) return;
      const frames = (v.frame_ids ?? []).map((id: string, i: number) => ({
        page: "", frame_id: id, frame_name: (v.frame_names ?? [])[i] ?? id, text_count: 0,
      }));
      setFigmaData({
        fileKey: v.file_key ?? "",
        fileName: v.file_name ?? "",
        frames,
        initialDone: {
          cacheKey: sessionId,
          versionNum: v.version_num,
          roles: v.roles ?? [],
          features: v.features ?? [],
          stories: v.stories ?? {},
        },
      });
      setLoadedFigmaId(sessionId);
      setWorkflowMode("figma");
      setCurrentPanel("story");
      track("figma_history_opened", {
        version_count: versions.length,
        version_num: v.version_num,
        role_count: (v.roles ?? []).length,
        feature_count: (v.features ?? []).length,
      });
    } catch { /* ignore */ }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Sidebar element — reused inline (wide) or inside the overlay (narrow).
  const sidebarEl = (
    <AppSidebar
      currentPanel={currentPanel}
      onPanelChange={(p) => { handlePanelChange(p); setMobileSidebarOpen(false); }}
      workflowMode={workflowMode}
      onWorkflowModeChange={handleWorkflowModeChange}
      iterations={iterations}
      currentIteration={currentIteration}
      onLoadIteration={(n) => { loadIteration(n); setCurrentPanel("results"); setMobileSidebarOpen(false); }}
      onLoadHistorySession={(id) => { loadHistorySession(id); setCurrentPanel("results"); setMobileSidebarOpen(false); }}
      onLoadFigmaHistory={(id) => { handleLoadFigmaHistory(id); setMobileSidebarOpen(false); }}
      loadedFigmaId={loadedFigmaId}
      onResetToHome={() => { resetToHome(); setCurrentPanel("input"); setMobileSidebarOpen(false); }}
      onGoLanding={() => { track("landing_opened", { from: currentPanel }); setShowLanding(true); setMobileSidebarOpen(false); }}
      loadedHistoryId={loadedHistoryId}
      stepsCompleted={stepsCompleted}
      status={status}
    />
  );

  return (
    <>
      {showLanding ? (
        <LandingPage onEnter={() => { track("landing_entered"); setShowLanding(false); }} />
      ) : (
        <div className="flex overflow-hidden" style={{ height: "100dvh" }}>
      {/* ── Sidebar: inline when wide; overlay drawer when narrow ── */}
      {!narrow && sidebarEl}
      {narrow && mobileSidebarOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="absolute inset-0" style={{ background: "rgba(15,19,24,0.45)" }}
               onClick={() => setMobileSidebarOpen(false)} />
          <div className="relative z-10 h-full shadow-2xl">{sidebarEl}</div>
        </div>
      )}

      {/* ── Main column ── */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* TopBar: (menu) · workflow tabs · pipeline steps · chips */}
        <TopBar
          currentPanel={currentPanel}
          stepsCompleted={stepsCompleted}
          isSocraticActive={isSocraticActive}
          specDocument={result?.spec_document ?? null}
          onExportMd={handleExportMd}
          workflowMode={workflowMode}
          onWorkflowModeChange={handleWorkflowModeChange}
          showMenu={narrow}
          onMenuClick={() => setMobileSidebarOpen(true)}
        />

        {/* Content area: relative for overlay positioning */}
        <div className="relative flex-1 min-h-0 overflow-hidden">
          {/* Progress overlay when running */}
          {status === "running" && (
            <ProgressOverlay
              stepsCompleted={stepsCompleted}
              activeStepFromStore={activeStep}
              isSocraticActive={isSocraticActive}
              currentThought={currentThought}
              logEntries={logEntries}
            />
          )}

          <ScrollArea className="h-full">
            <div className="px-8 py-7">
              {currentPanel === "input" && (
                <InputPanel
                  onStart={handleStart}
                  status={status}
                  storedRequirement={storedRequirement}
                  backendClarityScore={backendClarityScore}
                  interruptType={currentInterruptType}
                  interruptData={currentInterruptData}
                  onSubmitAnswers={resumeSocratic}
                  onProceed={proceedFromSocratic}
                  onSkip={skipSocratic}
                  onContinueMoreQuestions={continueMoreQuestions}
                  onConfirmInput={() => {}}
                  onBackToSocratic={() => {}}
                  onConfirmPlan={confirmPlan}
                  lastSocraticData={lastSocraticData}
                  onFigmaLoaded={handleFigmaLoaded}
                  onStartStory={handleStartStory}
                  workflowMode={workflowMode}
                  llmMode={llmMode}
                />
              )}

              {currentPanel === "pipeline" && workflowMode === "text" && (
                <PipelinePanel
                  status={status}
                  stepsCompleted={stepsCompleted}
                  toolCalls={toolCalls}
                  currentThought={currentThought}
                  thoughtHistory={thoughtHistory}
                  stepAgents={stepAgents}
                  llmMode={llmMode}
                  onRestart={() => { resetToHome(); setCurrentPanel("input"); }}
                />
              )}

              {currentPanel === "results" && (
                <ResultsPanel
                  result={result}
                  currentIteration={currentIteration}
                  onIterate={triggerIteration}
                  status={status}
                  error={error}
                  rateLimitState={rateLimitState}
                />
              )}

              {currentPanel === "story" && figmaData && (
                <FigmaStoryPanel
                  key={figmaData.initialDone?.cacheKey ?? "live"}
                  figmaData={figmaData}
                  onOpenHistory={handleLoadFigmaHistory}
                />
              )}
              {currentPanel === "story" && !figmaData && (
                <div className="flex flex-col items-center justify-center select-none"
                  style={{ minHeight: 480, padding: "48px 24px" }}>

                  {/* Central illustration */}
                  <div className="relative mb-8">
                    <div className="absolute inset-0 rounded-3xl"
                      style={{ background: "radial-gradient(circle, rgba(139,92,246,0.08) 0%, transparent 70%)", transform: "scale(2.5)" }} />
                    <div className="relative flex items-center justify-center rounded-3xl"
                      style={{ width: 80, height: 80, background: "linear-gradient(135deg, #f5f3ff 0%, #ede9fe 100%)", border: "1px solid rgba(139,92,246,0.15)", boxShadow: "0 4px 24px rgba(139,92,246,0.12)" }}>
                      <BookText style={{ width: 36, height: 36, color: "#8b5cf6", opacity: 0.85 }} strokeWidth={1.5} />
                    </div>
                  </div>

                  {/* Heading */}
                  <div className="text-center mb-10">
                    <h2 className="font-semibold tracking-tight" style={{ fontSize: 20, color: "hsl(var(--foreground))", letterSpacing: "-0.3px" }}>
                      User Story 將在這裡顯示
                    </h2>
                    <p className="mt-2" style={{ fontSize: 13.5, color: "hsl(var(--muted-foreground))", lineHeight: 1.6 }}>
                      連接 Figma 設計稿後，AI 將分析畫面並生成結構化 User Story
                    </p>
                  </div>

                  {/* Flow steps */}
                  <div className="flex items-stretch gap-0 max-w-[560px] w-full">
                    {([
                      { Icon: Layers,       title: "載入設計稿", desc: "連接 Figma 檔案\n選取要分析的 Frame",    color: "#6B5CF0", bg: "rgba(107,92,240,0.08)",    border: "rgba(107,92,240,0.15)"    },
                      { Icon: MessageCircle,title: "AI 澄清追問", desc: "引導式問答\n補充功能背景與目標",        color: "#8b5cf6", bg: "rgba(139,92,246,0.08)",  border: "rgba(139,92,246,0.15)"  },
                      { Icon: ListChecks,   title: "確認功能清單",desc: "審閱 AI 萃取的\n功能點與範圍",          color: "#f59e0b", bg: "rgba(245,158,11,0.08)",  border: "rgba(245,158,11,0.18)"  },
                      { Icon: BookText,     title: "生成 Story",  desc: "PM User Story\n＋ 驗收標準（AC）",  color: "#22c55e", bg: "rgba(34,197,94,0.08)",   border: "rgba(34,197,94,0.18)"   },
                    ] as const).map((s, i, arr) => (
                      <div key={i} className="flex items-stretch gap-0 flex-1 min-w-0">
                        <div className="flex-1 flex flex-col items-center gap-2 px-3 py-4 rounded-2xl text-center"
                          style={{ background: s.bg, border: `1px solid ${s.border}` }}>
                          <div className="flex items-center justify-center rounded-xl shrink-0"
                            style={{ width: 36, height: 36, background: "rgba(255,255,255,0.7)", border: `1px solid ${s.border}` }}>
                            <s.Icon style={{ width: 16, height: 16, color: s.color }} strokeWidth={2} />
                          </div>
                          <span className="font-semibold leading-none" style={{ fontSize: 12, color: s.color }}>{s.title}</span>
                          <span style={{ fontSize: 10.5, color: "hsl(var(--muted-foreground))", lineHeight: 1.5, whiteSpace: "pre-line" }}>{s.desc}</span>
                        </div>
                        {i < arr.length - 1 && (
                          <div className="flex items-center px-1 shrink-0">
                            <ArrowRight style={{ width: 12, height: 12, color: "hsl(var(--muted-foreground))", opacity: 0.35 }} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Hint */}
                  <p className="mt-8" style={{ fontSize: 12, color: "hsl(var(--muted-foreground))", opacity: 0.5 }}>
                    前往「Figma 輸入」連接設計稿，再切換至此頁面 →
                  </p>
                </div>
              )}

              {currentPanel === "log" && workflowMode === "text" && (
                <LogPanel logEntries={logEntries} />
              )}

              {currentPanel === "monitor" && <FigmaMonitorPanel />}
            </div>
          </ScrollArea>
        </div>
      </div>
        </div>
      )}
    </>
  );
}
