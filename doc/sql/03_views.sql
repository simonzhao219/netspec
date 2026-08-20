-- =============================================================================
-- NetSpec app telemetry — silver views
--
-- v_app_events        one place to read events, whichever delivery path is live
-- v_spec_versions     criterion #2: what NetSpec produced, joinable to telemetry
-- v_ai_cost_by_stage  criterion #10: AI spend attributable by SDLC stage
-- v_sessions          criterion #1: one row per browser session, for funnels
-- =============================================================================

USE CATALOG ep_dev;
USE SCHEMA netspec;


-- ─────────────────────────────────────────────────────────────────────────────
-- The single read surface. The stdout path and the direct-write path produce
-- identical records, so this unions them and de-duplicates on event_id: turning
-- one path on or off changes nothing downstream.
--
-- If you have not created v_app_events_otel yet (02_bronze_from_otel.sql needs
-- your App telemetry schema filled in), drop the second branch of the UNION and
-- re-run — everything downstream keeps working off the Delta table alone.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_app_events
COMMENT 'Every NetSpec application event, from whichever delivery path is enabled, de-duplicated on event_id. Start every query here.'
AS
SELECT * FROM (
  SELECT
    event_id, telemetry_schema, app, service, event_type, event_name,
    event_time, received_at, event_date, page, workflow, session_id,
    app_session_id, user_email, user_id, request_id, duration_ms, properties,
    'delta' AS source_path
  FROM app_events
  UNION ALL
  SELECT
    event_id, telemetry_schema, app, service, event_type, event_name,
    event_time, received_at, event_date, page, workflow, session_id,
    app_session_id, user_email, user_id, request_id, duration_ms, properties,
    'otel' AS source_path
  FROM v_app_events_otel
)
QUALIFY row_number() OVER (PARTITION BY event_id ORDER BY source_path) = 1;


-- ─────────────────────────────────────────────────────────────────────────────
-- Criterion #2 — app output data: what NetSpec produced, not just how it was
-- used. One row per specification version, joinable to the interaction
-- telemetry on app_session_id and user_email.
--
-- ONE ROW PER VERSION IS ENFORCED HERE, NOT BY THE EMITTER. A version is
-- re-emitted every time its state changes — once when the pipeline produces it,
-- again on each iterate, and again each time a role view is derived from it
-- (that derivation is what flips approval_state, so it has to be re-emitted).
-- Without the de-duplication below, a spec whose PM derived both the architect
-- and the QA view carries THREE rows with the same spec_id, and any query that
-- joins this view to another one multiplies by three — the cost-per-spec query
-- in 04_verify.sql did exactly that. Latest wins, so approval_state and
-- derived_role_views are the current ones; first_produced_at keeps the original
-- creation time.
--
-- approval_state values (see _approval_state in text-spec-service/router.py):
--   draft             generated, did not pass validation
--   pending_approval  passed validation, no human has confirmed it yet
--   approved_derived  a PM confirmed it by deriving an architect / QA view,
--                     which is the only approval gate NetSpec has today
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_spec_versions
COMMENT 'One row per NetSpec specification version produced, de-duplicated to its latest state, with quality score and approval state. Join to v_app_events on app_session_id to see the interactions that produced it.'
AS
WITH emitted AS (
  SELECT
    properties:spec_id::string              AS spec_id,
    app_session_id                          AS netspec_session_id,
    properties:iteration::int               AS iteration,
    properties:origin::string               AS origin,
    properties:feature_name::string         AS feature_name,
    properties:req_type::string             AS req_type,
    properties:detail_level::string         AS detail_level,
    properties:quality_score::int           AS quality_score,
    properties:validation_passed::boolean   AS validation_passed,
    properties:validation_issue_count::int  AS validation_issue_count,
    properties:edge_case_count::int         AS edge_case_count,
    properties:citation_count::int          AS citation_count,
    properties:spec_chars::int              AS spec_chars,
    properties:approval_state::string       AS approval_state,
    properties:derived_role_views::string   AS derived_role_views,
    user_email,
    received_at                             AS produced_at,
    event_date
  FROM v_app_events
  WHERE event_type = 'app_output'
    AND event_name = 'spec_version'
),
ranked AS (
  SELECT
    *,
    min(produced_at) OVER (PARTITION BY netspec_session_id, spec_id) AS first_produced_at,
    row_number()     OVER (PARTITION BY netspec_session_id, spec_id
                           ORDER BY produced_at DESC)                AS rn
  FROM emitted
)
SELECT
  spec_id,
  netspec_session_id,
  iteration,
  origin,                 -- origin of the LATEST emission (pipeline | iterate | role_view)
  feature_name,
  req_type,
  detail_level,
  quality_score,
  validation_passed,
  validation_issue_count,
  edge_case_count,
  citation_count,
  spec_chars,
  approval_state,
  derived_role_views,
  user_email,
  first_produced_at,      -- when this version was first produced
  produced_at,            -- when its state last changed
  event_date
FROM ranked
WHERE rn = 1;


-- ─────────────────────────────────────────────────────────────────────────────
-- Criterion #10 — AI development cost, attributable by SDLC stage.
--
-- Once model calls route through the Databricks-hosted Anthropic endpoint the
-- platform system tables carry authoritative token counts and spend. What they
-- cannot know is which pipeline step a call belongs to — that mapping is what
-- this view supplies, and it also makes the metric available today, before that
-- migration. cost_usd here is an estimate from the price table in cost.py.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_ai_cost_by_stage
COMMENT 'Per-call AI token usage and estimated cost, attributed to the SDLC pipeline step that made the call and to the user and session that triggered it.'
AS
SELECT
  properties:step::string          AS sdlc_step,
  properties:tool::string          AS tool,
  properties:model::string         AS model,
  properties:input_tokens::bigint  AS input_tokens,
  properties:output_tokens::bigint AS output_tokens,
  properties:total_tokens::bigint  AS total_tokens,
  properties:cost_usd::double      AS cost_usd,
  app_session_id                   AS netspec_session_id,
  user_email,
  workflow,
  service,
  received_at                      AS called_at,
  event_date
FROM v_app_events
WHERE event_type = 'llm_call';


-- ─────────────────────────────────────────────────────────────────────────────
-- Criterion #1 — one row per browser session. This is what answers "which steps
-- do users abandon", "where do they hesitate", "which features go unused".
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_sessions
COMMENT 'One row per browser session: who, how long, how far through the pipeline they got, and whether they ended with a specification.'
AS
SELECT
  session_id,
  min(user_email)                                                        AS user_email,
  min(received_at)                                                       AS started_at,
  max(received_at)                                                       AS last_seen_at,
  timestampdiff(SECOND, min(received_at), max(received_at))              AS session_seconds,
  count(*)                                                               AS event_count,
  count(DISTINCT app_session_id)                                         AS netspec_session_count,
  max(CASE WHEN event_name = 'analysis_started'  THEN 1 ELSE 0 END)      AS started_analysis,
  max(CASE WHEN event_name = 'spec_ready'        THEN 1 ELSE 0 END)      AS reached_spec,
  max(CASE WHEN event_name = 'spec_exported'     THEN 1 ELSE 0 END)      AS exported_spec,
  -- The browser-side half of the approval gate. It has to be the FRONTEND event:
  -- this view groups by session_id, which only ui_interaction rows carry, so the
  -- server-side role_view_generated is filtered out by the WHERE below and would
  -- make this column a constant zero.
  max(CASE WHEN event_name = 'role_view_received' THEN 1 ELSE 0 END)     AS approved_spec,
  max(CASE WHEN event_name = 'spec_iterate_clicked' THEN 1 ELSE 0 END)   AS iterated,
  min(event_date)                                                        AS event_date
FROM v_app_events
WHERE session_id IS NOT NULL
GROUP BY session_id;
