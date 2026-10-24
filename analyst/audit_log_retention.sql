-- ============================================================================
-- d10 — HIPAA AUDIT LOG IN BIGQUERY
--
-- Until Oct 24 2026 the audit trail had exactly ONE copy: a Google Sheet.
-- It is the one dataset in this system with a STATUTORY SIX-YEAR RETENTION
-- requirement (45 CFR 164.316(b)(2)), and it was the only one of fifteen
-- tables not synced.
--
-- WHY THIS TABLE IS APPEND-ONLY, UNLIKE EVERY OTHER TABLE
-- Every other table is a mirror of current state, so replacing it wholesale
-- each hour is correct. An audit trail is not state — it is a record. A
-- truncating mirror faithfully reproduces DELETIONS, so if rows were cleared
-- from the sheet, or the sheet were lost, or a repair script rewrote it, a
-- WRITE_TRUNCATE sync would carry that loss straight into the only other copy.
-- That would defeat the entire reason this table exists.
--
-- So BigQuerySync.gs loads audit_log with WRITE_APPEND, resuming from
-- MAX(ts_iso) minus a two-hour lookback.
--
-- GAPS ARE WORSE THAN DUPLICATES for a compliance log, so the design biases
-- deliberately toward duplicates: every run re-sends a small overlap, and no
-- row can fall between two runs. audit_id is deterministic, so the overlap
-- de-duplicates here in the view.
--
-- >>> ALWAYS QUERY v_audit_log, NEVER aba_tracker.audit_log DIRECTLY. <<<
--
-- PHI: audit_log is EXCLUDED from aba_tracker_deid. `client_name` is a direct
-- identifier and `details` is free text that can contain anything. These views
-- therefore live in the MAIN dataset, for the covered entity's own use.
-- ============================================================================


-- ── The one to query. De-duplicates the deliberate sync overlap. ────────────
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker.v_audit_log` AS
SELECT
  audit_id,
  SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*SZ', ts_iso) AS event_ts,
  ts_iso,
  SAFE.PARSE_DATE('%Y-%m-%d', date_iso)                AS event_date,
  date_iso,
  user_email,
  action,
  client_name,
  details,
  source_row
FROM (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY audit_id ORDER BY ts_iso) AS _rn
  FROM `rt-aba-tracker.aba_tracker.audit_log`
)
WHERE _rn = 1;


-- ── Retention evidence: coverage per day. ───────────────────────────────────
-- A missing or unexpectedly thin day is the signal that a sync run was lost.
-- Run this when asked to demonstrate the audit trail is intact.
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker.v_audit_coverage` AS
SELECT
  event_date,
  COUNT(*)                                    AS entries,
  COUNT(DISTINCT user_email)                  AS distinct_users,
  COUNT(DISTINCT action)                      AS distinct_actions,
  COUNTIF(action = 'session_submit')          AS session_submits,
  MIN(ts_iso)                                 AS first_entry,
  MAX(ts_iso)                                 AS last_entry
FROM `rt-aba-tracker.aba_tracker.v_audit_log`
WHERE event_date IS NOT NULL
GROUP BY event_date
ORDER BY event_date DESC;


-- ── Did the overlap actually duplicate anything? ────────────────────────────
-- Expect this to return the number of rows the view suppressed. A LARGE and
-- growing number means the watermark is not advancing — investigate, because
-- it implies every run is re-sending more than the intended two-hour overlap.
--   SELECT
--     (SELECT COUNT(*) FROM `rt-aba-tracker.aba_tracker.audit_log`)   AS raw_rows,
--     (SELECT COUNT(*) FROM `rt-aba-tracker.aba_tracker.v_audit_log`) AS unique_rows;


-- ── Tamper check: has anything in the sheet been edited after the fact? ─────
-- audit_id is a hash of the row's CONTENT plus its sheet row number, so editing
-- a historical row produces a NEW id at the SAME source_row rather than
-- changing the existing one. Two ids sharing a source_row therefore means that
-- row's text changed after it was first synced — which, for an append-only
-- audit trail, should never happen.
--   SELECT source_row, COUNT(DISTINCT audit_id) AS versions,
--          STRING_AGG(DISTINCT details LIMIT 5) AS variants
--   FROM `rt-aba-tracker.aba_tracker.v_audit_log`
--   GROUP BY source_row
--   HAVING versions > 1
--   ORDER BY versions DESC;
