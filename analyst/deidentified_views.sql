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

-- ── Authorization utilization: authorized vs used hours per authorization ───
-- One row PER AUTHORIZATION (keyed by authorization_number), with used hours
-- scoped to that authorization's own date window — so multiple/expired auths on
-- the same billing_code don't double-count or bleed across periods. authorization_number
-- is used only for grouping and is NOT exposed (kept de-identified).
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker.v_authorization_utilization` AS
WITH auth AS (
  SELECT
    client_id, billing_code, payer_type, authorization_number,
    authorized_hours, start_date, end_date, status,
    SAFE.PARSE_DATE('%Y-%m-%d', start_date) AS start_d,
    SAFE.PARSE_DATE('%Y-%m-%d', end_date)   AS end_d
  FROM `rt-aba-tracker.aba_tracker.authorizations`
),
used AS (
  SELECT
    a.client_id, a.billing_code, a.authorization_number,
    IFNULL(SUM(s.hours), 0) AS used_hours
  FROM auth a
  LEFT JOIN `rt-aba-tracker.aba_tracker.v_sessions_deid` s
    ON s.client_id    = a.client_id
   AND s.billing_code = a.billing_code
   AND (a.start_d IS NULL OR s.session_date >= a.start_d)
   AND (a.end_d   IS NULL OR s.session_date <= a.end_d)
  GROUP BY a.client_id, a.billing_code, a.authorization_number
)
SELECT
  a.client_id,
  a.billing_code,
  a.payer_type,
  a.authorized_hours,
  u.used_hours,
  a.authorized_hours - u.used_hours                     AS remaining_hours,
  SAFE_DIVIDE(u.used_hours, a.authorized_hours)         AS utilization_pct,
  a.start_date,
  a.end_date,
  a.status
FROM auth a
JOIN used u
  ON u.client_id            = a.client_id
 AND u.billing_code         = a.billing_code
 AND u.authorization_number = a.authorization_number;

-- ── Mastery / RBT review: goal & behavior mastery entries + BCBA workflow ───
-- Columns from BigQuerySync.gs bqReadMasteryRows. Excludes client_name (PHI).
-- status: '' | recommended | pendingGeneralization | confirmed | dismissed
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker.v_mastery` AS
SELECT
  client_id,
  type,                       -- 'goal' | 'behavior'
  code,
  description,
  SAFE.PARSE_DATE('%Y-%m-%d', date_iso) AS mastery_date,
  status,
  approved_by,
  approval_date,
  settings_observed,
  therapist_name
FROM `rt-aba-tracker.aba_tracker.mastery_log`;
