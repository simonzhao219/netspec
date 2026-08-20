"use client";

import { PlanConfirmInterrupt } from "@/lib/types";
import { CheckCircle2 } from "lucide-react";

interface SocraticQuestionRef {
  key: string;
  question: string;
  example_answer?: string;
}

interface InputConfirmCardProps {
  data: PlanConfirmInterrupt;
  originalRequirement: string;
  socraticQuestions?: SocraticQuestionRef[];  // questions from Socratic rounds for Q&A display
  onConfirm: () => void;
  onBack: () => void;
  onContinueMoreQuestions?: (answers: Record<string, string>) => void;
}

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 10, color: "#9ca3af", letterSpacing: "0.1em",
  fontWeight: 600, textTransform: "uppercase" as const,
};

export default function InputConfirmCard({
  data,
  originalRequirement,
  socraticQuestions = [],
  onConfirm,
  onBack,
  onContinueMoreQuestions,
}: InputConfirmCardProps) {
  const isGood = data.clarity_score >= 70;
  const collectedAnswers = data.collected_answers ?? {};

  // Build Q&A pairs: match each answered key to its question text
  const qaPairs: { question: string; answer: string }[] = Object.entries(collectedAnswers)
    .filter(([, v]) => v?.trim() && !["__proceed__", "__skip__", "__continue__"].includes(String(v)))
    .map(([key, value]) => {
      const match = socraticQuestions.find(q => q.key === key);
      return {
        question: match?.question || key.replace(/_/g, " "),
        answer: String(value),
      };
    });

  return (
    <div
      className="rounded-2xl w-full overflow-hidden"
      style={{ background: "#ffffff", boxShadow: "0 1px 6px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.05)" }}
    >
      {/* ── Header ── */}
      <div className="px-5 py-4 flex items-center gap-3 border-b" style={{ borderColor: "rgba(0,0,0,0.07)" }}>
        <CheckCircle2 className="shrink-0" style={{ width: 22, height: 22, color: "#22c55e" }} strokeWidth={2} />
        <h2 className="font-semibold tracking-tight" style={{ fontSize: 16, color: "#1a1a1a" }}>
          確認您的需求輸入
        </h2>
      </div>

      {/* ── Body ── */}
      <div className="px-5 py-5 space-y-5">

        {/* 1. 原始需求 */}
        <section className="space-y-2">
          <p style={LABEL_STYLE}>原始需求</p>
          <div className="rounded-xl px-4 py-3" style={{ fontSize: 13, background: "#f3f4f6", color: "#374151", lineHeight: 1.65 }}>
            {originalRequirement}
          </div>
        </section>

        {/* 2. 追問補充說明 — Q&A format */}
        {qaPairs.length > 0 && (
          <section className="space-y-2">
            <p style={LABEL_STYLE}>您的補充說明（將整合到規格書中）</p>
            <div className="rounded-xl overflow-hidden border" style={{ borderColor: "rgba(0,0,0,0.07)" }}>
              {qaPairs.map(({ question, answer }, idx) => (
                <div
                  key={idx}
                  className="px-4 py-3"
                  style={{
                    borderTop: idx === 0 ? undefined : "1px solid rgba(0,0,0,0.05)",
                    background: idx % 2 === 0 ? "#fafafa" : "#ffffff",
                  }}
                >
                  {/* Question */}
                  <div className="flex items-start gap-2 mb-1.5">
                    <span
                      className="shrink-0 rounded-md font-bold text-white"
                      style={{ fontSize: 9, padding: "2px 5px", background: "#6b7280", letterSpacing: "0.05em", marginTop: 1 }}
                    >
                      Q
                    </span>
                    <span style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.5 }}>{question}</span>
                  </div>
                  {/* Answer */}
                  <div className="flex items-start gap-2">
                    <span
                      className="shrink-0 rounded-md font-bold text-white"
                      style={{ fontSize: 9, padding: "2px 5px", background: "#6B5CF0", letterSpacing: "0.05em", marginTop: 1 }}
                    >
                      A
                    </span>
                    <span style={{ fontSize: 13, color: "#1f2937", fontWeight: 500, lineHeight: 1.5 }}>{answer}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 3. 識別協定 */}
        {data.protocols?.length > 0 && (
          <section className="space-y-2">
            <p style={LABEL_STYLE}>識別協定</p>
            <div className="flex flex-wrap gap-2">
              {data.protocols.map((p) => (
                <span key={p} className="rounded-full border px-3 py-1 font-medium"
                  style={{ fontSize: 12, background: "#eff6ff", color: "#6B5CF0", borderColor: "#bfdbfe" }}>
                  {p}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* 4. 清晰度分數 */}
        <div className="flex items-center gap-2.5">
          <p style={LABEL_STYLE}>清晰度</p>
          <span className="rounded-full border px-3 py-0.5 font-semibold font-mono tabular-nums"
            style={{ fontSize: 12, background: isGood ? "#f0fdf4" : "#fffbeb", color: isGood ? "#16a34a" : "#b45309", borderColor: isGood ? "#bbf7d0" : "#fde68a" }}>
            {data.clarity_score} / 100
          </span>
          <span style={{ fontSize: 11, color: isGood ? "#22c55e" : "#f59e0b", fontWeight: 500 }}>
            {isGood ? "✓ 已達標，可開始生成規格書" : "▲ 可繼續追問以提升品質"}
          </span>
        </div>

      </div>

      {/* ── Footer ── */}
      <div className="px-5 py-4 border-t space-y-2" style={{ borderColor: "rgba(0,0,0,0.07)", background: "#fafafa" }}>
        <button onClick={onConfirm}
          className="w-full rounded-xl font-semibold transition-opacity hover:opacity-90 active:opacity-80"
          style={{ fontSize: 14, padding: "10px 0", background: "#6B5CF0", color: "#fff", border: "none", cursor: "pointer" }}>
          確認，開始搜尋
        </button>
        <div className="flex gap-2">
          <button onClick={onBack}
            className="flex-1 rounded-xl font-medium transition-colors hover:bg-black/[0.04]"
            style={{ fontSize: 13, padding: "8px 0", background: "transparent", color: "#374151", border: "1px solid rgba(0,0,0,0.14)", cursor: "pointer" }}>
            ← 修改回答
          </button>
          {onContinueMoreQuestions && (
            <button onClick={() => onContinueMoreQuestions(collectedAnswers)}
              className="flex-1 rounded-xl font-medium transition-colors hover:bg-black/[0.04]"
              style={{ fontSize: 13, padding: "8px 0", background: "transparent", color: "#8b5cf6", border: "1px solid rgba(139,92,246,0.3)", cursor: "pointer" }}>
              繼續追問
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
