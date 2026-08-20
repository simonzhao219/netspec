-- =============================================================================
-- NetSpec app telemetry — bronze projection over the platform's otel_logs
--
-- This is the PRIMARY path. Databricks Apps exports every stdout/stderr line
-- from each App into a Unity Catalog table over OpenTelemetry; the apps write
-- one compact JSON line per event, and this view turns those lines back into
-- typed columns. No export code, no IAM setup, no token handling in the app.
--
-- BEFORE RUNNING, set the two names in the FROM clause below:
--   * the catalog.schema you chose when enabling App telemetry (workspace UI:
--     Compute -> Apps -> <app> -> Settings -> Telemetry), and
--   * the table name, which is `otel_logs` or `<prefix>_otel_logs` depending on
--     whether a prefix was configured. Check with:
--         SHOW TABLES IN <catalog>.<schema> LIKE '*otel_logs*';
-- =============================================================================

USE CATALOG ep_dev;
USE SCHEMA netspec;

CREATE OR REPLACE VIEW v_app_events_otel
COMMENT 'NetSpec application events recovered from the platform stdout export (otel_logs). Same shape as app_events; read both through v_app_events.'
AS
WITH parsed AS (
  SELECT
    -- body is a VARIANT holding the log line. Casting it to STRING yields the
    -- JSON text whether the collector stored it as a JSON string or as an
    -- already-parsed object, so parsing that string covers both. try_ variants
    -- because the same stream also carries uvicorn access logs and tracebacks,
    -- which are not JSON and must simply be skipped.
    try_parse_json(body::string) AS v,
    time                          AS otel_time,
    service_name                  AS otel_service
  FROM ep_dev.netspec.otel_logs        -- <<< EDIT: your App telemetry catalog.schema.table
)
SELECT
  v:event_id::string                                     AS event_id,
  v:telemetry_schema::string                             AS telemetry_schema,
  v:app::string                                          AS app,
  v:service::string                                      AS service,
  v:event_type::string                                   AS event_type,
  v:event_name::string                                   AS event_name,
  coalesce(
    try_to_timestamp(v:event_time::string),
    try_to_timestamp(v:event_time::string, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX")
  )                                                      AS event_time,
  coalesce(
    try_to_timestamp(v:received_at::string),
    try_to_timestamp(v:received_at::string, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"),
    otel_time
  )                                                      AS received_at,
  to_date(coalesce(
    try_to_timestamp(v:received_at::string),
    try_to_timestamp(v:received_at::string, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX"),
    otel_time
  ))                                                     AS event_date,
  v:page::string                                         AS page,
  v:workflow::string                                     AS workflow,
  v:session_id::string                                   AS session_id,
  v:app_session_id::string                               AS app_session_id,
  v:user_email::string                                   AS user_email,
  v:user_id::string                                      AS user_id,
  v:request_id::string                                   AS request_id,
  v:duration_ms::bigint                                  AS duration_ms,
  v:properties::string                                   AS properties,
  otel_service                                           AS otel_service_name
FROM parsed
-- The marker every telemetry line carries. This is what separates our events
-- from the rest of the app's stdout, which is why it is on every record.
WHERE v IS NOT NULL
  AND v:telemetry_schema::string = 'ep.app_event.v1';
