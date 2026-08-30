-- ============================================================================
-- De-identified views for read-only analyst access (BigQuery)
-- Project: rt-aba-tracker   Dataset: aba_tracker
--
-- PURPOSE: expose analytics WITHOUT free-text PHI (session notes) or names, so
-- the read-only analyst identity / Claude never surfaces PHI into context.
--
-- ⚠️ TEMPLATE — VERIFY COLUMN NAMES FIRST. The BigQuery column names are set by
--    BigQuerySync.gs (snake_case). Before running, confirm each column exists:
--      SELECT column_name FROM `rt-aba-tracker.aba_tracker`.INFORMATION_SCHEMA.COLUMNS
--      WHERE table_name = 'sessions' ORDER BY ordinal_position;
--    Then adjust the SELECT lists below to match, and remove columns you don't have.
--
-- Recommended: create these in a SEPARATE dataset (e.g. aba_tracker_deid) and
-- grant the read-only service account bigquery.dataViewer on ONLY that dataset.
-- ============================================================================

-- Sessions without notes (free-text PHI) or client names.
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker.v_sessions_deid` AS
SELECT
  submission_id,
  client_id,
  therapist_email,
  date_iso,
  session_type,
  billing_code,
  duration_min
  -- intentionally EXCLUDES: notes, client_name
FROM `rt-aba-tracker.aba_tracker.sessions`;

-- Trial results (goal performance) — already numeric, no free text.
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker.v_trials_deid` AS
SELECT
  submission_id,
  client_id,
  goal_code,
  date_iso,
  percentage
FROM `rt-aba-tracker.aba_tracker.trial_records`;

-- Behavior counts — numeric only.
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker.v_behaviors_deid` AS
SELECT
  submission_id,
  client_id,
  behavior_key,
  date_iso,
  count
FROM `rt-aba-tracker.aba_tracker.behavior_records`;

-- Authorization utilization — no free text.
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker.v_authorizations_deid` AS
SELECT
  client_id,
  billing_code,
  authorized_hours,
  start_date,
  end_date,
  status
FROM `rt-aba-tracker.aba_tracker.authorizations`;
