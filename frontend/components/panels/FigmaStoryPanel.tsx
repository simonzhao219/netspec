"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { ChevronRight, Copy, Check, Pencil, Loader2, AlertTriangle, Database, Download, FilePlus2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { track, setAppSession } from "@/lib/track";

// ── Types ──────────────────────────────────────────────────────────────────────

interface FigmaFrame {
  page: string;
  frame_id: string;
  frame_name: string;
  text_count: number;
}

interface FigmaData {
  fileKey: string;
  fileName: string;
  frames: FigmaFrame[];
  // present only when loaded from history → panel boots straight into done phase
  initialDone?: {
    cacheKey: string;
    versionNum: number;
    roles: string[];
    features: Feature[];
    stories: NestedStories;
  };
}

interface Question {
  key: string;
  question: string;
}

interface Feature {
  id: string;
  name: string;
  description: string;
}

type WizardPhase =
  | "select"
  | "questioning"
  | "confirming"
  | "generating"
  | "done"
  | "error";

type StoryStatusVal = "pending" | "generating" | "done" | "error";
type NestedStatus = Record<string, Record<string, StoryStatusVal>>;
type NestedStories = Record<string, Record<string, string>>;

const API = "/api";

const ROLES = [
  { id: "PM", label: "PM",         desc: "User Story + AC" },
  { id: "FE", label: "前端工程師",  desc: "UI Task 列表" },
  { id: "BE", label: "後端工程師",  desc: "API / DB Task" },
  { id: "QA", label: "QA 工程師",   desc: "測試案例" },
] as const;

type RoleId = typeof ROLES[number]["id"];

// Product is PM-only: every feature has a single PM story.
const PM_ROLES: RoleId[] = ["PM"];

// ── Shared styles ──────────────────────────────────────────────────────────────

const CARD_STYLE = {
  border: "1px solid hsl(var(--border))",
  background: "#fff",
  boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
};

// ── Step indicator ─────────────────────────────────────────────────────────────

function StepBar({ phase }: { phase: WizardPhase }) {
  const steps = [
    { key: "select",      label: "選取 Frame" },
    { key: "questioning", label: "AI 追問" },
    { key: "confirming",  label: "確認功能" },
    { key: "generating",  label: "生成 Story" },
  ];
  const order: WizardPhase[] = ["select", "questioning", "confirming", "generating", "done"];
  const activeIdx = Math.min(order.indexOf(phase), 3);

  return (
    <div className="flex items-center gap-2 mb-5">
      {steps.map((s, i) => {
        const state = i < activeIdx ? "done" : i === activeIdx ? "active" : "pending";
        return (
          <div key={s.key} className="flex items-center gap-1.5">
            <span
              className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
              style={{
                background: state === "done" ? "#34c759" : state === "active" ? "#6B5CF0" : "rgba(0,0,0,0.08)",
                color: state === "pending" ? "#86868b" : "#fff",
              }}
            >
              {state === "done" ? "✓" : i + 1}
            </span>
            <span
              className="text-[12px] font-medium hidden sm:inline"
              style={{ color: state === "active" ? "#1d1d1f" : "#86868b" }}
            >
              {s.label}
            </span>
            {i < 3 && <ChevronRight size={12} style={{ color: "#c7c7cc" }} />}
          </div>
        );
      })}
    </div>
  );
}

// ── CopyButton ─────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); })}
      className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-all"
      style={{ color: copied ? "#34c759" : "#6e6e73", background: copied ? "rgba(52,199,89,0.1)" : "rgba(0,0,0,0.04)" }}
    >
      {copied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} strokeWidth={1.8} />}
      {copied ? "已複製" : "複製"}
    </button>
  );
}

// ── Checkbox ───────────────────────────────────────────────────────────────────

function Checkbox({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <div
      role="checkbox"
      aria-checked={checked}
      onClick={e => { e.stopPropagation(); onChange(); }}
      className="shrink-0 w-4 h-4 rounded flex items-center justify-center transition-all cursor-pointer"
      style={{ border: checked ? "none" : "1.5px solid #c7c7cc", background: checked ? "#6B5CF0" : "transparent" }}
    >
      {checked && (
        <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
          <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
}

// ── Story Section Editor ───────────────────────────────────────────────────────
// Splits story markdown into paragraphs; each paragraph can be edited inline.

// StoryEditor is always rendered with key={activeRole} from the parent so that
// switching roles/features fully remounts this component (no useEffect needed).
function StoryEditor({
  text,
  onChange,
}: {
  text: string;
  onChange: (t: string) => void;
}) {
  const splitSections = (t: string) => t.split(/\n{2,}/).filter(s => s.trim() !== "");

  const [sections, setSections] = useState<string[]>(() => splitSections(text));
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editBuf, setEditBuf] = useState("");

  const startEdit = (idx: number) => {
    setEditIdx(idx);
    setEditBuf(sections[idx]);
  };

  const saveEdit = () => {
    if (editIdx === null) return;
    const next = sections.map((s, i) => (i === editIdx ? editBuf : s));
    setSections(next);
    onChange(next.join("\n\n"));
    setEditIdx(null);
  };

  const cancelEdit = () => {
    setEditIdx(null);
    setEditBuf("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") cancelEdit();
    // Ctrl+Enter / Cmd+Enter saves
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") saveEdit();
  };

  return (
    <div className="flex flex-col gap-3">
      {sections.map((sec, idx) =>
        editIdx === idx ? (
          <div key={idx} className="flex flex-col gap-2">
            <textarea
              value={editBuf}
              onChange={e => setEditBuf(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={Math.max(3, editBuf.split("\n").length + 1)}
              autoFocus
              className="w-full resize-y rounded-xl px-3 py-2 text-[13px] outline-none leading-relaxed font-mono"
              style={{ border: "1.5px solid #6B5CF0", background: "rgba(107,92,240,0.02)" }}
            />
            <div className="flex gap-1.5 items-center">
              <button
                onClick={saveEdit}
                className="px-3 py-1 rounded-lg text-[12px] font-medium"
                style={{ background: "#6B5CF0", color: "#fff" }}
              >
                完成
              </button>
              <button
                onClick={cancelEdit}
                className="px-3 py-1 rounded-lg text-[12px]"
                style={{ background: "rgba(0,0,0,0.05)", color: "#6e6e73" }}
              >
                取消
              </button>
              <span className="text-[10px]" style={{ color: "#c7c7cc" }}>⌘↵ 儲存 ／ Esc 取消</span>
            </div>
          </div>
        ) : (
          <div key={idx} className="group relative pr-7">
            <div className="story-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{sec}</ReactMarkdown>
            </div>
            <button
              onClick={() => startEdit(idx)}
              title="編輯此段"
              className="absolute top-0.5 right-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md"
              style={{ color: "#86868b", background: "rgba(0,0,0,0.04)" }}
            >
              <Pencil size={11} strokeWidth={1.8} />
            </button>
          </div>
        )
      )}
    </div>
  );
}

// ── Sectioned story (cards + TOC) — mirrors the spec-output (規格輸出) layout ───

// Split a story's markdown into cards. Stories are nested markdown (# title →
// ## sections → ###/#### sub-items), so we split on ONE heading level only and
// keep deeper headings inside the card body — otherwise a parent heading whose
// content lives in sub-headings (e.g. "Acceptance Criteria" → "AC-1", "AC-2")
// would become a title-only empty card.
type StorySec = { id: string; label: string; head: string; body: string };
function splitStorySections(md: string): StorySec[] {
  const lines = (md || "").split("\n");

  // 1. Choose the section level = shallowest ATX level that appears ≥2 times
  //    (a level used once is usually the document title, not a section boundary);
  //    fall back to the shallowest level present. 0 = no ATX headings at all.
  const levelOf = (ln: string): number | null => {
    const m = ln.match(/^(#{1,6})\s+\S/);
    return m ? m[1].length : null;
  };
  const counts = new Map<number, number>();
  for (const ln of lines) { const l = levelOf(ln); if (l) counts.set(l, (counts.get(l) ?? 0) + 1); }
  const sorted = [...counts.keys()].sort((a, b) => a - b);
  const sectionLevel = sorted.find((l) => (counts.get(l) ?? 0) >= 2) ?? sorted[0] ?? 0;

  const isHr = (ln: string) => /^\s*([-*_])\1{2,}\s*$/.test(ln);      // ---, ***, ___ separators
  const headLabel = (ln: string): string | null => {
    const m = ln.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (m && m[1].length === sectionLevel) return m[2].trim().replace(/\*\*/g, "").replace(/_/g, "");
    // No ATX headings anywhere → let a bold-only line act as a heading.
    if (sectionLevel === 0) { const b = ln.match(/^\*\*(.+?)\*\*\s*$/); if (b) return b[1].trim(); }
    return null;
  };

  const secs: StorySec[] = [];
  const pre: string[] = [];
  let cur: StorySec | null = null;
  let n = 0;
  for (const ln of lines) {
    if (isHr(ln)) continue;                       // drop separators → no near-empty cards
    const label = headLabel(ln);
    if (label !== null) {
      if (cur) secs.push(cur);
      cur = { id: `story-sec-${n++}`, label, head: ln, body: "" };
      continue;
    }
    if (cur) cur.body += ln + "\n";
    else pre.push(ln);
  }
  if (cur) secs.push(cur);
  for (const s of secs) s.body = s.body.replace(/\s+$/, "");

  // Preamble (before first section): drop the lone H1 doc-title (it duplicates
  // the feature name already shown in the header) and surface the rest as 概述.
  const preBody = pre.filter((l) => !/^#\s+/.test(l)).join("\n").trim();
  if (preBody) secs.unshift({ id: "story-sec-pre", label: secs.length ? "概述" : "User Story", head: "", body: preBody });

  // Safety net: never render a heading-only (empty body) card.
  return secs.filter((s) => s.body.trim() !== "");
}

// Sticky section navigator — gives "jump to heading" within the active story.
function StoryToc({ items, activeId, onJump }: {
  items: { id: string; label: string }[]; activeId: string; onJump: (id: string) => void;
}) {
  return (
    <nav className="flex flex-col gap-0.5">
      <p className="px-2.5 pb-1.5 font-semibold uppercase" style={{ fontSize: 10, letterSpacing: "0.07em", color: "hsl(var(--muted-foreground))" }}>章節</p>
      {items.map((it) => {
        const active = it.id === activeId;
        return (
          <button key={it.id} type="button" onClick={() => onJump(it.id)}
            className="text-left rounded-lg px-2.5 py-[7px] transition-colors truncate hover:bg-black/[0.04]"
            style={active
              ? { background: "rgba(107,92,240,0.10)", color: "#6B5CF0", fontWeight: 600, fontSize: 12 }
              : { color: "hsl(var(--muted-foreground))", fontSize: 12 }}
            title={it.label}>
            {it.label}
          </button>
        );
      })}
    </nav>
  );
}

// One story section as a card; the body stays inline-editable via StoryEditor.
function StorySectionCard({ section, innerRef, onBodyChange }: {
  section: StorySec;
  innerRef: (el: HTMLElement | null) => void;
  onBodyChange: (sectionId: string, newBody: string) => void;
}) {
  return (
    <section id={section.id} ref={innerRef} className="rounded-2xl overflow-hidden scroll-mt-4" style={CARD_STYLE}>
      <div className="flex items-center gap-2.5 px-5 py-3.5" style={{ borderBottom: "1px solid hsl(var(--border))" }}>
        <span style={{ width: 4, height: 14, borderRadius: 2, background: "#6B5CF0", flexShrink: 0 }} />
        <span className="font-semibold tracking-tight truncate" style={{ fontSize: 13.5, color: "hsl(var(--foreground))" }}>{section.label}</span>
      </div>
      <div className="px-5 py-4">
        <StoryEditor key={section.id} text={section.body} onChange={(t) => onBodyChange(section.id, t)} />
      </div>
    </section>
  );
}

// ── Feature Story (done phase) — sectioned cards + confirm bar ─────────────────

function FeatureStoryCard({
  feature,
  stories,
  storyStatus,
  localTexts,
  confirmedKeys,
  onTextChange,
  onConfirm,
  sections,
  registerRef,
}: {
  feature: Feature;
  stories: NestedStories;
  storyStatus: NestedStatus;
  localTexts: NestedStories;
  confirmedKeys: Set<string>;
  onTextChange: (featureId: string, role: RoleId, text: string) => void;
  onConfirm: (featureId: string, role: RoleId) => void;
  sections: StorySec[];
  registerRef: (id: string, el: HTMLElement | null) => void;
}) {
  // PM-only: a feature has a single PM story.
  const role: RoleId = "PM";

  const featureStatus = storyStatus[feature.id] ?? {};
  const origTexts     = stories[feature.id] ?? {};
  const editTexts     = localTexts[feature.id] ?? {};

  const currentText = editTexts[role] ?? origTexts[role] ?? "";
  const origText    = origTexts[role] ?? "";
  const status      = featureStatus[role] ?? "pending";
  const isConfirmed = confirmedKeys.has(`${feature.id}:${role}`);
  const isModified  = currentText !== origText;

  // Edit a single section's body → re-join all sections back into one markdown doc.
  const handleSectionBody = (sectionId: string, newBody: string) => {
    const parts = sections.map((s) => {
      const body = (s.id === sectionId ? newBody : s.body).trim();
      return (s.head ? `${s.head}\n${body}` : body).trim();
    });
    onTextChange(feature.id, role, parts.filter((p) => p).join("\n\n"));
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Feature header card */}
      <div className="rounded-2xl px-4 py-3 flex items-start justify-between gap-3" style={CARD_STYLE}>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span style={{ color: "#6B5CF0" }}>●</span>
            <span className="text-[13.5px] font-bold truncate" style={{ color: "#1d1d1f" }}>{feature.name}</span>
          </div>
          <p className="text-[11.5px] mt-0.5 ml-4 leading-snug" style={{ color: "#6e6e73" }}>{feature.description}</p>
        </div>
        {status === "done" && (
          <span
            className="shrink-0 text-[11px] px-2 py-0.5 rounded-full font-medium"
            style={isConfirmed
              ? { background: "rgba(52,199,89,0.1)", color: "#16a34a" }
              : { background: "rgba(0,0,0,0.04)", color: "#86868b" }}
          >
            {isConfirmed ? "已確認" : "待確認"}
          </span>
        )}
      </div>

      {/* Status (non-done) */}
      {status === "generating" && (
        <div className="rounded-2xl px-4 py-5 flex items-center gap-3" style={CARD_STYLE}>
          <Loader2 size={16} className="animate-spin shrink-0" style={{ color: "#6B5CF0" }} />
          <span className="text-[13px] text-muted-foreground">AI 正在生成 PM Story…</span>
        </div>
      )}
      {status === "pending" && (
        <div className="rounded-2xl px-4 py-5" style={CARD_STYLE}>
          <span className="text-[13px] text-muted-foreground">等待生成</span>
        </div>
      )}
      {status === "error" && (
        <div className="rounded-2xl px-4 py-4 text-[13px]" style={{ ...CARD_STYLE, color: "#b91c1c" }}>生成失敗</div>
      )}

      {/* Done → one card per section + confirm bar */}
      {status === "done" && currentText && (
        <>
          {sections.map((sec) => (
            <StorySectionCard
              key={sec.id}
              section={sec}
              innerRef={(el) => registerRef(sec.id, el)}
              onBodyChange={handleSectionBody}
            />
          ))}

          <div className="rounded-2xl px-4 py-3 flex items-center justify-between gap-2" style={CARD_STYLE}>
            <div className="flex items-center gap-2">
              <CopyButton text={currentText} />
              {isModified && !isConfirmed && (
                <span className="text-[11px] flex items-center gap-1" style={{ color: "#ff9500" }}>
                  <AlertTriangle size={11} strokeWidth={2} />
                  已修改
                </span>
              )}
            </div>
            <button
              onClick={() => onConfirm(feature.id, role)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-all"
              style={
                isConfirmed
                  ? { background: "rgba(52,199,89,0.12)", color: "#16a34a", border: "1px solid rgba(52,199,89,0.3)" }
                  : { background: "rgba(107,92,240,0.08)", color: "#6B5CF0", border: "1px solid rgba(107,92,240,0.15)" }
              }
            >
              {isConfirmed
                ? <><Check size={12} strokeWidth={2.5} /> 已確認</>
                : <><Check size={12} strokeWidth={2} /> 確認此 Story</>
              }
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Generating phase card (shows all features + progress) ─────────────────────

function GeneratingFeatureCard({
  feature,
  storyStatus,
}: {
  feature: Feature;
  storyStatus: NestedStatus;
}) {
  const featureStatus = storyStatus[feature.id] ?? {};
  const status        = featureStatus["PM"] ?? "pending";

  return (
    <div className="rounded-2xl overflow-hidden" style={CARD_STYLE}>
      <div className="px-4 py-3 border-b flex items-center justify-between gap-3" style={{ borderColor: "hsl(var(--border))" }}>
        <div className="flex items-center gap-2 min-w-0">
          <span style={{ color: "#6B5CF0" }}>●</span>
          <span className="text-[13px] font-semibold truncate" style={{ color: "#1d1d1f" }}>{feature.name}</span>
        </div>
        <span
          className="shrink-0 text-[11px] px-2 py-0.5 rounded-full font-medium"
          style={{
            background: status === "done" ? "rgba(52,199,89,0.1)" : "rgba(0,0,0,0.05)",
            color: status === "done" ? "#16a34a" : "#86868b",
          }}
        >
          {status === "done" ? "完成" : "PM"}
        </span>
      </div>
      {status === "generating" && (
        <div className="flex items-center gap-3 px-4 py-4">
          <Loader2 size={14} className="animate-spin shrink-0" style={{ color: "#6B5CF0" }} />
          <span className="text-[13px] text-muted-foreground">生成中…</span>
        </div>
      )}
      {status === "pending" && (
        <div className="px-4 py-4">
          <span className="text-[13px] text-muted-foreground opacity-50">排隊中…</span>
        </div>
      )}
      {status === "done" && (
        <div className="px-4 py-4">
          <span className="text-[12px] font-medium" style={{ color: "#34c759" }}>完成</span>
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function FigmaStoryPanel({
  figmaData,
  onNodeEvent,
  onOpenHistory,
}: {
  figmaData: FigmaData;
  onNodeEvent?: (type: string, data: Record<string, unknown>) => void;
  onOpenHistory?: (sessionId: string) => void;   // load a saved session into done phase
}) {
  const { fileKey, fileName, frames } = figmaData;

  // ── Step 1 state ────────────────────────────────────────────────────────────
  // Pre-select the frames handed off from InputPanel (already the user's chosen
  // subset). Lazy init covers first mount; the set-during-render block below
  // re-seeds when page.tsx passes a fresh frames array for a new selection
  // (the panel is not remounted for the same file_key). This is React's
  // "adjust state when a prop changes" pattern — no effect needed.
  const [selectedIds,   setSelectedIds]   = useState<Set<string>>(() => new Set(frames.map(f => f.frame_id)));
  const [prevFrames,    setPrevFrames]    = useState(frames);
  if (frames !== prevFrames) {
    setPrevFrames(frames);
    setSelectedIds(new Set(frames.map(f => f.frame_id)));
  }
  const _initDone = figmaData.initialDone;
  const [userDesc,      setUserDesc]      = useState("");

  // ── Pipeline state ──────────────────────────────────────────────────────────
  const [phase,    setPhase]    = useState<WizardPhase>(_initDone ? "done" : "select");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [error,    setError]    = useState<string | null>(null);

  // ── Step 2: Questioning ─────────────────────────────────────────────────────
  const [completedRounds, setCompletedRounds] = useState<Array<{
    round: number;
    questions: Question[];
    answers: Record<string, string>;
  }>>([]);
  const [currentRound,   setCurrentRound]   = useState<{ round: number; questions: Question[] } | null>(null);
  const [pendingAnswers, setPendingAnswers]  = useState<Record<string, string>>({});
  const [submitting,     setSubmitting]     = useState(false);

  // ── Step 3: Confirming ──────────────────────────────────────────────────────
  const [features,     setFeatures]     = useState<Feature[]>([]);
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(new Set());
  const [supplement,   setSupplement]   = useState("");
  const [confirming,   setConfirming]   = useState(false);

  // ── Step 4: Generating / Done ───────────────────────────────────────────────
  const [confirmedFeatures, setConfirmedFeatures] = useState<Feature[]>(() => _initDone?.features ?? []);
  const [stories,           setStories]           = useState<NestedStories>(() => _initDone?.stories ?? {});
  const [storyStatus,       setStoryStatus]       = useState<NestedStatus>(() => {
    if (!_initDone) return {};
    const st: NestedStatus = {};
    for (const fid of Object.keys(_initDone.stories)) {
      st[fid] = {};
      for (const role of Object.keys(_initDone.stories[fid])) st[fid][role] = "done";
    }
    return st;
  });

  // ── Done phase state ────────────────────────────────────────────────────────
  const [cacheKey,        setCacheKey]        = useState<string>(() => _initDone?.cacheKey ?? "");
  const [versionNum,      setVersionNum]      = useState<number | null>(() => _initDone?.versionNum ?? null);
  const [activeFeatureIdx, setActiveFeatureIdx] = useState(0);
  const [localTexts,      setLocalTexts]      = useState<NestedStories>({});
  // History-loaded versions start "confirmed" (already saved); fresh generation starts empty.
  const [confirmedStories, setConfirmedStories] = useState<Set<string>>(() => {
    if (!_initDone) return new Set();
    const s = new Set<string>();
    for (const fid of Object.keys(_initDone.stories)) {
      for (const role of Object.keys(_initDone.stories[fid])) s.add(`${fid}:${role}`);
    }
    return s;
  });
  const [savedToDb,       setSavedToDb]       = useState(() => !!_initDone);
  const [saving,          setSaving]          = useState(false);
  const [saveDbError,     setSaveDbError]     = useState<string | null>(null);

  // ── Already-generated awareness (for the frame picker) ──────────────────────
  // All saved story sessions for this file_key → flag generated frames + detect
  // an exact-set match against the current selection.
  const [fileSessions, setFileSessions] = useState<Array<{
    id: string; frame_ids: string[]; frame_names: string[];
    roles: string[]; version_count: number; updated_at: number;
  }>>([]);

  const esRef = useRef<EventSource | null>(null);

  // ── Unsaved changes guard ───────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "done") return;
    const hasEdits = Object.keys(localTexts).some(fid =>
      Object.keys(localTexts[fid] ?? {}).some(
        role => (localTexts[fid]?.[role] ?? "") !== (stories[fid]?.[role] ?? "")
      )
    );
    if (hasEdits && !savedToDb) {
      const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
      window.addEventListener("beforeunload", handler);
      return () => window.removeEventListener("beforeunload", handler);
    }
  }, [localTexts, stories, savedToDb, phase]);

  // ── SSE listener ────────────────────────────────────────────────────────────

  // A malformed/truncated SSE frame should never crash the panel — log the
  // raw payload (for diagnosing wire-level issues) and let the caller skip it.
  const parseSSEData = (eventName: string, e: Event): any | null => {
    try {
      return JSON.parse((e as MessageEvent).data);
    } catch (err) {
      console.error(`[figma-sse] failed to parse "${eventName}" event data`, err, (e as MessageEvent).data);
      return null;
    }
  };

  const openSSE = useCallback((tid: string) => {
    if (esRef.current) esRef.current.close();
    const es = new EventSource(`${API}/figma/pipeline/${tid}/stream`);
    esRef.current = es;

    es.addEventListener("interrupt", (e) => {
      const payload = parseSSEData("interrupt", e);
      if (!payload) return;
      const itype   = payload.interrupt_type;
      onNodeEvent?.("interrupt", { interrupt_type: itype, data: payload.data });

      if (itype === "figma_questions") {
        const { round, questions } = payload.data as { round: number; questions: Question[] };
        setCurrentRound({ round, questions });
        setPendingAnswers({});
        setPhase("questioning");
      } else if (itype === "figma_features") {
        const feats: Feature[] = payload.data.features ?? [];
        setFeatures(feats);
        setConfirmedIds(new Set(feats.map((f) => f.id)));
        setPhase("confirming");
      }
    });

    es.addEventListener("step_start", (e) => {
      const payload = parseSSEData("step_start", e);
      if (!payload) return;
      onNodeEvent?.("step_start", payload);
      if (payload.node === "story_node" && payload.feature_id && payload.role) {
        setStoryStatus(prev => ({
          ...prev,
          [payload.feature_id]: {
            ...prev[payload.feature_id],
            [payload.role]: "generating",
          },
        }));
      }
    });

    es.addEventListener("step_end", (e) => {
      const payload = parseSSEData("step_end", e);
      if (!payload) return;
      onNodeEvent?.("step_end", payload);
    });

    es.addEventListener("story", (e) => {
      const payload = parseSSEData("story", e);
      if (!payload) return;
      const { feature_id, role, text } = payload as {
        feature_id: string; role: string; text: string;
      };
      onNodeEvent?.("story", { feature_id, role });
      setStories(prev => ({ ...prev, [feature_id]: { ...prev[feature_id], [role]: text } }));
      setStoryStatus(prev => ({
        ...prev,
        [feature_id]: { ...prev[feature_id], [role]: "done" },
      }));
    });

    es.addEventListener("complete", (e) => {
      const payload = parseSSEData("complete", e);
      if (!payload) return;
      onNodeEvent?.("complete", {});
      const res = payload?.result ?? {};
      const ck = res.cache_key ?? "";
      setCacheKey(ck);
      // Hydrate from server result — required for the cache-hit path, where no
      // figma_features interrupt fires and confirmFeatures() never ran, so the
      // local stories/confirmedFeatures state would otherwise be empty.
      if (Array.isArray(res.confirmed_features) && res.confirmed_features.length) {
        setConfirmedFeatures(prev => (prev.length ? prev : res.confirmed_features));
      }
      if (res.stories && typeof res.stories === "object") {
        setStories(prev => (Object.keys(prev).length ? prev : res.stories));
      }
      if (res.story_status && typeof res.story_status === "object") {
        setStoryStatus(prev => (Object.keys(prev).length ? prev : res.story_status));
      }
      // Reset done-phase UI state
      setLocalTexts({});
      setConfirmedStories(new Set());
      setSavedToDb(false);
      setSaveDbError(null);
      setActiveFeatureIdx(0);
      setPhase("done");
      es.close();
    });

    es.addEventListener("pipeline_error", (e) => {
      const payload = parseSSEData("pipeline_error", e);
      if (!payload) return;
      onNodeEvent?.("pipeline_error", { message: payload.message ?? "Pipeline 發生錯誤" });
      setError(payload.message ?? "Pipeline 發生錯誤");
      setPhase("error");
      es.close();
    });

    es.onerror = () => {
      if (esRef.current === es) {
        setError("SSE 連線中斷，請重試");
        setPhase("error");
        es.close();
      }
    };
  }, [onNodeEvent]);

  useEffect(() => () => { esRef.current?.close(); }, []);

  // Load (and refresh on save) the saved story sessions for this file_key.
  useEffect(() => {
    if (!fileKey) return;
    const load = () => {
      fetch(`${API}/figma/history/by-file/${encodeURIComponent(fileKey)}`)
        .then(r => (r.ok ? r.json() : []))
        .then(d => setFileSessions(Array.isArray(d) ? d : []))
        .catch(() => {});
    };
    load();
    window.addEventListener("figma-history-changed", load);
    return () => window.removeEventListener("figma-history-changed", load);
  }, [fileKey]);

  // ── Start pipeline ──────────────────────────────────────────────────────────

  const startPipeline = async (force = false) => {
    if (selectedIds.size === 0) return;
    onNodeEvent?.("pipeline_start", {});
    track("figma_pipeline_start_clicked", {
      file_key: fileKey,
      frame_count: selectedIds.size,
      force_regenerate: force,
      description_chars: userDesc.length,
    });
    setError(null);
    setCompletedRounds([]);
    setCurrentRound(null);
    setStories({});
    setStoryStatus({});
    setFeatures([]);
    setConfirmedFeatures([]);
    setPhase("questioning");

    try {
      const res = await fetch(`${API}/figma/pipeline/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_key:         fileKey,
          frame_ids:        Array.from(selectedIds),
          user_description: userDesc,
          roles:            ["PM"],   // PM only; downstream roles generated on demand
          force_regenerate: force,    // true → skip story cache and truly re-run
        }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { detail?: string }).detail ?? "啟動失敗");
      const { thread_id } = await res.json();
      // Bind subsequent clicks to the Figma pipeline session, the same way the
      // text workflow binds to its NetSpec session — that's the join key.
      setAppSession(thread_id);
      setThreadId(thread_id);
      openSSE(thread_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
      track("figma_pipeline_start_failed", { message: e instanceof Error ? e.message : String(e) });
    }
  };

  // ── Submit question answers ─────────────────────────────────────────────────

  const submitAnswers = async (proceed: boolean) => {
    if (!threadId || !currentRound) return;
    onNodeEvent?.("user_answered", {});
    track(proceed ? "figma_questions_skipped" : "figma_questions_submitted", {
      round: completedRounds.length + 1,
      question_count: currentRound.questions?.length ?? 0,
      answered_count: Object.values(pendingAnswers ?? {}).filter(v => String(v ?? "").trim() !== "").length,
    });
    setSubmitting(true);
    setCompletedRounds(prev => [...prev, { ...currentRound, answers: pendingAnswers }]);
    setCurrentRound(null);

    try {
      const res = await fetch(`${API}/figma/pipeline/${threadId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: pendingAnswers, proceed }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { detail?: string }).detail ?? "送出失敗");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Confirm feature list ────────────────────────────────────────────────────

  const confirmFeatures = async () => {
    if (!threadId || confirmedIds.size === 0) return;
    const confirmed = features.filter(f => confirmedIds.has(f.id));
    // How many AI-extracted features the user throws away is the quality signal
    // for the feature-extraction step.
    track("figma_features_confirm_clicked", {
      confirmed_count: confirmed.length,
      suggested_count: features.length,
      dropped_count: features.length - confirmed.length,
      supplement_chars: supplement.length,
    });
    onNodeEvent?.("user_confirmed", {
      features: confirmed as unknown as Record<string, unknown>[],
      roles: ["PM"] as unknown as Record<string, unknown>[],
    });
    setConfirming(true);
    setConfirmedFeatures(confirmed);

    const initStatus: NestedStatus = {};
    for (const f of confirmed) {
      initStatus[f.id] = { PM: "pending" };
    }
    setStoryStatus(initStatus);
    setPhase("generating");

    try {
      const res = await fetch(`${API}/figma/pipeline/${threadId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed_ids: Array.from(confirmedIds), supplement }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { detail?: string }).detail ?? "確認失敗");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      setConfirming(false);
    }
  };

  // ── Done phase handlers ─────────────────────────────────────────────────────

  const handleTextChange = (featureId: string, role: RoleId, text: string) => {
    setLocalTexts(prev => ({
      ...prev,
      [featureId]: { ...prev[featureId], [role]: text },
    }));
    // If user re-edits a confirmed story, unconfirm it
    setConfirmedStories(prev => {
      const next = new Set(prev);
      next.delete(`${featureId}:${role}`);
      return next;
    });
    setSavedToDb(false);
  };

  const handleConfirmStory = (featureId: string, role: RoleId) => {
    const key = `${featureId}:${role}`;
    setConfirmedStories(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key); // toggle off
      } else {
        next.add(key);
      }
      track("figma_story_confirmed", {
        feature_id: featureId, role, confirmed: next.has(key),
        confirmed_total: next.size,
      });
      return next;
    });
    setSavedToDb(false);
  };

  // Current (edited) story items for save payloads.
  const buildStoryItems = () => {
    const roles = PM_ROLES;
    return confirmedFeatures.flatMap(f =>
      roles.map(role => ({
        feature_id: f.id,
        role,
        text: localTexts[f.id]?.[role] ?? stories[f.id]?.[role] ?? "",
      }))
    ).filter(item => item.text.trim() !== "");
  };

  const featurePayload = () =>
    confirmedFeatures.map(f => ({ id: f.id, name: f.name, description: f.description }));

  // 進版 — snapshot the current set as a NEW version.
  const saveAsNewVersion = async () => {
    if (!cacheKey) return;
    setSaving(true);
    setSaveDbError(null);
    try {
      const res = await fetch(`${API}/figma/history/${encodeURIComponent(cacheKey)}/save-version`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cache_key:   cacheKey,
          file_key:    fileKey,
          file_name:   fileName,
          frame_ids:   frames.map(f => f.frame_id),
          frame_names: frames.map(f => f.frame_name),
          roles:       PM_ROLES,
          features:    featurePayload(),
          stories:     buildStoryItems(),
        }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { detail?: string }).detail ?? "儲存失敗");
      const data = await res.json().catch(() => ({}));
      if (typeof data.version_num === "number") setVersionNum(data.version_num);
      setSavedToDb(true);
      track("figma_story_version_saved", {
        cache_key: cacheKey,
        version_num: data.version_num ?? null,
        feature_count: confirmedFeatures.length,
        story_count: buildStoryItems().length,
        mode: "new_version",
      });
      window.dispatchEvent(new Event("figma-history-changed"));
    } catch (e) {
      setSaveDbError(e instanceof Error ? e.message : String(e));
      track("figma_story_save_failed", { mode: "new_version", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  // 不進版 — overwrite the CURRENT version in place (edit).
  const saveEditInPlace = async () => {
    if (!cacheKey || versionNum == null) return;
    setSaving(true);
    setSaveDbError(null);
    try {
      const res = await fetch(`${API}/figma/history/${encodeURIComponent(cacheKey)}/versions/${versionNum}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ features: featurePayload(), stories: buildStoryItems() }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { detail?: string }).detail ?? "儲存失敗");
      setSavedToDb(true);
      track("figma_story_version_saved", {
        cache_key: cacheKey,
        version_num: versionNum,
        feature_count: confirmedFeatures.length,
        story_count: buildStoryItems().length,
        mode: "edit_in_place",
      });
      window.dispatchEvent(new Event("figma-history-changed"));
    } catch (e) {
      setSaveDbError(e instanceof Error ? e.message : String(e));
      track("figma_story_save_failed", { mode: "edit_in_place", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  // ── Export / copy-all (匯出 Markdown／複製全部) ─────────────────────────────
  const buildMarkdown = () => {
    const roles = PM_ROLES;
    const roleLabel = (r: RoleId) => ROLES.find(x => x.id === r)?.label ?? r;
    let md = `# ${fileName || "Figma Stories"}\n\n`;
    for (const f of confirmedFeatures) {
      md += `## ${f.name}\n\n`;
      if (f.description) md += `${f.description}\n\n`;
      for (const role of roles) {
        const text = localTexts[f.id]?.[role] ?? stories[f.id]?.[role];
        if (text && text.trim()) md += `### ${roleLabel(role)}\n\n${text.trim()}\n\n`;
      }
    }
    return md.trim();
  };

  const [copiedAll, setCopiedAll] = useState(false);
  const copyAll = () => {
    navigator.clipboard.writeText(buildMarkdown()).then(() => {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1800);
    });
  };
  const exportMd = () => {
    const blob = new Blob([buildMarkdown()], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(fileName || "figma-stories").replace(/[^\w一-龥-]+/g, "_")}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── Frame selection helpers ─────────────────────────────────────────────────

  const toggleFrame = (id: string) =>
    setSelectedIds(prev => { const s = new Set(prev); if (s.has(id)) s.delete(id); else s.add(id); return s; });

  const toggleAll = () =>
    setSelectedIds(selectedIds.size === frames.length ? new Set() : new Set(frames.map(f => f.frame_id)));

  const byPage: Record<string, FigmaFrame[]> = {};
  for (const f of frames) (byPage[f.page] = byPage[f.page] ?? []).push(f);

  // ── Already-generated signals (select phase) ────────────────────────────────
  // (A) frames that appeared in ANY saved session for this file_key
  const generatedFrameIds = new Set(fileSessions.flatMap(s => s.frame_ids));
  // (B) a saved session whose frame set EXACTLY equals the current selection
  const selKey = Array.from(selectedIds).sort().join("|");
  const exactMatch = selKey
    ? fileSessions.find(s => [...s.frame_ids].sort().join("|") === selKey)
    : undefined;
  // (D) overlap count when not an exact match
  const overlapCount = Array.from(selectedIds).filter(id => generatedFrameIds.has(id)).length;

  const roles        = PM_ROLES;
  const totalStories = confirmedFeatures.length * roles.length;
  const doneStories  = Object.values(storyStatus).flatMap(r => Object.values(r)).filter(s => s === "done").length;

  const confirmedCount = confirmedStories.size;
  const allConfirmed   = totalStories > 0 && confirmedCount >= totalStories;

  const activeFeature = confirmedFeatures[activeFeatureIdx] ?? null;

  // ── Active story → sectioned cards + section navigator (mirrors 規格輸出) ──
  const activeStoryText =
    activeFeature ? (localTexts[activeFeature.id]?.PM ?? stories[activeFeature.id]?.PM ?? "") : "";
  const activeStoryStatus =
    activeFeature ? (storyStatus[activeFeature.id]?.PM ?? "pending") : "pending";
  const storySections  = activeStoryStatus === "done" ? splitStorySections(activeStoryText) : [];
  const storyTocItems  = storySections.map((s, i) => ({ id: s.id, label: `${i + 1}. ${s.label}` }));

  const storySecRefs    = useRef<Record<string, HTMLElement | null>>({});
  const storyTocRootRef = useRef<HTMLDivElement>(null);
  const storyTocIdsRef  = useRef<string[]>([]);
  const [activeStorySec, setActiveStorySec] = useState<string>("");
  storyTocIdsRef.current = storyTocItems.map((t) => t.id);

  // Scroll-spy: highlight the section nearest the top of the scroll viewport.
  useEffect(() => {
    if (phase !== "done") return;
    const container = storyTocRootRef.current?.closest("[data-radix-scroll-area-viewport]") as HTMLElement | null;
    if (!container) return;
    const onScroll = () => {
      const cTop = container.getBoundingClientRect().top;
      let cur = storyTocIdsRef.current[0] ?? "";
      for (const id of storyTocIdsRef.current) {
        const el = storySecRefs.current[id];
        if (!el) continue;
        if (el.getBoundingClientRect().top - cTop <= 120) cur = id;
      }
      setActiveStorySec(cur);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => container.removeEventListener("scroll", onScroll);
  }, [phase, activeFeatureIdx, activeStoryText]);

  const jumpToStorySection = (id: string) => {
    storySecRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveStorySec(id);
  };
  const registerStoryRef = (id: string, el: HTMLElement | null) => { storySecRefs.current[id] = el; };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="w-full max-w-[1100px] mx-auto flex flex-col gap-5 py-2">

      {/* Title */}
      <div>
        <h2 className="text-[21px] font-semibold" style={{ letterSpacing: "-0.02em" }}>User Story 輸出</h2>
        <p className="text-[13px] text-muted-foreground mt-0.5">{fileName}</p>
      </div>

      <StepBar phase={phase} />

      {/* ════════════════════════════════════════════════════════
          Step 1 — Select frames, roles, description
          ════════════════════════════════════════════════════════ */}
      {phase === "select" && (
        <div className="flex flex-col gap-4">

          {/* Frame list */}
          <div className="rounded-2xl overflow-hidden" style={CARD_STYLE}>
            <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: "hsl(var(--border))" }}>
              <span className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">
                <span style={{ color: "#6B5CF0" }}>● </span>選取要分析的 Frame
              </span>
              <div className="flex items-center gap-3">
                <button
                  onClick={toggleAll}
                  className="text-[11px] font-medium transition-opacity hover:opacity-70"
                  style={{ color: "#6B5CF0" }}
                >
                  {selectedIds.size === frames.length ? "取消全選" : "全部選取"}
                </button>
                <span className="text-[11px] text-muted-foreground">已選 {selectedIds.size} / {frames.length}</span>
              </div>
            </div>

            <div className="max-h-[300px] overflow-y-auto">
              {Object.entries(byPage).map(([page, pFrames]) => (
                <div key={page}>
                  <div
                    className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
                    style={{ color: "#86868b", background: "rgba(0,0,0,0.02)", borderBottom: "1px solid hsl(var(--border))" }}
                  >
                    {page}
                  </div>
                  {pFrames.map(f => {
                    const checked = selectedIds.has(f.frame_id);
                    const generated = generatedFrameIds.has(f.frame_id);
                    return (
                      <button
                        key={f.frame_id}
                        onClick={() => toggleFrame(f.frame_id)}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors border-b"
                        style={{ borderColor: "hsl(var(--border))", background: checked ? "rgba(107,92,240,0.04)" : "transparent" }}
                      >
                        <Checkbox checked={checked} onChange={() => toggleFrame(f.frame_id)} />
                        <span className="flex-1 text-[13px] truncate" style={{ color: "#1d1d1f" }}>{f.frame_name}</span>
                        {generated && (
                          <span
                            className="shrink-0 inline-flex items-center gap-1 text-[9.5px] font-medium px-1.5 py-0.5 rounded-md"
                            style={{ background: "rgba(139,92,246,0.1)", color: "#7c3aed" }}
                            title="此 Frame 曾用於故事生成"
                          >
                            <span className="w-1 h-1 rounded-full" style={{ background: "#8b5cf6" }} />
                            已生成
                          </span>
                        )}
                        <span className="shrink-0 text-[10px] font-mono" style={{ color: "#86868b" }}>{f.text_count} 文字</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* PM 生成說明 */}
          <div className="rounded-2xl px-4 py-3 flex items-start gap-2.5"
            style={{ background: "rgba(107,92,240,0.04)", border: "1px solid rgba(107,92,240,0.15)" }}>
            <span className="shrink-0 mt-0.5 text-[14px]">📋</span>
            <div>
              <p className="text-[12.5px] font-semibold" style={{ color: "#6B5CF0" }}>生成 PM 版本（User Story + 驗收標準）</p>
              <p className="text-[11.5px] mt-0.5 leading-snug" style={{ color: "#6e6e73" }}>
                從選取的 Frame 生成 PM 角色的 User Story 與驗收標準，可逐段編輯後存入版本歷史。
              </p>
            </div>
          </div>

          {/* Description + Start */}
          <div className="rounded-2xl overflow-hidden" style={CARD_STYLE}>
            <div className="px-4 py-3 border-b" style={{ borderColor: "hsl(var(--border))" }}>
              <span style={{ color: "#6B5CF0" }}>● </span>
              <span className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">補充說明（選填）</span>
            </div>
            <div className="p-4 flex flex-col gap-3">
              <textarea
                value={userDesc}
                onChange={e => setUserDesc(e.target.value)}
                placeholder="描述畫面的功能背景、業務目標，或特別需要注意的細節…"
                rows={3}
                className="w-full resize-none rounded-xl px-3 py-2.5 text-[13px] outline-none leading-relaxed"
                style={{ border: "1px solid hsl(var(--border))", background: "rgba(0,0,0,0.02)", color: "#1d1d1f" }}
              />
              {error && <p className="text-[12px]" style={{ color: "#b91c1c" }}>{error}</p>}

              {/* (B) Exact-set match → this selection already has a saved session */}
              {exactMatch && (
                <div className="rounded-xl px-3 py-2.5 flex items-start gap-2.5"
                  style={{ background: "rgba(139,92,246,0.06)", border: "1px solid rgba(139,92,246,0.22)" }}>
                  <span className="shrink-0 mt-0.5 text-[14px]">📋</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-semibold" style={{ color: "#7c3aed" }}>
                      這組 Frame 已生成過故事
                    </p>
                    <p className="text-[11px] mt-0.5" style={{ color: "#6e6e73" }}>
                      {exactMatch.version_count} 個版本
                      {exactMatch.roles?.length ? `・${exactMatch.roles.join("／")}` : ""}
                      {exactMatch.updated_at
                        ? `・最後更新 ${new Date(exactMatch.updated_at * 1000).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                        : ""}
                    </p>
                    <button
                      onClick={() => onOpenHistory?.(exactMatch.id)}
                      className="mt-1.5 text-[11.5px] font-medium transition-opacity hover:opacity-70"
                      style={{ color: "#7c3aed" }}
                    >
                      開啟歷史版本 →
                    </button>
                  </div>
                </div>
              )}

              {/* (D) Partial overlap (not an exact match) */}
              {!exactMatch && overlapCount > 0 && (
                <p className="text-[11.5px]" style={{ color: "#86868b" }}>
                  已選的 {selectedIds.size} 個 Frame 中，有 <span style={{ color: "#7c3aed", fontWeight: 600 }}>{overlapCount}</span> 個曾在其他組合中生成過故事。
                </p>
              )}

              {/* Always force_regenerate → the pipeline runs the 追問 wizard every time.
                  Serving cached stories silently skipped 追問 whenever a figma_story_v2
                  cache existed without a matching history session. Viewing kept stories
                  has its own path (history sidebar → onOpenHistory / _initDone). */}
              <button
                onClick={() => startPipeline(true)}
                disabled={selectedIds.size === 0}
                className="w-full py-3 rounded-xl font-semibold text-[15px] transition-opacity disabled:opacity-40"
                style={{ background: "#6B5CF0", color: "#fff" }}
              >
                {exactMatch ? "重新生成新版 →" : "開始 AI 分析 →"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          Step 2 — AI Questioning
          ════════════════════════════════════════════════════════ */}
      {phase === "questioning" && (
        <div className="flex flex-col gap-4">

          <div className="flex flex-wrap gap-1.5">
            {frames.filter(f => selectedIds.has(f.frame_id)).map(f => (
              <span key={f.frame_id} className="text-[11px] px-2.5 py-1 rounded-full font-medium"
                style={{ background: "rgba(107,92,240,0.08)", color: "#6B5CF0" }}>
                {f.frame_name}
              </span>
            ))}
            <button
              onClick={() => { esRef.current?.close(); setPhase("select"); setError(null); }}
              className="text-[11px] px-2.5 py-1 rounded-full transition-opacity hover:opacity-70"
              style={{ color: "#6e6e73", border: "1px solid hsl(var(--border))" }}
            >
              ← 重新開始
            </button>
          </div>

          {completedRounds.map((round, ri) => (
            <div key={ri} className="rounded-2xl overflow-hidden" style={{ ...CARD_STYLE, opacity: 0.65 }}>
              <div className="px-4 py-2.5 border-b flex items-center gap-2" style={{ borderColor: "hsl(var(--border))" }}>
                <span className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white" style={{ background: "#34c759" }}>✓</span>
                <span className="text-[11px] font-medium text-muted-foreground">第 {round.round + 1} 輪追問（已確認）</span>
              </div>
              <div className="px-4 py-3 space-y-2.5">
                {round.questions.map((q) => (
                  <div key={q.key}>
                    <p className="text-[12px] font-medium" style={{ color: "#1d1d1f" }}>{q.question}</p>
                    <p className="text-[12px] mt-0.5" style={{ color: "#6e6e73" }}>{round.answers[q.key] || "（未回答）"}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {!currentRound && (
            <div className="rounded-2xl overflow-hidden" style={CARD_STYLE}>
              <div className="flex items-center gap-3 px-4 py-6">
                <Loader2 size={18} className="animate-spin shrink-0" style={{ color: "#6B5CF0" }} />
                <span className="text-[13px] text-muted-foreground">AI 正在分析設計稿，準備追問…</span>
              </div>
            </div>
          )}

          {currentRound && (
            <div className="rounded-2xl overflow-hidden" style={CARD_STYLE}>
              <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: "hsl(var(--border))" }}>
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white" style={{ background: "#6B5CF0" }}>
                    {currentRound.round + 1}
                  </span>
                  <span className="text-[12px] font-medium text-muted-foreground">第 {currentRound.round + 1} 輪追問</span>
                </div>
                <span className="text-[10px] text-muted-foreground/50">最多 3 輪</span>
              </div>

              <div className="p-4 space-y-4">
                {currentRound.questions.map((q) => (
                  <div key={q.key} className="flex flex-col gap-1.5">
                    <p className="text-[13px] font-medium" style={{ color: "#1d1d1f" }}>{q.question}</p>
                    <textarea
                      value={pendingAnswers[q.key] ?? ""}
                      onChange={e => setPendingAnswers(prev => ({ ...prev, [q.key]: e.target.value }))}
                      placeholder="您的回答…"
                      rows={2}
                      className="w-full resize-none rounded-xl px-3 py-2 text-[13px] outline-none leading-relaxed"
                      style={{ border: "1px solid hsl(var(--border))", background: "rgba(0,0,0,0.02)" }}
                    />
                  </div>
                ))}

                <div className="flex gap-2 pt-1">
                  {currentRound.round < 2 && (
                    <button
                      onClick={() => submitAnswers(false)}
                      disabled={submitting}
                      className="flex-1 py-2.5 rounded-xl font-medium text-[13px] disabled:opacity-40 transition-opacity hover:opacity-80"
                      style={{ background: "rgba(107,92,240,0.08)", color: "#6B5CF0" }}
                    >
                      {submitting ? "送出中…" : "確認，繼續追問"}
                    </button>
                  )}
                  <button
                    onClick={() => submitAnswers(true)}
                    disabled={submitting}
                    className="flex-1 py-2.5 rounded-xl font-semibold text-[13px] disabled:opacity-40 transition-opacity hover:opacity-90"
                    style={{ background: "#6B5CF0", color: "#fff" }}
                  >
                    {submitting
                      ? "送出中…"
                      : currentRound.round >= 2 ? "確認並進入下一步 →" : "跳過追問 →"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {error && <p className="text-[12px]" style={{ color: "#b91c1c" }}>{error}</p>}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          Step 3 — Confirm feature list
          ════════════════════════════════════════════════════════ */}
      {phase === "confirming" && (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl overflow-hidden" style={CARD_STYLE}>
            <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: "hsl(var(--border))" }}>
              <div>
                <span style={{ color: "#6B5CF0" }}>● </span>
                <span className="text-[12px] font-medium text-muted-foreground uppercase tracking-wide">AI 識別到的功能清單</span>
              </div>
              <span className="text-[11px] text-muted-foreground">已選 {confirmedIds.size} / {features.length}</span>
            </div>

            <div className="divide-y" style={{ borderColor: "hsl(var(--border))" }}>
              {features.map(f => {
                const checked = confirmedIds.has(f.id);
                return (
                  <button
                    key={f.id}
                    onClick={() => setConfirmedIds(prev => {
                      const s = new Set(prev);
                      if (s.has(f.id)) s.delete(f.id); else s.add(f.id);
                      return s;
                    })}
                    className="w-full flex items-start gap-3 px-4 py-3 text-left transition-colors"
                    style={{ background: checked ? "rgba(107,92,240,0.03)" : "transparent" }}
                  >
                    <span className="mt-0.5">
                      <Checkbox checked={checked} onChange={() => {}} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium" style={{ color: "#1d1d1f" }}>{f.name}</p>
                      <p className="text-[12px] mt-0.5 leading-snug" style={{ color: "#6e6e73" }}>{f.description}</p>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="p-4 border-t flex flex-col gap-3" style={{ borderColor: "hsl(var(--border))" }}>
              <textarea
                value={supplement}
                onChange={e => setSupplement(e.target.value)}
                placeholder="最終補充說明（選填）：還有什麼需要特別注意的？"
                rows={2}
                className="w-full resize-none rounded-xl px-3 py-2.5 text-[13px] outline-none leading-relaxed"
                style={{ border: "1px solid hsl(var(--border))", background: "rgba(0,0,0,0.02)" }}
              />
              {error && <p className="text-[12px]" style={{ color: "#b91c1c" }}>{error}</p>}
              <button
                onClick={confirmFeatures}
                disabled={confirmedIds.size === 0 || confirming}
                className="w-full py-3 rounded-xl font-semibold text-[15px] transition-opacity disabled:opacity-40"
                style={{ background: "#6B5CF0", color: "#fff" }}
              >
                {confirming ? "確認中…" : `確認 ${confirmedIds.size} 個功能，開始平行生成 →`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          Step 4 — Generating
          ════════════════════════════════════════════════════════ */}
      {phase === "generating" && (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl overflow-hidden" style={CARD_STYLE}>
            <div className="p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" style={{ color: "#6B5CF0" }} />
                  <span className="text-[13px] font-medium" style={{ color: "#1d1d1f" }}>
                    生成 PM Story 中…（{confirmedFeatures.length} 個功能）
                  </span>
                </div>
                <span className="text-[12px] font-mono tabular-nums" style={{ color: "#6B5CF0" }}>
                  {doneStories}/{totalStories}
                </span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(0,0,0,0.06)" }}>
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${totalStories > 0 ? Math.round(doneStories / totalStories * 100) : 0}%`, background: "#6B5CF0" }}
                />
              </div>
            </div>
          </div>

          {confirmedFeatures.map(feature => (
            <GeneratingFeatureCard
              key={feature.id}
              feature={feature}
              storyStatus={storyStatus}
            />
          ))}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          Done Phase — Feature tabs + review + save to DB
          ════════════════════════════════════════════════════════ */}
      {phase === "done" && (
        <div className="flex flex-col gap-4 min-w-0">

          {/* Summary banner */}
          <div
            className="rounded-2xl px-4 py-3 flex items-center justify-between gap-3"
            style={{ background: "rgba(52,199,89,0.08)", border: "1px solid rgba(52,199,89,0.2)" }}
          >
            <div className="flex items-center gap-3">
              <span className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[13px] font-bold shrink-0"
                style={{ background: "#34c759" }}>✓</span>
              <div>
                <p className="text-[13px] font-semibold" style={{ color: "#16a34a" }}>PM Story 生成完成</p>
                <p className="text-[12px]" style={{ color: "#4ade80" }}>
                  {confirmedFeatures.length} 個功能，共 {totalStories} 份 PM Story
                </p>
              </div>
            </div>
            <div className="text-right shrink-0">
              <p className="text-[12px] font-semibold" style={{ color: confirmedCount === totalStories ? "#16a34a" : "#ff9500" }}>
                {confirmedCount}/{totalStories} 確認
              </p>
              <p className="text-[10px]" style={{ color: "#86868b" }}>逐一確認後存入 DB</p>
            </div>
          </div>

          {/* Feature tabs — wrap to multiple rows (no horizontal scroll needed) */}
          {confirmedFeatures.length > 1 && (
            <div className="flex flex-wrap gap-1.5 min-w-0 w-full">
              {confirmedFeatures.map((f, i) => {
                const fConfirmedCount = roles.filter(r => confirmedStories.has(`${f.id}:${r}`)).length;
                const isActive = activeFeatureIdx === i;
                return (
                  <button
                    key={f.id}
                    onClick={() => setActiveFeatureIdx(i)}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-medium whitespace-nowrap transition-all shrink-0"
                    style={{
                      background: isActive ? "#6B5CF0" : "rgba(0,0,0,0.04)",
                      color: isActive ? "#fff" : "#1d1d1f",
                      border: isActive ? "none" : "1px solid hsl(var(--border))",
                    }}
                  >
                    <span className="max-w-[140px] truncate">{f.name}</span>
                    {fConfirmedCount === roles.length ? (
                      <span className="text-[10px] font-bold" style={{ color: isActive ? "rgba(255,255,255,0.85)" : "#34c759" }}>✓</span>
                    ) : fConfirmedCount > 0 ? (
                      <span
                        className="text-[9px] px-1.5 py-0.5 rounded-full font-bold"
                        style={{
                          background: isActive ? "rgba(255,255,255,0.2)" : "rgba(107,92,240,0.12)",
                          color: isActive ? "#fff" : "#6B5CF0",
                        }}
                      >
                        {fConfirmedCount}/{roles.length}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}

          {/* Active feature story — sticky section navigator + sectioned cards */}
          {activeFeature && (
            <div ref={storyTocRootRef} className="flex gap-5 items-start">
              {/* sticky TOC — jump to a heading inside the active story */}
              {storyTocItems.length > 1 && (
                <div className="shrink-0 sticky top-2 self-start hidden lg:block" style={{ width: 168 }}>
                  <StoryToc items={storyTocItems} activeId={activeStorySec} onJump={jumpToStorySection} />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <FeatureStoryCard
                  key={activeFeature.id}
                  feature={activeFeature}
                  stories={stories}
                  storyStatus={storyStatus}
                  localTexts={localTexts}
                  confirmedKeys={confirmedStories}
                  onTextChange={handleTextChange}
                  onConfirm={handleConfirmStory}
                  sections={storySections}
                  registerRef={registerStoryRef}
                />
              </div>
            </div>
          )}

          {/* Previous / Next feature navigation (when multiple features) */}
          {confirmedFeatures.length > 1 && (
            <div className="flex items-center justify-between">
              <button
                onClick={() => setActiveFeatureIdx(i => Math.max(0, i - 1))}
                disabled={activeFeatureIdx === 0}
                className="flex items-center gap-1 px-3 py-2 rounded-xl text-[12px] font-medium transition-all disabled:opacity-30"
                style={{ color: "#6e6e73", border: "1px solid hsl(var(--border))" }}
              >
                ← 上一個功能
              </button>
              <span className="text-[12px]" style={{ color: "#86868b" }}>
                {activeFeatureIdx + 1} / {confirmedFeatures.length}
              </span>
              <button
                onClick={() => setActiveFeatureIdx(i => Math.min(confirmedFeatures.length - 1, i + 1))}
                disabled={activeFeatureIdx === confirmedFeatures.length - 1}
                className="flex items-center gap-1 px-3 py-2 rounded-xl text-[12px] font-medium transition-all disabled:opacity-30"
                style={{ color: "#6e6e73", border: "1px solid hsl(var(--border))" }}
              >
                下一個功能 →
              </button>
            </div>
          )}

          {/* Export / copy-all row */}
          <div className="flex gap-2">
            <button
              onClick={copyAll}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-[12px] font-medium transition-all"
              style={{ color: copiedAll ? "#16a34a" : "#6e6e73", background: copiedAll ? "rgba(52,199,89,0.1)" : "rgba(0,0,0,0.04)" }}
            >
              {copiedAll ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} strokeWidth={1.8} />}
              {copiedAll ? "已複製全部" : "複製全部"}
            </button>
            <button
              onClick={exportMd}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-[12px] font-medium transition-all hover:bg-black/[0.06]"
              style={{ color: "#6e6e73", background: "rgba(0,0,0,0.04)" }}
            >
              <Download size={13} strokeWidth={1.8} /> 匯出 Markdown
            </button>
          </div>

          {/* Save / version — sticky action bar */}
          <div
            className="rounded-2xl px-4 py-3 flex flex-col gap-2"
            style={{ background: "rgba(0,0,0,0.02)", border: "1px solid hsl(var(--border))" }}
          >
            {!savedToDb && confirmedCount < totalStories && (
              <p className="text-[12px]" style={{ color: "#86868b" }}>
                還有 <span style={{ color: "#ff9500", fontWeight: 600 }}>{totalStories - confirmedCount}</span> 份 Story 尚未確認。確認後即可儲存。
              </p>
            )}
            {savedToDb && (
              <p className="text-[12px] flex items-center gap-1.5" style={{ color: "#16a34a" }}>
                <Check size={13} strokeWidth={2.5} />
                已儲存{versionNum != null ? ` v${versionNum}` : ""}，可在左側歷史紀錄查看
              </p>
            )}
            {saveDbError && (
              <p className="text-[12px]" style={{ color: "#b91c1c" }}>{saveDbError}</p>
            )}
            <div className="flex gap-2">
              {/* 不進版 — overwrite current version (only after a version exists) */}
              {versionNum != null && (
                <button
                  onClick={saveEditInPlace}
                  disabled={saving || !allConfirmed}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl font-semibold text-[13.5px] transition-all disabled:opacity-40"
                  style={{ background: allConfirmed ? "#6B5CF0" : "rgba(0,0,0,0.06)", color: allConfirmed ? "#fff" : "#86868b" }}
                >
                  {saving ? <><Loader2 size={14} className="animate-spin" /> 儲存中…</>
                          : <><Check size={14} strokeWidth={2} /> 儲存編輯（覆蓋 v{versionNum}）</>}
                </button>
              )}
              {/* 進版 — snapshot as a new version */}
              <button
                onClick={saveAsNewVersion}
                disabled={saving || !allConfirmed}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl font-semibold text-[13.5px] transition-all disabled:opacity-40"
                style={
                  versionNum != null
                    ? { background: "rgba(107,92,240,0.08)", color: "#6B5CF0", border: "1px solid rgba(107,92,240,0.2)" }
                    : { background: allConfirmed ? "#6B5CF0" : "rgba(0,0,0,0.06)", color: allConfirmed ? "#fff" : "#86868b" }
                }
              >
                {saving && versionNum == null ? (
                  <><Loader2 size={14} className="animate-spin" /> 儲存中…</>
                ) : versionNum != null ? (
                  <><FilePlus2 size={14} strokeWidth={1.8} /> 存為新版本 v{versionNum + 1}</>
                ) : (
                  <><Database size={14} strokeWidth={1.8} /> 全部確認，存入 DB（{confirmedCount}/{totalStories}）</>
                )}
              </button>
            </div>
          </div>

        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          Error state
          ════════════════════════════════════════════════════════ */}
      {phase === "error" && (
        <div className="rounded-2xl overflow-hidden" style={CARD_STYLE}>
          <div className="p-6 flex flex-col items-center gap-4 text-center">
            <p className="text-[14px] font-semibold" style={{ color: "#b91c1c" }}>Pipeline 發生錯誤</p>
            {error && <p className="text-[13px]" style={{ color: "#6e6e73" }}>{error}</p>}
            <button
              onClick={() => { esRef.current?.close(); setPhase("select"); setError(null); }}
              className="px-5 py-2.5 rounded-xl font-medium text-[13px]"
              style={{ background: "#6B5CF0", color: "#fff" }}
            >
              重新開始
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
