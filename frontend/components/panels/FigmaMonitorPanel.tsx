"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Radar, X, RefreshCw, Trash2, Loader2, ChevronDown, ChevronRight,
  PlusCircle, MinusCircle, PencilLine, Send, Settings2, Pencil, RefreshCcw,
  Maximize2, Palette,
} from "lucide-react";
import {
  listFigmaMonitors, createFigmaMonitor, checkFigmaMonitor, checkAllFigmaMonitors, listFigmaMonitorChecks,
  deleteFigmaMonitor, listFigmaFrames, notifyFigmaMonitor, updateFigmaMonitorWebhook,
  updateFigmaMonitorName, listTeamsWebhooks, createTeamsWebhook, updateTeamsWebhook, deleteTeamsWebhook,
  type FigmaMonitor, type FigmaMonitorDiff, type FigmaMonitorCheckHistoryItem,
  type FigmaFrame, type TeamsWebhook, type FigmaMonitorBatchCheckResult,
} from "@/lib/api";

/* ─── helpers ── */

function fmtTime(ts: number | null): string {
  if (!ts) return "尚未檢查";
  return new Date(ts * 1000).toLocaleString("zh-TW", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function hasDiffContent(diff: FigmaMonitorDiff | null): boolean {
  if (!diff) return false;
  return diff.added.length > 0 || diff.removed.length > 0 || diff.modified.length > 0;
}

const border = "hsl(var(--border))";

/* ─── diff display ── */

function DiffResult({ diff, isFirstCheck }: { diff: FigmaMonitorDiff | null; isFirstCheck: boolean }) {
  if (isFirstCheck) {
    return <p className="text-[12.5px]" style={{ color: "#6e6e73" }}>✓ 已建立監控基準，下次比對才會顯示差異。</p>;
  }
  if (!diff || !hasDiffContent(diff)) {
    return <p className="text-[12.5px]" style={{ color: "#34c759" }}>✓ 沒有偵測到變化。</p>;
  }
  return (
    <div className="flex flex-col gap-2.5">
      {diff.added.map(f => (
        <div key={f.frame_id} className="flex items-start gap-1.5 text-[12.5px]" style={{ color: "#1d1d1f" }}>
          <PlusCircle style={{ width: 14, height: 14, color: "#34c759", marginTop: 1, flexShrink: 0 }} />
          <span>新增 Frame：<b>{f.frame_name || f.frame_id}</b></span>
        </div>
      ))}
      {diff.removed.map(f => (
        <div key={f.frame_id} className="flex items-start gap-1.5 text-[12.5px]" style={{ color: "#1d1d1f" }}>
          <MinusCircle style={{ width: 14, height: 14, color: "#ff3b30", marginTop: 1, flexShrink: 0 }} />
          <span>移除 Frame：<b>{f.frame_name || f.frame_id}</b>（Figma 上找不到，可能已刪除）</span>
        </div>
      ))}
      {diff.modified.map(f => (
        <div key={f.frame_id} className="flex flex-col gap-1 rounded-xl p-2.5"
          style={{ background: "rgba(107,92,240,0.05)", border: "1px solid rgba(107,92,240,0.16)" }}>
          <div className="flex items-center gap-1.5 text-[12.5px] font-semibold" style={{ color: "#6B5CF0" }}>
            <PencilLine style={{ width: 13, height: 13 }} />
            {f.frame_name || f.frame_id}
          </div>
          {f.changed_texts.map((c, i) => (
            <div key={`c${i}`} className="text-[12px]" style={{ paddingLeft: 19 }}>
              <span style={{ color: "#b91c1c", textDecoration: "line-through" }}>{c.from}</span>
              <span style={{ color: "#86868b" }}> → </span>
              <span style={{ color: "#16a34a" }}>{c.to}</span>
            </div>
          ))}
          {f.added_texts.map((t, i) => (
            <div key={`a${i}`} className="text-[12px]" style={{ color: "#16a34a", paddingLeft: 19 }}>+ {t}</div>
          ))}
          {f.removed_texts.map((t, i) => (
            <div key={`r${i}`} className="text-[12px]" style={{ color: "#b91c1c", paddingLeft: 19, textDecoration: "line-through" }}>{t}</div>
          ))}
          {f.visual_added.map((v, i) => (
            <div key={`va${i}`} className="flex items-center gap-1.5 text-[12px]" style={{ color: "#16a34a", paddingLeft: 19 }}>
              <PlusCircle style={{ width: 11, height: 11, flexShrink: 0 }} />
              新增元件：{v.name}
            </div>
          ))}
          {f.visual_removed.map((v, i) => (
            <div key={`vr${i}`} className="flex items-center gap-1.5 text-[12px]" style={{ color: "#b91c1c", paddingLeft: 19 }}>
              <MinusCircle style={{ width: 11, height: 11, flexShrink: 0 }} />
              移除元件：{v.name}
            </div>
          ))}
          {f.resized.map((r, i) => (
            <div key={`rs${i}`} className="flex items-center gap-1.5 text-[12px]" style={{ color: "#92400e", paddingLeft: 19 }}>
              <Maximize2 style={{ width: 11, height: 11, flexShrink: 0 }} />
              {r.name} 尺寸變更：{r.from?.width}×{r.from?.height} → {r.to?.width}×{r.to?.height}
            </div>
          ))}
          {f.recolored.map((c, i) => (
            <div key={`rc${i}`} className="flex items-center gap-1.5 text-[12px]" style={{ color: "#92400e", paddingLeft: 19 }}>
              <Palette style={{ width: 11, height: 11, flexShrink: 0 }} />
              {c.name} 顏色變更
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ─── status badge ── */

function StatusBadge({ monitor }: { monitor: FigmaMonitor }) {
  const pill = (label: string, bg: string, color: string) => (
    <span className="text-[10.5px] px-1.5 py-0.5 rounded-full font-medium shrink-0" style={{ background: bg, color }}>
      {label}
    </span>
  );
  if (!monitor.last_checked_at) return pill("尚未檢查", "rgba(0,0,0,0.05)", "#86868b");
  if (!monitor.latest_diff_summary) return pill("已建立基準", "rgba(0,0,0,0.05)", "#86868b");
  const { added, removed, modified } = monitor.latest_diff_summary;
  const total = added + removed + modified;
  return total === 0
    ? pill("✓ 無變化", "rgba(52,199,89,0.12)", "#16a34a")
    : pill(`🔴 ${total} 處變化`, "rgba(255,59,48,0.1)", "#ff3b30");
}

/* ─── monitor card ── */

function MonitorCard({ monitor, webhooks, onChanged }: {
  monitor: FigmaMonitor; webhooks: TeamsWebhook[]; onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [checking, setChecking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [lastResult, setLastResult] = useState<{ isFirstCheck: boolean; diff: FigmaMonitorDiff | null } | null>(null);
  const [history, setHistory] = useState<FigmaMonitorCheckHistoryItem[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [notifying, setNotifying] = useState(false);
  const [notifyResult, setNotifyResult] = useState<"sent" | "error" | null>(null);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const [webhookUpdating, setWebhookUpdating] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(monitor.custom_name);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try { setHistory(await listFigmaMonitorChecks(monitor.id)); }
    catch { setHistory([]); }
    finally { setHistoryLoading(false); }
  }, [monitor.id]);

  const toggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && history === null) loadHistory();
  };

  const runCheck = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const res = await checkFigmaMonitor(monitor.id);
      setLastResult({ isFirstCheck: res.is_first_check, diff: res.diff });
      if (!expanded) setExpanded(true);
      await loadHistory();
      onChanged();
    } catch (e: any) {
      setCheckError(e?.message || "比對失敗");
    } finally {
      setChecking(false);
    }
  };

  const runDelete = async () => {
    setDeleting(true);
    try { await deleteFigmaMonitor(monitor.id); onChanged(); }
    finally { setDeleting(false); }
  };

  const runNotify = async () => {
    setNotifying(true);
    setNotifyResult(null);
    setNotifyError(null);
    try {
      await notifyFigmaMonitor(monitor.id);
      setNotifyResult("sent");
    } catch (e: any) {
      setNotifyResult("error");
      setNotifyError(e?.message || "發送失敗");
    } finally {
      setNotifying(false);
    }
  };

  const startEditName = () => {
    setNameDraft(monitor.custom_name);
    setNameError(null);
    setEditingName(true);
  };

  const cancelEditName = () => setEditingName(false);

  const saveEditName = async () => {
    if (!nameDraft.trim()) return;
    setSavingName(true);
    setNameError(null);
    try {
      await updateFigmaMonitorName(monitor.id, nameDraft.trim());
      setEditingName(false);
      onChanged();
    } catch (e: any) {
      setNameError(e?.message || "更新失敗");
    } finally {
      setSavingName(false);
    }
  };

  const handleWebhookChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value || null;
    setWebhookUpdating(true);
    try { await updateFigmaMonitorWebhook(monitor.id, val); onChanged(); }
    finally { setWebhookUpdating(false); }
  };

  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${border}`, background: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
      <div className="px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {editingName ? (
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <input value={nameDraft} onChange={e => setNameDraft(e.target.value)} autoFocus
              onKeyDown={e => { if (e.key === "Enter") saveEditName(); if (e.key === "Escape") cancelEditName(); }}
              className="flex-1 min-w-0 rounded-lg px-2 py-1 text-[13px] outline-none"
              style={{ border: `1px solid ${border}` }} />
            <button type="button" onClick={saveEditName} disabled={savingName || !nameDraft.trim()}
              className="text-[12px] font-semibold shrink-0 disabled:opacity-40" style={{ color: "#6B5CF0" }}>
              {savingName ? "儲存中…" : "儲存"}
            </button>
            <button type="button" onClick={cancelEditName} className="text-[12px] shrink-0" style={{ color: "#86868b" }}>取消</button>
          </div>
        ) : (
          <>
            <button type="button" onClick={toggleExpand} className="flex items-center gap-2 flex-1 min-w-0 text-left">
              {expanded ? <ChevronDown style={{ width: 15, height: 15, color: "#86868b" }} /> : <ChevronRight style={{ width: 15, height: 15, color: "#86868b" }} />}
              <span className="font-semibold truncate text-[14px]" style={{ color: "#1d1d1f" }}>{monitor.custom_name}</span>
              <StatusBadge monitor={monitor} />
            </button>
            <button type="button" onClick={startEditName} className="shrink-0 hover:opacity-70 transition-opacity" title="編輯名稱">
              <Pencil style={{ width: 13, height: 13, color: "#86868b" }} />
            </button>
          </>
        )}

        <button type="button" onClick={runCheck} disabled={checking}
          className="flex items-center gap-1.5 shrink-0 text-[11.5px] font-medium px-3 py-1.5 rounded-lg transition-opacity hover:opacity-70 disabled:opacity-40"
          style={{ color: "#6B5CF0", border: "1px solid rgba(107,92,240,0.3)" }}>
          {checking ? <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> : <RefreshCw style={{ width: 12, height: 12 }} />}
          手動比對
        </button>

        <button type="button" onClick={runNotify} disabled={notifying || !monitor.has_webhook}
          title={monitor.has_webhook ? "把最新一次比對結果發送到 Teams" : "尚未設定 Teams Webhook URL"}
          className="flex items-center gap-1.5 shrink-0 text-[11.5px] font-medium px-3 py-1.5 rounded-lg transition-opacity hover:opacity-70 disabled:opacity-40"
          style={{ color: "#34c759", border: "1px solid rgba(52,199,89,0.3)" }}>
          {notifying ? <Loader2 style={{ width: 12, height: 12 }} className="animate-spin" /> : <Send style={{ width: 12, height: 12 }} />}
          發送到 Teams
        </button>

        {confirmDelete ? (
          <div className="flex items-center gap-1.5 shrink-0 text-[11px]">
            <button type="button" onClick={runDelete} disabled={deleting} style={{ color: "#ff3b30", fontWeight: 600 }}>確定刪除</button>
            <button type="button" onClick={() => setConfirmDelete(false)} style={{ color: "#86868b" }}>取消</button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmDelete(true)} className="shrink-0 hover:opacity-70 transition-opacity" title="刪除監控">
            <Trash2 style={{ width: 14, height: 14, color: "#86868b" }} />
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap" style={{ paddingLeft: 21 }}>
        <span className="truncate text-[12px]" style={{ color: "#86868b" }}>
          {monitor.file_name || monitor.file_key} · {monitor.frame_count} 個 Frame · 上次檢查：{fmtTime(monitor.last_checked_at)}
        </span>
        <select value={monitor.teams_webhook_id ?? ""} onChange={handleWebhookChange} disabled={webhookUpdating}
          className="text-[11px] rounded-md px-1.5 py-0.5 outline-none shrink-0"
          style={{ border: `1px solid ${border}`, background: "#fff", color: monitor.teams_webhook_id ? "#1d1d1f" : "#86868b" }}>
          <option value="">未設定 Teams Webhook</option>
          {webhooks.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </div>
      {nameError && <p className="text-[11.5px]" style={{ color: "#ff3b30", paddingLeft: 21 }}>{nameError}</p>}
      </div>

      {expanded && (
        <div className="px-4 pb-4 pt-1" style={{ borderTop: `1px solid ${border}` }}>
          {checkError && <p className="mt-3 text-[12.5px]" style={{ color: "#ff3b30" }}>{checkError}</p>}
          {notifyResult === "sent" && <p className="mt-3 text-[12.5px]" style={{ color: "#34c759" }}>✓ 已發送到 Teams。</p>}
          {notifyResult === "error" && <p className="mt-3 text-[12.5px]" style={{ color: "#ff3b30" }}>{notifyError}</p>}
          {lastResult && (
            <div className="mt-3">
              <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: "#86868b" }}>本次比對結果</div>
              <DiffResult diff={lastResult.diff} isFirstCheck={lastResult.isFirstCheck} />
            </div>
          )}

          <div className="mt-4">
            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: "#86868b" }}>檢查歷史</div>
            {historyLoading && <p className="text-[12.5px]" style={{ color: "#86868b" }}>載入中…</p>}
            {!historyLoading && history && history.length === 0 && (
              <p className="text-[12.5px]" style={{ color: "#86868b" }}>還沒有任何檢查紀錄。</p>
            )}
            {!historyLoading && history && history.length > 0 && (
              <div className="flex flex-col gap-2">
                {history.map(h => (
                  <div key={h.id} className="rounded-xl p-2.5" style={{ background: "rgba(0,0,0,0.02)" }}>
                    <div className="mb-1 text-[11px]" style={{ color: "#6e6e73" }}>{fmtTime(h.checked_at)}</div>
                    {h.diff === null
                      ? <span className="text-[12px]" style={{ color: "#86868b" }}>建立基準</span>
                      : hasDiffContent(h.diff)
                        ? <DiffResult diff={h.diff} isFirstCheck={false} />
                        : <span className="text-[12px]" style={{ color: "#34c759" }}>沒有變化</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── create modal ── */

function CreateMonitorModal({ webhooks, onClose, onCreated }: {
  webhooks: TeamsWebhook[]; onClose: () => void; onCreated: () => void;
}) {
  const [url, setUrl] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [fileKey, setFileKey] = useState("");
  const [fileName, setFileName] = useState("");
  const [frames, setFrames] = useState<FigmaFrame[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [customName, setCustomName] = useState("");
  const [webhookId, setWebhookId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [usedFrameIds, setUsedFrameIds] = useState<Set<string>>(new Set());
  const [justCreatedName, setJustCreatedName] = useState<string | null>(null);

  const handleParse = async () => {
    if (!url.trim()) return;
    setParsing(true);
    setParseError(null);
    try {
      // force_refresh: this is the ONE moment accuracy matters most — you're
      // about to decide what to monitor. It only ever fires once per modal
      // session (creating additional monitors here via "＋ 再新建一個" reuses
      // this same in-memory `frames` list, no re-parse), so forcing a live
      // fetch here doesn't cost any extra Figma API calls overall.
      const result = await listFigmaFrames(url.trim(), true);
      setFileKey(result.file_key);
      setFileName(result.file_name);
      setFrames(result.frames);
      setSelectedIds(new Set());
    } catch (e: any) {
      setParseError(e?.message || "解析失敗，請確認連結是否正確");
    } finally {
      setParsing(false);
    }
  };

  const toggleFrame = (id: string) => {
    if (usedFrameIds.has(id)) return; // already assigned to a monitor created earlier this session
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSave = async () => {
    if (!customName.trim() || selectedIds.size === 0 || !frames) return;
    setSaving(true);
    setSaveError(null);
    try {
      const chosen = frames.filter(f => selectedIds.has(f.frame_id));
      await createFigmaMonitor({
        custom_name: customName.trim(), file_key: fileKey, file_name: fileName,
        frame_ids: chosen.map(f => f.frame_id), frame_names: chosen.map(f => f.frame_name),
        teams_webhook_id: webhookId || undefined,
      });
      onCreated(); // refresh the monitors list in the background — modal stays open
      setUsedFrameIds(prev => new Set([...prev, ...chosen.map(f => f.frame_id)]));
      setJustCreatedName(customName.trim());
      setSelectedIds(new Set());
      setCustomName("");
    } catch (e: any) {
      setSaveError(e?.message || "儲存失敗");
    } finally {
      setSaving(false);
    }
  };

  const continueCreating = () => setJustCreatedName(null);

  const byPage: Record<string, FigmaFrame[]> = {};
  for (const f of frames ?? []) (byPage[f.page] = byPage[f.page] ?? []).push(f);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div className="w-full max-w-[480px] rounded-2xl overflow-hidden flex flex-col"
        style={{ background: "#fff", maxHeight: "85vh", boxShadow: "0 8px 40px rgba(0,0,0,0.25)" }}>
        <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: border }}>
          <div>
            <span style={{ color: "#6B5CF0" }}>● </span>
            <span className="text-[12px] font-medium uppercase tracking-wide" style={{ color: "#6e6e73" }}>新增 Frame 監控</span>
          </div>
          <button type="button" onClick={onClose} aria-label="關閉" className="hover:opacity-70 transition-opacity">
            <X style={{ width: 16, height: 16, color: "#86868b" }} />
          </button>
        </div>

        <div className="overflow-y-auto" style={{ flex: 1 }}>
          {/* Step 1: URL */}
          <div className="p-4 flex flex-col gap-3" style={frames ? { borderBottom: `1px solid ${border}` } : undefined}>
            <p className="text-[13px]" style={{ color: "#6e6e73" }}>貼上 Figma 分享連結，先解析檔案再選擇要監控的 Frame。</p>
            <input
              value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.figma.com/design/..."
              onKeyDown={e => { if (e.key === "Enter") handleParse(); }}
              className="w-full rounded-xl px-3 py-2.5 text-[13px] outline-none"
              style={{ border: `1px solid ${border}`, background: "rgba(0,0,0,0.02)", color: "#1d1d1f" }} />
            {parseError && <p className="text-[12px]" style={{ color: "#b91c1c" }}>{parseError}</p>}
            <button type="button" onClick={handleParse} disabled={parsing || !url.trim()}
              className="w-full py-3 rounded-xl font-semibold text-[15px] transition-opacity disabled:opacity-40"
              style={{ background: "var(--ns-accent)", color: "var(--ns-ink)" }}>
              {parsing ? "解析中…" : "解析檔案"}
            </button>
          </div>

          {/* Step 2: frame picker */}
          {frames && (
            <>
              <div className="px-4 py-2 border-b flex items-center gap-2" style={{ borderColor: border }}>
                <span className="text-[11px] font-mono truncate" style={{ color: "#86868b" }}>{fileName}</span>
                <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded-md shrink-0"
                  style={{ background: "rgba(107,92,240,0.08)", color: "#6B5CF0" }}>
                  已選 {selectedIds.size} / {frames.length}
                </span>
              </div>
              <div className="max-h-[240px] overflow-y-auto">
                {frames.length === 0 && (
                  <p className="p-3 text-[12.5px]" style={{ color: "#86868b" }}>此檔案沒有找到任何 Frame。</p>
                )}
                {Object.entries(byPage).map(([page, pageFrames]) => (
                  <div key={page}>
                    <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
                      style={{ color: "#86868b", background: "rgba(0,0,0,0.02)", borderBottom: `1px solid ${border}` }}>
                      {page}
                    </div>
                    {pageFrames.map(f => {
                      const checked = selectedIds.has(f.frame_id);
                      const used = usedFrameIds.has(f.frame_id);
                      return (
                        <button key={f.frame_id} type="button" onClick={() => toggleFrame(f.frame_id)} disabled={used}
                          className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors border-b disabled:cursor-not-allowed"
                          style={{ borderColor: border, background: checked ? "rgba(107,92,240,0.04)" : "transparent", opacity: used ? 0.45 : 1 }}>
                          <span className="shrink-0 w-4 h-4 rounded flex items-center justify-center"
                            style={{ border: checked ? "none" : "1.5px solid #c7c7cc", background: checked ? "#6B5CF0" : "transparent" }}>
                            {checked && (
                              <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                                <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            )}
                          </span>
                          <span className="flex-1 text-[13px] truncate" style={{ color: "#1d1d1f" }}>{f.frame_name}</span>
                          {used
                            ? <span className="shrink-0 text-[10px]" style={{ color: "#86868b" }}>已建立監控</span>
                            : <span className="shrink-0 text-[10px] font-mono" style={{ color: "#86868b" }}>{f.text_count} 文字</span>}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>

              {/* Step 3: success (choose to finish or add another) OR name + webhook + save */}
              {justCreatedName ? (
                <div className="p-4 flex flex-col gap-3">
                  <p className="text-[13.5px] font-medium" style={{ color: "#16a34a" }}>✓ 已建立監控「{justCreatedName}」</p>
                  <div className="flex gap-2">
                    <button type="button" onClick={onClose}
                      className="flex-1 py-2.5 rounded-xl font-semibold text-[14px] transition-opacity hover:opacity-70"
                      style={{ border: `1px solid ${border}`, color: "#1d1d1f" }}>
                      完成
                    </button>
                    <button type="button" onClick={continueCreating}
                      disabled={usedFrameIds.size >= frames.length}
                      className="flex-1 py-2.5 rounded-xl font-semibold text-[14px] transition-opacity disabled:opacity-40"
                      style={{ background: "var(--ns-accent)", color: "var(--ns-ink)" }}>
                      ＋ 再新建一個
                    </button>
                  </div>
                  {usedFrameIds.size >= frames.length && (
                    <p className="text-[11px]" style={{ color: "#86868b" }}>此檔案的 Frame 都已建立監控。</p>
                  )}
                </div>
              ) : (
                <div className="p-4 flex flex-col gap-3">
                  <input value={customName} onChange={e => setCustomName(e.target.value)} placeholder="監控名稱，例：登入頁監控"
                    className="w-full rounded-xl px-3 py-2.5 text-[13px] outline-none"
                    style={{ border: `1px solid ${border}`, background: "rgba(0,0,0,0.02)", color: "#1d1d1f" }} />
                  <div>
                    <select value={webhookId} onChange={e => setWebhookId(e.target.value)}
                      className="w-full rounded-xl px-3 py-2.5 text-[13px] outline-none"
                      style={{ border: `1px solid ${border}`, background: "rgba(0,0,0,0.02)", color: webhookId ? "#1d1d1f" : "#86868b" }}>
                      <option value="">Teams Webhook（選填，不設定也能之後再補）</option>
                      {webhooks.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                    <p className="mt-1 text-[11px]" style={{ color: "#86868b" }}>
                      {webhooks.length === 0
                        ? "還沒有建立任何 Webhook，可先關閉此視窗，點「Webhook 管理」新增。"
                        : "設定後可在監控卡片上按「發送到 Teams」推送比對結果。"}
                    </p>
                  </div>
                  {saveError && <p className="text-[12px]" style={{ color: "#b91c1c" }}>{saveError}</p>}
                  <button type="button" onClick={handleSave}
                    disabled={saving || !customName.trim() || selectedIds.size === 0}
                    className="w-full py-3 rounded-xl font-semibold text-[15px] transition-opacity disabled:opacity-40"
                    style={{ background: "var(--ns-accent)", color: "var(--ns-ink)" }}>
                    {saving ? "儲存中…" : "儲存監控"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── webhook manager modal ── */

function WebhookManagerModal({ webhooks, onClose, onChanged }: {
  webhooks: TeamsWebhook[]; onClose: () => void; onChanged: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const startEdit = (w: TeamsWebhook) => {
    setEditingId(w.id); setEditName(w.name); setEditUrl(w.url); setEditError(null);
  };

  const saveEdit = async () => {
    if (!editingId || !editName.trim() || !editUrl.trim()) return;
    setSavingEdit(true);
    setEditError(null);
    try {
      await updateTeamsWebhook(editingId, editName.trim(), editUrl.trim());
      setEditingId(null);
      onChanged();
    } catch (e: any) {
      setEditError(e?.message || "更新失敗");
    } finally {
      setSavingEdit(false);
    }
  };

  const addWebhook = async () => {
    if (!newName.trim() || !newUrl.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      await createTeamsWebhook(newName.trim(), newUrl.trim());
      setNewName("");
      setNewUrl("");
      onChanged();
    } catch (e: any) {
      setAddError(e?.message || "新增失敗");
    } finally {
      setAdding(false);
    }
  };

  const runDelete = async (id: string) => {
    setDeletingId(id);
    try { await deleteTeamsWebhook(id); onChanged(); }
    finally { setDeletingId(null); setConfirmDeleteId(null); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.4)" }}>
      <div className="w-full max-w-[480px] rounded-2xl overflow-hidden flex flex-col"
        style={{ background: "#fff", maxHeight: "85vh", boxShadow: "0 8px 40px rgba(0,0,0,0.25)" }}>
        <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: border }}>
          <div>
            <span style={{ color: "#6B5CF0" }}>● </span>
            <span className="text-[12px] font-medium uppercase tracking-wide" style={{ color: "#6e6e73" }}>Webhook 管理</span>
          </div>
          <button type="button" onClick={onClose} aria-label="關閉" className="hover:opacity-70 transition-opacity">
            <X style={{ width: 16, height: 16, color: "#86868b" }} />
          </button>
        </div>

        <div className="overflow-y-auto p-4 flex flex-col gap-2" style={{ flex: 1 }}>
          {webhooks.length === 0 && (
            <p className="text-[12.5px]" style={{ color: "#86868b" }}>還沒有任何 Webhook，於下方新增。</p>
          )}
          {webhooks.map(w => (
            <div key={w.id} className="rounded-xl p-3" style={{ border: `1px solid ${border}` }}>
              {editingId === w.id ? (
                <div className="flex flex-col gap-2">
                  <input value={editName} onChange={e => setEditName(e.target.value)} placeholder="名稱"
                    className="w-full rounded-lg px-2.5 py-2 text-[13px] outline-none"
                    style={{ border: `1px solid ${border}` }} />
                  <input value={editUrl} onChange={e => setEditUrl(e.target.value)} placeholder="URL"
                    className="w-full rounded-lg px-2.5 py-2 text-[13px] outline-none font-mono"
                    style={{ border: `1px solid ${border}` }} />
                  {editError && <p className="text-[11.5px]" style={{ color: "#b91c1c" }}>{editError}</p>}
                  <div className="flex items-center gap-2 justify-end">
                    <button type="button" onClick={() => setEditingId(null)} className="text-[12px]" style={{ color: "#86868b" }}>取消</button>
                    <button type="button" onClick={saveEdit} disabled={savingEdit || !editName.trim() || !editUrl.trim()}
                      className="text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-40"
                      style={{ background: "var(--ns-accent)", color: "var(--ns-ink)" }}>
                      {savingEdit ? "儲存中…" : "儲存"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-[13px] truncate" style={{ color: "#1d1d1f" }}>{w.name}</div>
                    <div className="text-[11px] truncate font-mono" style={{ color: "#86868b" }}>{w.url}</div>
                  </div>
                  <button type="button" onClick={() => startEdit(w)} className="shrink-0 hover:opacity-70 transition-opacity" title="編輯">
                    <Pencil style={{ width: 13, height: 13, color: "#86868b" }} />
                  </button>
                  {confirmDeleteId === w.id ? (
                    <div className="flex items-center gap-1.5 shrink-0 text-[11px]">
                      <button type="button" onClick={() => runDelete(w.id)} disabled={deletingId === w.id} style={{ color: "#ff3b30", fontWeight: 600 }}>確定</button>
                      <button type="button" onClick={() => setConfirmDeleteId(null)} style={{ color: "#86868b" }}>取消</button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setConfirmDeleteId(w.id)} className="shrink-0 hover:opacity-70 transition-opacity" title="刪除">
                      <Trash2 style={{ width: 13, height: 13, color: "#86868b" }} />
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="p-4 flex flex-col gap-2" style={{ borderTop: `1px solid ${border}` }}>
          <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "#86868b" }}>新增 Webhook</div>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="名稱，例：PM 頻道"
            className="w-full rounded-xl px-3 py-2.5 text-[13px] outline-none"
            style={{ border: `1px solid ${border}`, background: "rgba(0,0,0,0.02)", color: "#1d1d1f" }} />
          <input value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="Teams Incoming Webhook URL"
            className="w-full rounded-xl px-3 py-2.5 text-[13px] outline-none font-mono"
            style={{ border: `1px solid ${border}`, background: "rgba(0,0,0,0.02)", color: "#1d1d1f" }} />
          {addError && <p className="text-[12px]" style={{ color: "#b91c1c" }}>{addError}</p>}
          <button type="button" onClick={addWebhook} disabled={adding || !newName.trim() || !newUrl.trim()}
            className="w-full py-2.5 rounded-xl font-semibold text-[14px] transition-opacity disabled:opacity-40"
            style={{ background: "var(--ns-accent)", color: "var(--ns-ink)" }}>
            {adding ? "新增中…" : "＋ 新增 Webhook"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── main panel ── */

export default function FigmaMonitorPanel() {
  const [monitors, setMonitors] = useState<FigmaMonitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [webhooks, setWebhooks] = useState<TeamsWebhook[]>([]);
  const [showWebhookManager, setShowWebhookManager] = useState(false);
  const [checkingAll, setCheckingAll] = useState(false);
  const [batchSummary, setBatchSummary] = useState<
    { total: number; errors: number; changed: number; firstError?: string } | null
  >(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try { setMonitors(await listFigmaMonitors()); }
    catch (e: any) { setLoadError(e?.message || "載入失敗"); }
    finally { setLoading(false); }
  }, []);

  const refreshWebhooks = useCallback(async () => {
    try { setWebhooks(await listTeamsWebhooks()); } catch { /* keep last known list */ }
  }, []);

  useEffect(() => { refresh(); refreshWebhooks(); }, [refresh, refreshWebhooks]);

  const runCheckAll = async () => {
    setCheckingAll(true);
    setBatchSummary(null);
    try {
      const results = await checkAllFigmaMonitors();
      const errors = results.filter(r => r.error);
      const changed = results.filter(r => !r.error && r.diff &&
        (r.diff.added.length + r.diff.removed.length + r.diff.modified.length) > 0);
      setBatchSummary({ total: results.length, errors: errors.length, changed: changed.length, firstError: errors[0]?.error });
    } catch (e: any) {
      setBatchSummary({ total: 0, errors: 1, changed: 0, firstError: e?.message || "批次比對失敗" });
    } finally {
      setCheckingAll(false);
      refresh();
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-[26px] font-extrabold tracking-[-0.03em] leading-none" style={{ color: "#1d1d1f" }}>
            Frame 監控
          </h1>
          <p className="text-[14px] mt-2 leading-relaxed max-w-[560px]" style={{ color: "#6e6e73" }}>
            追蹤指定 Frame 的文字內容變化，手動觸發比對並保留每次檢查的歷史紀錄。
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" onClick={runCheckAll} disabled={checkingAll || monitors.length === 0}
            title="依所在檔案分組，同一份檔案只呼叫一次 Figma API"
            className="flex items-center gap-1.5 font-semibold text-[13.5px] px-4 py-2.5 rounded-xl transition-opacity hover:opacity-70 disabled:opacity-40"
            style={{ color: "#6B5CF0", border: "1px solid rgba(107,92,240,0.3)" }}>
            {checkingAll ? <Loader2 style={{ width: 14, height: 14 }} className="animate-spin" /> : <RefreshCcw style={{ width: 14, height: 14 }} />}
            全部手動比對
          </button>
          <button type="button" onClick={() => setShowWebhookManager(true)}
            className="flex items-center gap-1.5 font-semibold text-[13.5px] px-4 py-2.5 rounded-xl transition-opacity hover:opacity-70"
            style={{ color: "#6B5CF0", border: "1px solid rgba(107,92,240,0.3)" }}>
            <Settings2 style={{ width: 14, height: 14 }} />
            Webhook 管理
          </button>
          <button type="button" onClick={() => setShowCreate(true)}
            className="font-semibold text-[13.5px] px-4 py-2.5 rounded-xl transition-opacity hover:opacity-90"
            style={{ background: "var(--ns-accent)", color: "var(--ns-ink)" }}>
            ＋ 新增監控
          </button>
        </div>
      </div>

      {batchSummary && (
        batchSummary.errors === batchSummary.total && batchSummary.total > 0 ? (
          <p className="text-[12.5px]" style={{ color: "#ff3b30" }}>{batchSummary.firstError}</p>
        ) : batchSummary.errors > 0 ? (
          <p className="text-[12.5px]" style={{ color: "#d97706" }}>
            已比對 {batchSummary.total - batchSummary.errors} 個，{batchSummary.errors} 個失敗：{batchSummary.firstError}
          </p>
        ) : (
          <p className="text-[12.5px]" style={{ color: "#16a34a" }}>
            ✓ 已比對 {batchSummary.total} 個監控，{batchSummary.changed} 個有變化
          </p>
        )
      )}

      <div className="pt-2 flex flex-col gap-3">
        {loading && <p className="text-[13px]" style={{ color: "#86868b" }}>載入中…</p>}
        {loadError && <p className="text-[13px]" style={{ color: "#ff3b30" }}>{loadError}</p>}
        {!loading && !loadError && monitors.length === 0 && (
          <div className="rounded-2xl flex flex-col items-center justify-center text-center py-12 px-6"
            style={{ border: `1px solid ${border}`, background: "#fff" }}>
            <Radar style={{ width: 30, height: 30, color: "#6B5CF0", opacity: 0.5, marginBottom: 12 }} />
            <p className="text-[13.5px]" style={{ color: "#6e6e73" }}>還沒有任何監控項目，點右上角「＋ 新增監控」開始追蹤 Frame 變化。</p>
          </div>
        )}
        {monitors.map(m => <MonitorCard key={m.id} monitor={m} webhooks={webhooks} onChanged={refresh} />)}
      </div>

      {showCreate && (
        <CreateMonitorModal webhooks={webhooks} onClose={() => setShowCreate(false)}
          onCreated={refresh} />
      )}

      {showWebhookManager && (
        <WebhookManagerModal webhooks={webhooks} onClose={() => setShowWebhookManager(false)}
          onChanged={() => { refreshWebhooks(); refresh(); }} />
      )}
    </div>
  );
}
