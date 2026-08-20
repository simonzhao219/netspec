"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { FigmaParseResult } from "@/lib/api";

interface FigmaSpecPanelProps {
  result: FigmaParseResult;
}

export default function FigmaSpecPanel({ result }: FigmaSpecPanelProps) {
  const [activeFrame, setActiveFrame] = useState(0);

  const current = result.frames[activeFrame];

  const handleExport = () => {
    const content = result.frames
      .map((f) => `# ${f.frame_name}\n\n${f.spec}`)
      .join("\n\n---\n\n");
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${result.file_name.replace(/\s+/g, "_")}_spec.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="w-full max-w-3xl mx-auto flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div className="space-y-0.5">
          <h2 className="font-semibold tracking-tight" style={{ fontSize: 22, letterSpacing: "-0.02em" }}>
            {result.file_name}
          </h2>
          <p className="text-[13px] text-muted-foreground">
            {result.frames.length} 個 Frame · Figma Spec 自動生成
          </p>
        </div>
        <button
          onClick={handleExport}
          className="text-[12px] font-medium px-3 py-1.5 rounded-lg transition-colors hover:bg-black/[0.05]"
          style={{ color: "#6B5CF0", border: "1px solid rgba(107,92,240,0.2)" }}
        >
          匯出 MD
        </button>
      </div>

      {/* Frame tabs */}
      {result.frames.length > 1 && (
        <div className="flex gap-2 flex-wrap">
          {result.frames.map((f, i) => (
            <button
              key={i}
              onClick={() => setActiveFrame(i)}
              className="text-[12px] font-medium px-3 py-1.5 rounded-lg transition-all"
              style={{
                background: activeFrame === i ? "#6B5CF0" : "rgba(0,0,0,0.04)",
                color: activeFrame === i ? "#fff" : "#1d1d1f",
                border: activeFrame === i ? "1px solid #6B5CF0" : "1px solid transparent",
              }}
            >
              {f.frame_name || `Frame ${i + 1}`}
            </button>
          ))}
        </div>
      )}

      {/* Spec content */}
      {current && (
        <div
          className="rounded-2xl overflow-hidden"
          style={{
            border: "1px solid hsl(var(--border))",
            background: "#fff",
            boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
          }}
        >
          {/* Card header */}
          <div
            className="px-4 py-3 border-b flex items-center gap-2"
            style={{ borderColor: "hsl(var(--border))" }}
          >
            <span style={{ color: "#6B5CF0" }}>●</span>
            <span className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">
              {current.page} / {current.frame_name || `Frame ${activeFrame + 1}`}
            </span>
          </div>

          {/* Markdown spec */}
          <ScrollArea style={{ maxHeight: "calc(100vh - 320px)" }}>
            <div
              className="p-5 prose prose-sm max-w-none"
              style={{ fontSize: 13, lineHeight: 1.7, color: "#1d1d1f" }}
            >
              <ReactMarkdown>{current.spec}</ReactMarkdown>
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
