-- =============================================================================
-- NetSpec app telemetry — Unity Catalog setup
-- SDCL PoC success criteria #1 (app telemetry), #2 (app output), #10 (AI cost)
--
-- Run once, as a user who can create schemas in the target catalog.
-- Adjust ${CATALOG} / ${SCHEMA} to match your workspace before running.
-- =============================================================================

-- Change these two lines and nothing else in this file.
USE CATALOG ep_dev;
CREATE SCHEMA IF NOT EXISTS netspec
  COMMENT 'NetSpec (EP app) — interaction telemetry, app output and AI cost events for the SDLC analytics PoC';
USE SCHEMA netspec;


-- ─────────────────────────────────────────────────────────────────────────────
-- app_events — the typed landing table for the optional direct-write sink.
--
-- Both delivery paths produce the SAME record shape. The stdout path lands in
-- otel_logs and is projected into this shape by 02_bronze_from_otel.sql; the
-- direct-write sink INSERTs here itself. Query v_app_events (03_views.sql) to
-- read whichever path is live without caring which one it is.
--
-- properties stays a JSON STRING rather than a struct so event authors can add
-- fields without a schema migration. Read it with `properties:key::type`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_events (
  event_id          STRING    COMMENT 'UUID assigned at emit time. Unique per event — use it to de-duplicate if both delivery paths are ever enabled at once.',
  telemetry_schema  STRING    COMMENT 'Event contract version, always "ep.app_event.v1". Filter on this to separate telemetry from ordinary application logs.',
  app               STRING    COMMENT 'Which EP application produced the event: netspec, bugzapper, polaris. Lets all three share one table.',
  service           STRING    COMMENT 'Which process inside the app: frontend, text-spec-service, figma-service.',
  event_type        STRING    COMMENT 'ui_interaction = a click in the browser; server_event = something the service did; app_output = something the app produced (a specification version); llm_call = one model call with tokens and cost.',
  event_name        STRING    COMMENT 'The semantic event, e.g. generate_spec_clicked, spec_version, pipeline_step_completed, session_end.',
  event_time        TIMESTAMP COMMENT 'When the event happened. For browser events this is the client clock and can be skewed — order by received_at instead.',
  received_at       TIMESTAMP COMMENT 'When the server received the event. Authoritative for ordering and for time-window filters.',
  event_date        DATE      COMMENT 'Date of received_at. Clustering key.',
  page              STRING    COMMENT 'Browser path the interaction happened on.',
  workflow          STRING    COMMENT 'Which half of NetSpec: text (requirement to PRD) or figma (design to user story).',
  session_id        STRING    COMMENT 'Browser session, one per tab, from sessionStorage. Use for funnel and dwell-time analysis.',
  app_session_id    STRING    COMMENT 'NetSpec backend session id. THE join key between interaction telemetry and the specification versions a session produced.',
  user_email        STRING    COMMENT 'Acting user, resolved server-side from the X-Forwarded-Email header injected by the Databricks Apps platform. No authentication code in the app.',
  user_id           STRING    COMMENT 'Acting user id from X-Forwarded-User.',
  request_id        STRING    COMMENT 'Platform request id, for correlating against otel_logs and app access logs.',
  duration_ms       BIGINT    COMMENT 'How long the thing took, where the emitter could measure it (pipeline steps, role-view generation, dwell time at session_end).',
  properties        STRING    COMMENT 'Event-specific payload as JSON. Read with properties:key::type, e.g. properties:quality_score::int. Never contains requirement or specification text — the emitter strips content and keeps only lengths, ids and enums.'
)
USING DELTA
CLUSTER BY (event_date, app, event_name)
COMMENT 'One row per NetSpec application event: browser interactions, server-side pipeline steps, specification versions produced, and per-call AI token cost. Join to specification output on app_session_id, and to people on user_email.';
