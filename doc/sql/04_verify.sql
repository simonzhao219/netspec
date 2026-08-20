-- =============================================================================
-- NetSpec app telemetry — verification
--
-- Run these after deploying and clicking through the app once. Each query maps
-- to a success criterion in doc/SDCL_telemetry.md and states what a PASS is.
-- =============================================================================

USE CATALOG ep_dev;
USE SCHEMA netspec;


-- ── 0. Is anything arriving at all? ──────────────────────────────────────────
-- PASS: at least one row per deployed App you have used.
SELECT service, source_path, count(*) AS events, max(received_at) AS latest
FROM v_app_events
GROUP BY service, source_path
ORDER BY latest DESC;


-- ── 1. CRITERION #1 — "a click in the browser is queryable as a typed row
--       carrying the correct user email"
-- PASS: your own email appears, event_name is the interaction you performed,
--       and the columns are typed (not raw log text).
SELECT
  received_at,
  user_email,
  event_name,
  page,
  workflow,
  session_id,
  app_session_id,
  properties
FROM v_app_events
WHERE event_type = 'ui_interaction'
ORDER BY received_at DESC
LIMIT 20;

-- Nobody should be arriving unattributed. PASS: unattributed = 0, or only rows
-- from a local (non-Databricks) run where no platform header exists.
SELECT
  count(*)                                                AS total,
  count(user_email)                                       AS attributed,
  sum(CASE WHEN user_email IS NULL THEN 1 ELSE 0 END)     AS unattributed
FROM v_app_events
WHERE event_type = 'ui_interaction';

-- Server-side events are attributed through the frontend proxy's private
-- identity relay (X-NetSpec-User-Email), because the backend App's own auth
-- proxy overwrites X-Forwarded-Email with whichever principal authenticated
-- that hop. PASS: the emails here are PEOPLE. If you see a service principal
-- (a bare uuid, or a name ending in the app's id), the relay is not reaching
-- the backend — see section 8 of SDCL_telemetry_deployment.md. The data is
-- still recoverable: join app_session_id to the ui_interaction rows, which
-- always carry the real user.
SELECT event_type, service, count(*) AS events, collect_set(user_email) AS emails
FROM v_app_events
WHERE event_type <> 'ui_interaction'
GROUP BY event_type, service
ORDER BY event_type, service;


-- ── 2. CRITERION #2 — app output, "joinable to the telemetry on session and
--       user". One query, both sides of the join.
-- PASS: each specification version comes back with the interaction count and
--       the wall-clock time of the session that produced it.
SELECT
  s.spec_id,
  s.feature_name,
  s.iteration,
  s.quality_score,
  s.approval_state,
  s.user_email,
  count(e.event_id)                                                AS interactions,
  timestampdiff(SECOND, min(e.received_at), max(e.received_at))    AS session_seconds,
  sum(CASE WHEN e.event_name = 'socratic_answered' THEN 1 ELSE 0 END) AS socratic_rounds_answered
FROM v_spec_versions s
LEFT JOIN v_app_events e
  ON e.app_session_id = s.netspec_session_id
GROUP BY ALL
ORDER BY s.produced_at DESC
LIMIT 20;


-- ── 3. CRITERION #10 — AI cost by SDLC stage, with no instrumentation at the
--       call sites (the numbers come from the one place every model call
--       already passes through).
-- PASS: a per-step cost breakdown with non-zero token counts.
SELECT
  sdlc_step,
  model,
  count(*)                     AS calls,
  sum(input_tokens)            AS input_tokens,
  sum(output_tokens)           AS output_tokens,
  round(sum(cost_usd), 4)      AS cost_usd
FROM v_ai_cost_by_stage
GROUP BY sdlc_step, model
ORDER BY cost_usd DESC;

-- Cost per finished specification — the number the EP team will actually be
-- asked for. PASS: one row per spec with a plausible dollar figure.
SELECT
  s.spec_id,
  s.feature_name,
  s.quality_score,
  round(sum(c.cost_usd), 4) AS cost_usd,
  sum(c.total_tokens)       AS tokens
FROM v_spec_versions s
JOIN v_ai_cost_by_stage c
  ON c.netspec_session_id = s.netspec_session_id
GROUP BY ALL
ORDER BY cost_usd DESC
LIMIT 20;


-- ── 4. The behavioural questions the PoC exists to answer ────────────────────

-- "Which steps do users abandon?" — the funnel.
SELECT
  count(*)                                                    AS sessions,
  sum(started_analysis)                                       AS started,
  sum(reached_spec)                                           AS got_a_spec,
  sum(approved_spec)                                          AS approved,
  sum(exported_spec)                                          AS exported,
  round(100.0 * sum(reached_spec)  / nullif(sum(started_analysis), 0), 1) AS pct_completed,
  round(100.0 * sum(exported_spec) / nullif(sum(reached_spec), 0), 1)     AS pct_exported
FROM v_sessions;

-- "Where do they hesitate?" — slowest pipeline steps as users experience them.
SELECT
  properties:title::string AS step,
  count(*)                 AS runs,
  round(avg(duration_ms))  AS avg_ms,
  max(duration_ms)         AS max_ms
FROM v_app_events
WHERE event_name = 'pipeline_step_completed' AND duration_ms IS NOT NULL
GROUP BY step
ORDER BY avg_ms DESC;

-- "Which features go unused?" — every panel, by how often it is opened.
SELECT properties:panel::string AS panel, count(*) AS opens, count(DISTINCT user_email) AS users
FROM v_app_events
WHERE event_name = 'panel_viewed'
GROUP BY panel
ORDER BY opens DESC;

-- "How often does an answer have to be asked twice?" — re-work per session.
SELECT
  netspec_session_id,
  max(iteration)                AS versions,
  min(quality_score)            AS first_score,
  max(quality_score)            AS best_score,
  max(approval_state)           AS approval_state
FROM v_spec_versions
GROUP BY netspec_session_id
HAVING max(iteration) > 1
ORDER BY versions DESC;


-- ── 5. CRITERION #9 groundwork — cross-app usage on one timeline.
-- Today this shows NetSpec's two workflows side by side; once BugZapper emits
-- the same contract, its rows appear here with app = 'bugzapper' and no change
-- to this query.
SELECT
  app,
  workflow,
  date_trunc('HOUR', received_at) AS hour,
  count(*)                        AS events,
  count(DISTINCT user_email)      AS users
FROM v_app_events
GROUP BY ALL
ORDER BY hour DESC, app, workflow
LIMIT 100;
