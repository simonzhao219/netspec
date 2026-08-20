"use client";

import { useRef, useState } from "react";
import { SocraticInterrupt } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ArrowRight, SkipForward } from "lucide-react";

interface SocraticCardProps {
  data: SocraticInterrupt;
  onSubmit: (answers: Record<string, string>) => void;
  onProceed: () => void;
  onSkip: () => void;
}

export default function SocraticCard({
  data,
  onSubmit,
  onProceed,
  onSkip,
}: SocraticCardProps) {
  const refs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [emptyWarning, setEmptyWarning] = useState(false);
  // Track which questions have "不適用" explicitly selected
  const [naQuestions, setNaQuestions] = useState<Set<string>>(new Set());

  const markNA = (key: string) =>
    setNaQuestions(prev => new Set([...prev, key]));

  const unmarkNA = (key: string) =>
    setNaQuestions(prev => { const s = new Set(prev); s.delete(key); return s; });

  const collect = () => {
    const a: Record<string, string> = {};
    data.questions.forEach((q) => {
      // N/A selections are treated as "不適用" rather than blank
      a[q.key] = naQuestions.has(q.key)
        ? "不適用"
        : (refs.current[q.key]?.value?.trim() ?? "");
    });
    return a;
  };

  const handleSubmit = () => {
    const answers = collect();

    // If ALL questions are explicitly marked N/A → treat as "skip all"
    // (don't submit N/A to backend; it would loop back to another Socratic round)
    if (naQuestions.size > 0 && naQuestions.size >= data.questions.length) {
      onSkip();
      return;
    }

    // Need at least one answer with content ("不適用" counts — user explicitly skipped)
    const hasAny = Object.values(answers).some(v => v.length > 0);
    if (!hasAny) {
      setEmptyWarning(true);
      setTimeout(() => setEmptyWarning(false), 2500);
      return;
    }
    setEmptyWarning(false);
    onSubmit(answers);
  };

  /* ── score colour helpers ── */
  const scoreColor = data.threshold_met
    ? "#34c759"
    : data.clarity_score >= 40
    ? "#f59e0b"
    : "#8e8e93";

  const scoreBg = data.threshold_met
    ? "rgba(52,199,89,0.10)"
    : data.clarity_score >= 40
    ? "rgba(245,158,11,0.10)"
    : "rgba(142,142,147,0.10)";

  /* ── pip helpers ── */
  const pip = (filled: boolean, isCurrent: boolean) => ({
    width: isCurrent ? 20 : 8,
    height: 8,
    borderRadius: 9999,
    background: filled ? "#6B5CF0" : "hsl(var(--muted))",
    boxShadow: isCurrent ? "0 0 0 3px rgba(107,92,240,0.18)" : undefined,
    transition: "all 0.3s ease",
    flexShrink: 0,
  } as React.CSSProperties);

  return (
    <div
      className="rounded-2xl overflow-hidden w-full relative"
      style={{
        background: "#ffffff",
        border: "1px solid hsl(var(--border))",
        boxShadow:
          "0 1px 3px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04)",
      }}
    >
      {/* ════════════════ HEADER ════════════════ */}
      <div
        className="px-5 pt-4 pb-3 space-y-3"
        style={{ borderBottom: "1px solid hsl(var(--border))" }}
      >
        {/* Row 1: pips + round label */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* progress pips */}
            <div className="flex items-center gap-1">
              {Array.from({ length: data.max_rounds }, (_, i) => {
                const filled = i < data.round;
                const isCurrent = i === data.round - 1;
                return <span key={i} style={pip(filled, isCurrent)} />;
              })}
            </div>

            {/* label */}
            <span className="text-[12px] leading-none text-muted-foreground">
              <span className="text-foreground font-semibold">
                第 {data.round} 輪
              </span>
              {data.is_last_round ? (
                <span
                  className="ml-1.5 text-[11px] font-medium rounded-full px-2 py-0.5 inline-block"
                  style={{ background: "rgba(107,92,240,0.08)", color: "#6B5CF0" }}
                >
                  最後一輪
                </span>
              ) : (
                <span className="ml-1">／{data.max_rounds}</span>
              )}
            </span>
          </div>

          {/* AI badge */}
          <span
            className="text-[10px] font-bold tracking-widest uppercase px-2 py-1 rounded-full"
            style={{ background: "rgba(107,92,240,0.06)", color: "#6B5CF0" }}
          >
            Socratic
          </span>
        </div>

        {/* Row 2: thin score bar */}
        <div className="flex items-center gap-2.5">
          <span className="text-[11px] text-muted-foreground shrink-0">
            清晰度
          </span>

          {/* track */}
          <div
            className="flex-1 rounded-full overflow-hidden"
            style={{ height: 4, background: "hsl(var(--muted))" }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${data.clarity_score}%`,
                background: scoreColor,
                transition: "width 0.6s cubic-bezier(0.4,0,0.2,1)",
              }}
            />
          </div>

          {/* numeric */}
          <span
            className="text-[12px] font-bold font-mono tabular-nums shrink-0"
            style={{ color: scoreColor, minWidth: 28, textAlign: "right" }}
          >
            {data.clarity_score}
          </span>

          {/* status chip */}
          <span
            className="text-[11px] font-semibold shrink-0 px-2 py-0.5 rounded-full"
            style={{ background: scoreBg, color: scoreColor }}
          >
            {data.threshold_met ? "✓ 達標" : "需 70"}
          </span>
        </div>
      </div>

      {/* ════════════════ QUESTIONS ════════════════ */}
      <div className="px-5 py-4 space-y-3">
        {data.questions.map((q, idx) => (
          <div
            key={q.key}
            className="rounded-xl p-4 space-y-2.5"
            style={{ background: "hsl(var(--muted)/40)", border: "1px solid hsl(var(--border))" }}
          >
            {/* Q badge + question */}
            <div className="flex items-start gap-2.5">
              <span
                className="mt-0.5 shrink-0 inline-flex items-center justify-center rounded-full text-[11px] font-bold text-white leading-none"
                style={{ background: "#6B5CF0", width: 20, height: 20, minWidth: 20 }}
              >
                {idx + 1}
              </span>
              <p className="text-[13px] font-medium leading-snug text-foreground">{q.question}</p>
            </div>

            {/* Rationale */}
            {q.why_critical && (
              <p className="text-[11px] italic leading-relaxed pl-7" style={{ color: "hsl(var(--muted-foreground))" }}>
                {q.why_critical}
              </p>
            )}

            {/* Textarea */}
            <div className="pl-7">
              {/* SKILL 💡 options as radio-button style cards */}
              {q.options && q.options.length > 0 && (
                <div className="mb-2.5 space-y-1.5">
                  <span className="text-[10px] font-semibold text-muted-foreground/70 tracking-wide uppercase">💡 常見選項</span>
                  <div className="flex flex-col gap-1.5">
                    {[...q.options, "不適用，跳過此題"].map((opt, oi) => {
                      const isNA = opt === "不適用，跳過此題";
                      return (
                        <button
                          key={oi}
                          type="button"
                          onClick={() => {
                            const ta = refs.current[q.key];
                            if (ta) {
                              if (isNA) {
                                // Clear textarea + mark N/A
                                const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
                                setter?.call(ta, "");
                                ta.dispatchEvent(new Event("input", { bubbles: true }));
                                markNA(q.key);
                              } else {
                                // Select a real option → clear N/A state
                                const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
                                setter?.call(ta, opt);
                                ta.dispatchEvent(new Event("input", { bubbles: true }));
                                unmarkNA(q.key);
                              }
                              // Highlight selected button
                              document.querySelectorAll(`[data-opt-key="${q.key}"]`).forEach((el: any) => {
                                el.style.background = "rgba(107,92,240,0.04)";
                                el.style.borderColor = "rgba(107,92,240,0.15)";
                                el.style.color = "#6B5CF0";
                              });
                              const btn = document.querySelector(`[data-opt-key="${q.key}"][data-opt-idx="${oi}"]`) as HTMLElement;
                              if (btn) {
                                btn.style.background = isNA ? "rgba(142,142,147,0.08)" : "rgba(107,92,240,0.10)";
                                btn.style.borderColor = isNA ? "#8e8e93" : "#6B5CF0";
                                btn.style.color = isNA ? "#8e8e93" : "#6B5CF0";
                              }
                            }
                          }}
                          data-opt-key={q.key}
                          data-opt-idx={oi}
                          className="w-full text-left rounded-xl px-3 py-2 text-[12.5px] font-medium transition-all duration-100 active:scale-[0.99]"
                          style={{
                            background: "rgba(107,92,240,0.04)",
                            color: isNA ? "hsl(var(--muted-foreground))" : "#6B5CF0",
                            border: `1px solid ${isNA ? "hsl(var(--border))" : "rgba(107,92,240,0.15)"}`,
                            cursor: "pointer",
                            fontFamily: "inherit",
                            fontStyle: isNA ? "italic" : "normal",
                          }}
                        >
                          {isNA ? "— " : ""}
                          {opt}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* N/A badge — shown when this question is skipped */}
              {naQuestions.has(q.key) && (
                <div className="mb-2 flex items-center gap-2 px-3 py-1.5 rounded-xl"
                  style={{ background: "rgba(142,142,147,0.08)", border: "1px solid rgba(142,142,147,0.2)" }}>
                  <span style={{ fontSize: 11 }}>✓</span>
                  <span style={{ fontSize: 11.5, color: "#8e8e93", fontStyle: "italic" }}>已標記為不適用，此題將跳過</span>
                  <button type="button" onClick={() => unmarkNA(q.key)}
                    className="ml-auto text-[10px] px-1.5 py-0.5 rounded transition-colors hover:bg-black/[0.05]"
                    style={{ color: "#8e8e93", cursor: "pointer" }}>
                    取消
                  </button>
                </div>
              )}

              <textarea
                ref={(el) => { refs.current[q.key] = el; }}
                rows={2}
                placeholder={naQuestions.has(q.key) ? "（此題已跳過）" : (q.closing || "點選上方選項，或自行輸入…")}
                disabled={naQuestions.has(q.key)}
                onInput={() => unmarkNA(q.key)}
                className={cn(
                  "w-full resize-none text-[13px] leading-relaxed rounded-xl px-3 py-2.5 outline-none transition-all duration-150",
                  "placeholder:text-muted-foreground/35 placeholder:italic",
                  "border focus:border-[#6B5CF0] focus:ring-2 focus:ring-[#6B5CF0]/15",
                  naQuestions.has(q.key) && "opacity-40 cursor-not-allowed"
                )}
                style={{ background: "#ffffff", borderColor: "hsl(var(--border))", color: "hsl(var(--foreground))", fontFamily: "inherit" }}
              />

              {/* example_answer chip (when no SKILL options) */}
              {(!q.options || q.options.length === 0) && q.example_answer && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <span className="text-[10px] text-muted-foreground/60 self-center shrink-0">推薦：</span>
                  {q.example_answer.split(/[、\/,]/).map((s, si) => {
                    const v = s.trim();
                    if (!v) return null;
                    return (
                      <button key={si} type="button"
                        onClick={() => {
                          const ta = refs.current[q.key];
                          if (ta) { ta.value = v; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.focus(); }
                        }}
                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg active:scale-95"
                        style={{ background: "rgba(107,92,240,0.07)", color: "#6B5CF0", border: "1px solid rgba(107,92,240,0.18)", cursor: "pointer", fontFamily: "inherit" }}
                      >
                        <span style={{ opacity: 0.6, fontSize: 9 }}>↵</span>{v}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* SKILL closing sentence */}
              {q.closing && (
                <p className="mt-1.5 text-[11px] italic" style={{ color: "hsl(var(--muted-foreground))" }}>
                  {q.closing}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ════════════════ FOOTER ════════════════ */}
      {emptyWarning && (
        <div className="mx-5 mb-0 px-3 py-2 rounded-lg text-[12px] text-amber-700 font-medium"
          style={{ background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.2)" }}>
          請至少回答一題（可選擇「不適用」標記跳過），或點「直接跳過」略過所有追問
        </div>
      )}
      <div
        className="px-5 py-3 flex items-center gap-2"
        style={{
          borderTop: "1px solid hsl(var(--border))",
          background: "#fafafa",
        }}
      >
        {/* Esc shortcut hint */}
        <span className="absolute bottom-3 right-4 text-[10px] text-muted-foreground/30 select-none pointer-events-none">
          Esc 跳過
        </span>
        {data.is_last_round ? (
          /* ── 最後一輪：只有提交，自動進入下一步 ── */
          <button
            onClick={handleSubmit}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[13px] font-semibold text-white transition-opacity hover:opacity-90 active:opacity-80"
            style={{ background: "#6B5CF0" }}
          >
            <ArrowRight className="w-3.5 h-3.5 shrink-0" />
            提交回答（最後一輪）
          </button>
        ) : data.threshold_met ? (
          /* ── 已達標：進入下一步（主）、繼續追問（次）、直接跳過（輔） ── */
          <div className="flex flex-col gap-2 w-full">
            <div className="flex gap-2">
              <button
                onClick={onProceed}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
                style={{ background: "#34c759" }}
              >
                <ArrowRight className="w-3.5 h-3.5 shrink-0" />
                進入下一步
              </button>
              <button
                onClick={handleSubmit}
                className="flex-1 py-2.5 rounded-xl text-[13px] font-medium border transition-colors hover:bg-black/[0.04]"
                style={{ borderColor: "hsl(var(--border))", color: "hsl(var(--foreground))", background: "transparent" }}
              >
                繼續追問
              </button>
            </div>
            <button
              onClick={onSkip}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-xl text-[12px] transition-colors hover:bg-black/[0.04]"
              style={{ color: "hsl(var(--muted-foreground))", background: "transparent" }}
            >
              <SkipForward className="w-3 h-3 shrink-0" />
              直接跳過，略過所有追問
            </button>
          </div>
        ) : (
          /* ── 未達標：提交回答（主）、直接跳過（次） ── */
          <>
            <button
              onClick={handleSubmit}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
              style={{ background: "#6B5CF0" }}
            >
              提交回答
            </button>
            <button
              onClick={onSkip}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-[13px] font-medium border transition-colors hover:bg-black/[0.04] hover:text-foreground"
              style={{ borderColor: "hsl(var(--border))", color: "hsl(var(--muted-foreground))", background: "transparent" }}
            >
              <SkipForward className="w-3.5 h-3.5 shrink-0" />
              直接跳過
            </button>
          </>
        )}
      </div>
    </div>
  );
}
