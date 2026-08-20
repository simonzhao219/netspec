"use client";

import { create } from "zustand";
import {
  SessionState,
  SpecResult,
  IterationMeta,
  SSEEvent,
  ToolCallEvent,
  SecurityState,
  SecurityAlertItem,
} from "@/lib/types";
import { RateLimitError, DailyLimitError, ValidationError } from "@/lib/api";
import {
  createSession,
  startSession,
  resumeSession,
  iterateSession,
  generateRole,
  getSession,
  getIteration,
  openEventStream,
} from "@/lib/api";

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export interface TranslationCache {
  spec_document?: string;
  edge_cases?: any[];
  validation_issues?: any[];
}

interface NetSpecStore {
  // State
  sessionId: string | null;
  status: "idle" | "running" | "interrupted" | "complete" | "error";
  requirement: string;        // persisted so InputPanel can restore it after unmount
  backendClarityScore: number | null;
  loadedHistoryId: string | null;   // SQLite session ID currently loaded (to avoid duplicate in sidebar)
  stepsCompleted: number;
  activeStep: number;         // step number from the most recent step_start event
  currentInterruptType: string | null;
  currentInterruptData: any;
  lastSocraticData: any;   // saved for "修改回答" to re-show previous questions
  result: SpecResult | null;
  iterations: IterationMeta[];
  currentIteration: number;
  roleViewLoading: Record<string, boolean>;   // architect / qa generation in flight
  logEntries: { time: string; agent: string; text: string }[];
  error: string | null;
  eventSource: EventSource | null;
  cachedTranslation: TranslationCache | null;  // EN translation persisted across page loads
  currentThought: string;
  thoughtHistory: { step: number; thought: string }[];
  toolCalls: ToolCallEvent[];
  stepAgents: Record<number, string>;   // model name per step from SSE
  llmMode: "ollama" | "api";            // current LLM mode from backend
  securityState: SecurityState | null;
  rateLimitState: { type: 'rate' | 'daily'; message: string; retryAfter?: number; used?: number; limit?: number } | null;

  // Internal setters (used by actions)
  _set: (partial: Partial<Omit<NetSpecStore, "_set">>) => void;

  // Actions
  startAnalysis: (requirement: string, detailLevel?: string) => Promise<void>;
  resumeSocratic: (
    answers:
      | Record<string, string>
      | { __proceed__: boolean }
      | { __skip__: boolean }
  ) => Promise<void>;
  proceedFromSocratic: () => Promise<void>;
  skipSocratic: () => Promise<void>;
  continueMoreQuestions: (answers: Record<string, string>) => Promise<void>;
  confirmPlan: (modifiedKeywords?: string[]) => Promise<void>;
  triggerIteration: (feedback?: string) => Promise<void>;
  generateRoleView: (role: "architect" | "qa") => Promise<void>;
  loadIteration: (iterNum: number) => Promise<void>;
  loadHistorySession: (sessionId: string) => Promise<void>;
  resetToHome: () => void;   // click logo → clear everything, show onboarding
  closeStream: () => void;
  saveTranslation: (cache: TranslationCache) => Promise<void>;
  syncLlmMode: () => Promise<void>;   // read current mode from backend health
}

// ---------------------------------------------------------------------------
// Zustand store
// ---------------------------------------------------------------------------

const useNetSpecStore = create<NetSpecStore>((set, get) => ({
  // Initial state
  sessionId: null,
  status: "idle",
  requirement: "",
  backendClarityScore: null,
  loadedHistoryId: null,
  stepsCompleted: 0,
  activeStep: 0,
  currentInterruptType: null,
  currentInterruptData: null,
  lastSocraticData: null,
  result: null,
  iterations: [],
  currentIteration: 0,
  roleViewLoading: {},
  logEntries: [],
  error: null,
  eventSource: null,
  cachedTranslation: null,
  currentThought: "",
  thoughtHistory: [],
  toolCalls: [],
  stepAgents: {},
  llmMode: "ollama" as const,
  securityState: null,
  rateLimitState: null,

  _set: (partial) => set(partial as any),

  // -------------------------------------------------------------------------
  // startAnalysis
  // -------------------------------------------------------------------------
  startAnalysis: async (requirement: string, detailLevel: string = "standard") => {
    const { closeStream, _set } = get();

    // Clean up any existing stream
    closeStream();

    _set({
      status: "running",
      requirement,
      backendClarityScore: null,
      loadedHistoryId: null,
      stepsCompleted: 0,
      activeStep: 0,
      currentInterruptType: null,
      currentInterruptData: null,
      lastSocraticData: null,
      result: null,
      iterations: [],
      currentIteration: 0,
      logEntries: [],
      error: null,
      sessionId: null,
      eventSource: null,
      currentThought: "",
      thoughtHistory: [],
      toolCalls: [],
      stepAgents: {},
      securityState: null,
      rateLimitState: null,
    });

    try {
      // 1. Create the session
      const { session_id } = await createSession();

      // 2. Open the SSE stream BEFORE starting the pipeline so we don't miss events
      const es = openEventStream(session_id);

      es.onmessage = (ev: MessageEvent) => {
        handleSSEMessage(ev, session_id);
      };

      es.onerror = () => {
        // (B1) Tolerate transient drops: the browser auto-reconnects while
        // readyState === CONNECTING, and the fresh `connected` frame rehydrates.
        // Only hard-fail when the connection is truly CLOSED and not yet complete.
        if (es.readyState === EventSource.CLOSED && get().status !== "complete") {
          get()._set({ status: "error", error: "連線中斷，請重試（或重新整理）" });
        }
      };

      _set({ sessionId: session_id, eventSource: es });

      // 3. Start the pipeline
      await startSession(session_id, requirement, { detail_level: detailLevel });
    } catch (err: any) {
      if (err instanceof RateLimitError) {
        get()._set({
          status: "error",
          error: err.message,
          rateLimitState: { type: 'rate', message: err.message, retryAfter: err.retryAfter, limit: err.limit },
        });
      } else if (err instanceof DailyLimitError) {
        get()._set({
          status: "error",
          error: err.message,
          rateLimitState: { type: 'daily', message: err.message, used: err.used, limit: err.limit },
        });
      } else {
        get()._set({ status: "error", error: err?.message ?? "Failed to start analysis." });
      }
    }
  },

  // -------------------------------------------------------------------------
  // resumeSocratic
  // -------------------------------------------------------------------------
  resumeSocratic: async (
    answers:
      | Record<string, string>
      | { __proceed__: boolean }
      | { __skip__: boolean }
  ) => {
    const { sessionId, _set } = get();
    if (!sessionId) return;

    try {
      _set({ status: "running", currentInterruptType: null, currentInterruptData: null });
      await resumeSession(sessionId, { answers: answers as Record<string, string> });
    } catch (err: any) {
      _set({ status: "error", error: err?.message ?? "Failed to resume session." });
    }
  },

  // -------------------------------------------------------------------------
  // proceedFromSocratic
  // -------------------------------------------------------------------------
  proceedFromSocratic: async () => {
    return get().resumeSocratic({ __proceed__: true });
  },

  // -------------------------------------------------------------------------
  // skipSocratic
  // -------------------------------------------------------------------------
  skipSocratic: async () => {
    return get().resumeSocratic({ __skip__: true });
  },

  // -------------------------------------------------------------------------
  // continueMoreQuestions — restart pipeline with pre-loaded answers for more Socratic
  // -------------------------------------------------------------------------
  continueMoreQuestions: async (existingAnswers: Record<string, string>) => {
    const { requirement, currentInterruptData, closeStream, _set } = get();
    if (!requirement) return;

    // Close current stream and start fresh
    closeStream();

    _set({
      status: "running",
      stepsCompleted: 0,
      activeStep: 0,
      currentInterruptType: null,
      currentInterruptData: null,
      lastSocraticData: null,
      result: null,
      iterations: [],
      currentIteration: 0,
      logEntries: [],
      error: null,
      sessionId: null,
      eventSource: null,
    });

    try {
      // Create a new session — pre-load existing answers and covered dimensions
      const { session_id } = await createSession();

      // Open SSE stream before starting
      const es = openEventStream(session_id);
      es.onmessage = (ev: MessageEvent) => handleSSEMessage(ev, session_id);
      es.onerror = () => {
        // (B1) tolerate transient reconnects — only hard-fail when truly CLOSED
        if (es.readyState === EventSource.CLOSED && get().status !== "complete") {
          get()._set({ status: "error", error: "連線中斷，請重試（或重新整理）" });
        }
      };

      _set({ sessionId: session_id, eventSource: es });

      // Start with pre-loaded answers from previous session so Socratic asks NEW dimensions
      const coveredDims = (currentInterruptData as any)?.covered_dimensions ?? [];
      await fetch(`/api/sessions/${session_id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requirement,
          initial_answers: existingAnswers,
          initial_covered_dimensions: coveredDims,
        }),
      });
    } catch (err: any) {
      get()._set({ status: "error", error: err?.message ?? "Failed to continue." });
    }
  },

  // -------------------------------------------------------------------------
  // confirmPlan
  // -------------------------------------------------------------------------
  confirmPlan: async (modifiedKeywords?: string[]) => {
    const { sessionId, _set } = get();
    if (!sessionId) return;

    try {
      _set({ status: "running", currentInterruptType: null, currentInterruptData: null });
      await resumeSession(sessionId, {
        confirmed: true,
        ...(modifiedKeywords?.length ? { modified_keywords: modifiedKeywords } : {}),
      });
    } catch (err: any) {
      _set({ status: "error", error: err?.message ?? "Failed to confirm plan." });
    }
  },

  // -------------------------------------------------------------------------
  // triggerIteration
  // -------------------------------------------------------------------------
  triggerIteration: async (feedback?: string) => {
    const { sessionId, _set } = get();
    if (!sessionId) return;

    try {
      // Immediately show step 7 (PRD generation) so overlay never shows step 1
      _set({ status: "running", stepsCompleted: 6, activeStep: 7, currentThought: "", rateLimitState: null });
      await iterateSession(sessionId, feedback);
    } catch (err: any) {
      // (A4) classify rate/daily limits so ResultsPanel can show quota messaging,
      // mirroring startAnalysis — otherwise the user sees the stale spec with no feedback.
      if (err instanceof RateLimitError) {
        _set({ status: "error", error: err.message,
               rateLimitState: { type: 'rate', message: err.message, retryAfter: err.retryAfter, limit: err.limit } });
      } else if (err instanceof DailyLimitError) {
        _set({ status: "error", error: err.message,
               rateLimitState: { type: 'daily', message: err.message, used: err.used, limit: err.limit } });
      } else {
        _set({ status: "error", error: err?.message ?? "優化失敗，請重試。" });
      }
    }
  },

  // -------------------------------------------------------------------------
  // generateRoleView — derive an architect / QA view from the current PM spec
  // -------------------------------------------------------------------------
  generateRoleView: async (role: "architect" | "qa") => {
    const { sessionId, result, currentIteration, roleViewLoading, _set } = get();
    if (!sessionId || !result) return;
    _set({ roleViewLoading: { ...roleViewLoading, [role]: true } });
    try {
      const view = await generateRole(sessionId, role, currentIteration || 1);
      const cur = get().result;
      if (!cur) return;
      _set({
        result: { ...cur, role_views: { ...(cur.role_views ?? {}), [role]: view } },
        roleViewLoading: { ...get().roleViewLoading, [role]: false },
      });
    } catch (err: any) {
      _set({ roleViewLoading: { ...get().roleViewLoading, [role]: false },
             error: err?.message ?? "角色視圖生成失敗" });
    }
  },

  // -------------------------------------------------------------------------
  // loadIteration
  // -------------------------------------------------------------------------
  loadIteration: async (iterNum: number) => {
    const { sessionId, loadedHistoryId, _set } = get();
    if (!sessionId) return;

    try {
      let result: any;
      let cachedTranslation: TranslationCache | null = null;

      if (loadedHistoryId) {
        // History-loaded session: the in-memory session has only one fake iteration.
        // Always fetch from DB using the original history session ID.
        const raw = await fetch(
          `/api/history/${loadedHistoryId}/iterations/${iterNum}`
        ).then(r => r.ok ? r.json() : Promise.reject(new Error(`Iteration ${iterNum} not found`)));
        cachedTranslation = raw._translation ?? null;
        delete raw._translation;
        result = raw;
      } else {
        // Fresh in-memory session: use the session API
        const data = await getIteration(sessionId, iterNum);
        result = data.result ?? data;
      }

      // Sync backend session.result so "優化迭代" uses this version as base
      await fetch(`/api/sessions/${sessionId}/load-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result }),
      }).catch(() => null);

      _set({ result, currentIteration: iterNum, cachedTranslation });
    } catch (err: any) {
      _set({ error: err?.message ?? "Failed to load iteration." });
    }
  },

  // -------------------------------------------------------------------------
  // loadHistorySession — load a past session from SQLite + create new session for re-iteration
  // -------------------------------------------------------------------------
  loadHistorySession: async (histSessionId: string) => {
    const { closeStream, _set } = get();
    try {
      // Fetch iterations list for this historical session
      const iters = await fetch(`/api/history/${histSessionId}/iterations`)
        .then(r => r.ok ? r.json() : []);
      if (!iters.length) return;

      // Load the latest iteration's full result
      const latest = iters[iters.length - 1];
      const result = await fetch(
        `/api/history/${histSessionId}/iterations/${latest.iteration_num}`
      ).then(r => r.ok ? r.json() : null);

      if (!result) return;

      // Resume the history session IN PLACE (reuse its id) so 優化 keeps appending
      // versions to the SAME session/card instead of forking a new one.
      closeStream();
      const sid = histSessionId;

      // Open SSE stream RIGHT NOW so iteration events will arrive
      const es = openEventStream(sid);
      es.onmessage = (ev: MessageEvent) => handleSSEMessage(ev, sid);
      es.onerror = () => {
        // (B1) tolerate transient reconnects — only hard-fail when truly CLOSED
        if (es.readyState === EventSource.CLOSED && get().status !== "complete") {
          get()._set({ status: "error", error: "連線中斷，請重試（或重新整理）" });
        }
      };

      // Pre-load the historical result + iteration history so iterate numbering continues
      await fetch(`/api/sessions/${sid}/load-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          result,
          iterations: iters.map((it: any) => ({
            iteration: it.iteration_num,
            timestamp: it.created_at,
            quality_score: it.quality_score,
            validation_passed: it.validation_passed,
            feature_name: it.feature_name,
          })),
        }),
      }).catch(() => null);

      if (result) {
        // Extract cached EN translation from result (added by backend)
        const cachedTranslation: TranslationCache | null = result._translation ?? null;
        delete result._translation;

        _set({
          sessionId: sid,
          eventSource: es,           // ← 保存 EventSource，確保 iteration 事件能收到
          result,
          status: "complete",
          requirement: result.requirement || "",
          loadedHistoryId: histSessionId,
          currentIteration: latest.iteration_num,
          cachedTranslation,
          iterations: iters.map((it: any) => ({
            iteration: it.iteration_num,
            timestamp: it.created_at,
            quality_score: it.quality_score,
            validation_passed: !!it.validation_passed,
            feature_name: it.feature_name || "",
          })),
          error: null,
          logEntries: [],
        });
      }
    } catch (err: any) {
      _set({ error: err?.message ?? "Failed to load history." });
    }
  },

  // -------------------------------------------------------------------------
  // resetToHome — logo click: close stream + clear all state → shows onboarding
  // -------------------------------------------------------------------------
  resetToHome: () => {
    const { eventSource } = get();
    if (eventSource) { eventSource.close(); }
    useNetSpecStore.setState({
      sessionId: null,
      status: "idle",
      requirement: "",
      backendClarityScore: null,
      loadedHistoryId: null,
      stepsCompleted: 0,
      activeStep: 0,
      currentInterruptType: null,
      currentInterruptData: null,
      lastSocraticData: null,
      result: null,
      iterations: [],
      currentIteration: 0,
      logEntries: [],
      error: null,
      eventSource: null,
      cachedTranslation: null,
      currentThought: "",
      thoughtHistory: [],
      toolCalls: [],
      stepAgents: {},
      securityState: null,
      rateLimitState: null,
    });
  },

  // -------------------------------------------------------------------------
  // saveTranslation — persist EN translation to DB via backend API
  // -------------------------------------------------------------------------
  saveTranslation: async (cache: TranslationCache) => {
    const { sessionId, loadedHistoryId, currentIteration, _set } = get();
    // Save under the original history session ID if loaded, otherwise current session
    const targetSession = loadedHistoryId || sessionId;
    if (!targetSession || !currentIteration) return;
    try {
      await fetch(
        `/api/history/${targetSession}/iterations/${currentIteration}/translation`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cache),
        }
      );
      _set({ cachedTranslation: cache });
    } catch {
      // Non-fatal — translation still works, just not persisted
    }
  },

  // -------------------------------------------------------------------------
  // syncLlmMode — read current mode from backend health endpoint
  // -------------------------------------------------------------------------
  syncLlmMode: async () => {
    try {
      const d = await fetch("/api/health").then(r => r.ok ? r.json() : null);
      if (d) {
        const mode: "ollama" | "api" = d.rate_limit_mode === "api" ? "api" : "ollama";
        get()._set({ llmMode: mode });
      }
    } catch { /* silent */ }
  },

  // -------------------------------------------------------------------------
  // closeStream
  // -------------------------------------------------------------------------
  closeStream: () => {
    const { eventSource } = get();
    if (eventSource) {
      eventSource.close();
      set({ eventSource: null });
    }
  },
}));

// ---------------------------------------------------------------------------
// SSE event handler (module-level to avoid closure issues)
// ---------------------------------------------------------------------------

// Backend SSE event shapes (actual wire format from FastAPI backend):
// { type: "connected", session_id, status }
// { type: "step_start", node, step, title, agent, phase }
// { type: "step_complete", node, step, title, log_message }
// { type: "interrupt", interrupt_type, data: { type, round, questions, ... } }
// { type: "iterate_start", iteration }
// { type: "iterate_complete", iteration, quality_score, result, ... }
// { type: "complete", result }
// { type: "error", message }
// { type: "heartbeat" }

function handleSSEMessage(ev: MessageEvent, sessionId: string) {
  let parsed: any;
  try {
    parsed = JSON.parse(ev.data);
  } catch {
    return;
  }

  const store = useNetSpecStore.getState();
  const _set = store._set;

  switch (parsed.type) {
    case "connected": {
      // (B1) On a RE-connect after a transient drop, the enriched connected frame
      // lets us rehydrate the UI to the session's current state (an event may have
      // been consumed by the dropped connection before it died). No-op on first
      // connect (status idle/running with nothing pending) — live events drive it.
      if (parsed.status === "interrupted" && parsed.interrupt_type) {
        const update: any = {
          status: "interrupted",
          currentInterruptType: parsed.interrupt_type,
          currentInterruptData: parsed.interrupt_data ?? null,
        };
        if (parsed.interrupt_type === "socratic") update.lastSocraticData = parsed.interrupt_data ?? store.lastSocraticData;
        _set(update);
      } else if (parsed.status === "complete" && parsed.result) {
        _set({ status: "complete", result: parsed.result, currentInterruptType: null, currentInterruptData: null, error: null });
      } else if (parsed.status === "error" && parsed.error) {
        _set({ status: "error", error: parsed.error });
      }
      break;
    }

    case "step_start": {
      const stepNum = typeof parsed.step === "number" ? parsed.step : store.activeStep;
      const thought = parsed.thought ?? "";
      const agent   = parsed.agent ?? "";
      const newHistory = thought
        ? [...store.thoughtHistory.filter(t => t.step !== stepNum), { step: stepNum, thought }]
        : store.thoughtHistory;
      const newAgents = agent
        ? { ...store.stepAgents, [stepNum]: agent }
        : store.stepAgents;
      _set({ status: "running", activeStep: stepNum, currentThought: thought, thoughtHistory: newHistory, stepAgents: newAgents });
      break;
    }

    case "step_complete": {
      const stepNum = typeof parsed.step === "number" ? parsed.step : null;
      const newSteps = stepNum !== null
        ? Math.max(store.stepsCompleted, stepNum)
        : store.stepsCompleted + 1;
      const newLog = parsed.log_message
        ? [
            ...store.logEntries,
            {
              time: new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
              agent: parsed.title ?? "Agent",
              text: parsed.log_message,
            },
          ]
        : store.logEntries;

      // Step 1 (parse): extract backend clarity score from log message
      // e.g. "清晰度評分：65/100。..."
      let backendScore = store.backendClarityScore;
      if (stepNum === 1 && parsed.log_message) {
        const m = parsed.log_message.match(/(\d+)\/100/);
        if (m) backendScore = parseInt(m[1], 10);
      }

      // Accumulate tool calls from this step
      const newToolCalls = Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0
        ? [...store.toolCalls, ...parsed.tool_calls]
        : store.toolCalls;

      _set({ stepsCompleted: newSteps, logEntries: newLog, backendClarityScore: backendScore, toolCalls: newToolCalls });
      break;
    }

    case "interrupt": {
      // Backend: { type:"interrupt", interrupt_type:"socratic", data:{...} }
      const itype = parsed.interrupt_type ?? parsed.data?.type ?? null;
      const idata = parsed.data ?? null;
      const update: any = {
        status: "interrupted",
        currentInterruptType: itype,
        currentInterruptData: idata,
      };
      // Save socratic data so "修改回答" can re-show it
      if (itype === "socratic") {
        update.lastSocraticData = idata;
      }
      _set(update);
      break;
    }

    case "iterate_start":
      // Reset stepsCompleted to 6 so ProgressOverlay shows step 7 (PRD re-gen) as active
      _set({ status: "running", stepsCompleted: 6, activeStep: 7, currentThought: "" });
      break;

    case "iterate_complete": {
      const meta: IterationMeta = {
        iteration: parsed.iteration,
        timestamp: Date.now() / 1000,
        quality_score: parsed.quality_score ?? 0,
        validation_passed: parsed.validation_passed ?? false,
        feature_name: parsed.result?.spec_sections?.feature_name ?? "",
      };
      const updated = store.iterations.filter(it => it.iteration !== parsed.iteration);
      updated.push(meta);
      _set({
        status: "complete",
        result: parsed.result ?? store.result,
        iterations: updated,
        currentIteration: parsed.iteration,
        currentInterruptType: null,
        currentInterruptData: null,
      });
      break;
    }

    case "complete": {
      // Backend: { type:"complete", result:{...} }
      const res = parsed.result ?? null;
      // First generation = version 1. The backend only persists iterations once the
      // user actually iterates, so synthesize the v1 entry now — otherwise the version
      // badge / 優化 button show "v0" and the current-session card never appears.
      const v1: IterationMeta = {
        iteration: 1,
        timestamp: Date.now() / 1000,
        quality_score: res?.validation_score ?? 0,
        validation_passed: res?.validation_passed ?? false,
        feature_name: res?.spec_sections?.feature_name ?? "",
      };
      _set({
        status: "complete",
        result: res,
        currentIteration: 1,
        iterations: store.iterations.length ? store.iterations : [v1],
        currentInterruptType: null,
        currentInterruptData: null,
        error: null,
      });
      // Refresh iterations list from API — but only replace if it actually has data
      if (sessionId) {
        getSession(sessionId)
          .then((session: any) => {
            if (Array.isArray(session?.iterations) && session.iterations.length > 0) {
              useNetSpecStore.getState()._set({ iterations: session.iterations });
            }
          })
          .catch(() => {});
      }
      break;
    }

    case "security_block":
      // Layer 2: attack intent — pipeline blocked
      _set({
        status: "error",
        error: parsed.message ?? "安全檢查未通過",
        securityState: {
          blocked: true,
          blockAlert: {
            category: parsed.category ?? "attack_intent",
            message: parsed.message ?? "",
            detected: parsed.detected ?? [],
            suggestion: parsed.suggestion ?? "",
          },
          warnings: [],
        },
      });
      break;

    case "security_warning":
      // Layer 1 + 3: sensitive info or injection — warnings only, pipeline continues
      _set({
        securityState: {
          blocked: false,
          blockAlert: null,
          warnings: (parsed.warnings ?? []) as SecurityAlertItem[],
          maskedRequirement: parsed.masked_requirement,
        },
      });
      break;

    case "error":
      _set({ status: "error", error: parsed.message ?? "Unknown error" });
      break;

    case "heartbeat":
      break;
  }
}

// ---------------------------------------------------------------------------
// Public hook
// ---------------------------------------------------------------------------

export function useNetSpec() {
  return useNetSpecStore();
}

export default useNetSpec;
