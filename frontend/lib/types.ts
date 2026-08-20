export interface PipelineStep {
  id: string;
  step: number;
  title: string;
  agent: string;
  phase: string;
  status: 'pending' | 'active' | 'done';
}

export interface SocraticQuestion {
  key: string;
  question: string;
  why_critical: string;
  example_answer: string;
  options?: string[];    // SKILL 💡 options list (clickable chips)
  closing?: string;      // SKILL open closing sentence
}

export interface SocraticInterrupt {
  type: 'socratic';
  round: number;
  max_rounds: number;
  is_last_round: boolean;
  questions: SocraticQuestion[];
  clarity_score: number;
  threshold_met: boolean;
  clarity_analysis: string;
}

export interface SearchQuery {
  keyword: string;
  source: 'reddit' | 'github' | 'hn';
  rationale: string;
  category?: 'known_bug' | 'security_cve' | 'production_failure' | 'rfc_interop' | 'performance';
}

export interface PlanConfirmInterrupt {
  type: 'plan_confirm';
  plan: SearchQuery[];
  research_summary: string;
  collected_answers: Record<string, string>;
  clarity_score: number;
  protocols: string[];
  req_type: string;
}

export interface EdgeCase {
  risk: 'high' | 'mid' | 'low';
  title: string;
  description: string;
  trigger_condition: string;
  impact: string;
  detection: string;
}

export interface DisasterPattern {
  title: string;
  description: string;
  root_cause: string;
  mitigation: string;
  source_urls?: { source: string; title: string; url: string }[];
}

export interface Citation {
  source: 'reddit' | 'github' | 'hn';
  title: string;
  url: string;
  stars?: number;
}

export interface ToolCallEvent {
  tool: string;
  step: number;
  input_summary: string;
  output_summary: string;
  duration_ms: number;
}

export interface SecurityAlertItem {
  category: "sensitive_info" | "attack_intent" | "prompt_injection";
  message: string;
  detected: string[];
  suggestion: string;
}

export interface SecurityState {
  blocked: boolean;
  blockAlert: SecurityAlertItem | null;
  warnings: SecurityAlertItem[];
  maskedRequirement?: string;
}

export interface Requirement {
  id: string;
  title: string;
  description: string;
  priority: 'Must Have' | 'Should Have' | 'Nice to Have';
  acceptance_criteria: string[];
}

export interface SpecSections {
  feature_name: string;
  business_objective: string;
  scope: string;
  out_of_scope: string;
  requirements: Requirement[];
  performance_sla: string;
  dependencies: string;
}

export interface SpecResult {
  requirement: string;
  req_type: string;
  protocols: string[];
  clarity_score: number;
  edge_cases: EdgeCase[];
  spec_document: string;
  spec_sections: SpecSections;
  disaster_patterns: DisasterPattern[];
  citations: Citation[];
  validation_score: number;
  validation_passed: boolean;
  validation_issues: string[];
  validation_summary: string;
  log: string[];
  role_views?: Record<string, RoleView>;   // architect / qa — derived on demand from this PM spec
  issue_delta?: IssueDelta;                 // present on iterated versions — why the score moved
}

// Score-transparency: diff between the previous iteration's issues and this one's.
export interface IssueDelta {
  prev_score: number | null;
  score: number;
  score_change: number | null;
  resolved: any[];     // issues present in prev, gone now (fixed)
  introduced: any[];   // issues that newly appeared (may explain a score drop)
}

export interface RoleView {
  document: string;
  sections: any;
  based_on_iteration: number;
  generated_at: number;
}

export interface IterationMeta {
  iteration: number;
  timestamp: string | number;
  quality_score: number;
  validation_passed: boolean;
  feature_name: string;
}

export interface SessionState {
  sessionId: string;
  status: 'idle' | 'running' | 'interrupted' | 'complete' | 'error';
  stepsCompleted: number;
  result?: SpecResult;
  iterations: IterationMeta[];
  currentIteration: number;
  error?: string;
}

export type SSEEvent =
  | { type: 'connected'; sessionId: string }
  | { type: 'step_start'; step: PipelineStep }
  | { type: 'step_complete'; step: PipelineStep }
  | { type: 'interrupt'; interrupt: SocraticInterrupt | PlanConfirmInterrupt }
  | { type: 'iterate_start'; iteration: number; meta: IterationMeta }
  | { type: 'iterate_complete'; iteration: number; meta: IterationMeta }
  | { type: 'complete'; result: SpecResult; session: SessionState }
  | { type: 'error'; message: string; session?: SessionState }
  | { type: 'heartbeat'; timestamp: string };
