-- ============================================================================
-- De-identified + report-ready views for read-only analytics (BigQuery)
-- Project: rt-aba-tracker   Dataset: aba_tracker
--
-- Column names below are taken from BigQuerySync.gs (the bqBuild*/bqRead* row
-- builders) — they ARE the authoritative schema. Free-text PHI (session `notes`)
-- and client `name` are intentionally excluded. Drafts are filtered out.
--
-- Recommended: create these in a SEPARATE dataset (e.g. `aba_tracker_deid`) and
-- grant the analyst identity bigquery.dataViewer on ONLY that dataset, so raw
-- PHI never leaves BigQuery. Point Looker dashboards at these views.
--
-- date_iso is a 'YYYY-MM-DD' string → parse for time grouping.
-- ============================================================================

-- ── Base: completed sessions, no PHI notes ──────────────────────────────────
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker.v_sessions_deid` AS
SELECT
  submission_id,
  client_id,
  therapist_name,
  therapist_email,
  SAFE.PARSE_DATE('%Y-%m-%d', date_iso) AS session_date,
  date_iso,
  session_type,
  billing_code,
  location,
  duration_min,
  ROUND(duration_min / 60, 2)      AS hours,
  ROUND(duration_min / 15)         AS units_15min
FROM `rt-aba-tracker.aba_tracker.sessions`
WHERE IFNULL(is_draft, FALSE) = FALSE;

-- ── Billing: hours per therapist × billing code × week ──────────────────────
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker.v_billing_by_week` AS
SELECT
  DATE_TRUNC(session_date, WEEK(MONDAY)) AS week_start,
  therapist_name,
  therapist_email,
  billing_code,
  COUNT(*)              AS sessions,
  ROUND(SUM(hours), 2)  AS hours,
  SUM(units_15min)      AS units
FROM `rt-aba-tracker.aba_tracker.v_sessions_deid`
WHERE session_date IS NOT NULL
GROUP BY week_start, therapist_name, therapist_email, billing_code;

-- ── Therapist productivity: hours per therapist × week ──────────────────────
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker.v_therapist_hours_by_week` AS
SELECT
  DATE_TRUNC(session_date, WEEK(MONDAY)) AS week_start,
  therapist_name,
  therapist_email,
  COUNT(*)             AS sessions,
  ROUND(SUM(hours), 2) AS hours
FROM `rt-aba-tracker.aba_tracker.v_sessions_deid`
WHERE session_date IS NOT NULL
GROUP BY week_start, therapist_name, therapist_email;

-- ── Goal progress: percent-correct per client × goal × date ─────────────────
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker.v_goal_progress` AS
SELECT
  client_id,
  goal_code,
  goal_description,
  SAFE.PARSE_DATE('%Y-%m-%d', date_iso) AS session_date,
  AVG(percentage_numeric)   AS avg_pct,
  SUM(correct_trials)       AS correct_trials,
  SUM(total_trials)         AS total_trials
FROM `rt-aba-tracker.aba_tracker.trial_records`
WHERE IFNULL(is_draft, FALSE) = FALSE
GROUP BY client_id, goal_code, goal_description, session_date;

-- ── Behavior trend: count per client × behavior × date ──────────────────────
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker.v_behavior_trend` AS
SELECT
  client_id,
  behavior_key,
  behavior_label,
  SAFE.PARSE_DATE('%Y-%m-%d', date_iso) AS session_date,
  SUM(count) AS total_count,
  COUNT(*)   AS observations
FROM `rt-aba-tracker.aba_tracker.behavior_records`
WHERE IFNULL(is_draft, FALSE) = FALSE
GROUP BY client_id, behavior_key, behavior_label, session_date;

-- ── Authorization utilization: authorized vs used hours per client × code ───
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker.v_authorization_utilization` AS
WITH used AS (
  SELECT client_id, billing_code, SUM(hours) AS used_hours
  FROM `rt-aba-tracker.aba_tracker.v_sessions_deid`
  GROUP BY client_id, billing_code
)
SELECT
  a.client_id,
  a.billing_code,
  a.payer_type,
  a.authorized_hours,
  IFNULL(u.used_hours, 0)                                   AS used_hours,
  a.authorized_hours - IFNULL(u.used_hours, 0)             AS remaining_hours,
  SAFE_DIVIDE(IFNULL(u.used_hours, 0), a.authorized_hours) AS utilization_pct,
  a.start_date,
  a.end_date,
  a.status
FROM `rt-aba-tracker.aba_tracker.authorizations` a
LEFT JOIN used u
  ON u.client_id = a.client_id AND u.billing_code = a.billing_code;

-- NOTE: mastery_log columns were not verified here — before adding a mastery
-- view, run:
--   SELECT column_name FROM `rt-aba-tracker.aba_tracker`.INFORMATION_SCHEMA.COLUMNS
--   WHERE table_name = 'mastery_log' ORDER BY ordinal_position;
-- then add a v_mastery view selecting client_id, type, code, status, mastery_date.
