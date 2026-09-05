-- ============================================================================
-- Make the BigQuery warehouse self-describing: set table + column descriptions
-- so any model (and the Claude MCP) reads meaning directly from the catalog.
-- Run once; re-run after schema changes. Idempotent (SET OPTIONS overwrites).
-- Project rt-aba-tracker / dataset aba_tracker.
-- ============================================================================

-- ── Table descriptions ──────────────────────────────────────────────────────
ALTER TABLE `rt-aba-tracker.aba_tracker.sessions`             SET OPTIONS (description = 'One row per submitted therapy session. duration_min is BILLABLE minutes (active time, excludes pauses). Filter is_draft=FALSE for analytics.');
ALTER TABLE `rt-aba-tracker.aba_tracker.behavior_records`     SET OPTIONS (description = 'Long format: one row per (session, behavior) with a frequency count. Includes tantrumFrequency / tantrumTotalMin rows.');
ALTER TABLE `rt-aba-tracker.aba_tracker.trial_records`        SET OPTIONS (description = 'Long format: one row per (session, goal) with discrete-trial percent correct.');
ALTER TABLE `rt-aba-tracker.aba_tracker.abc_incidents`        SET OPTIONS (description = 'Antecedent-Behavior-Consequence incidents with hypothesized function. antecedent/consequence are free-text PHI.');
ALTER TABLE `rt-aba-tracker.aba_tracker.mastery_log`          SET OPTIONS (description = 'Goal & behavior mastery events + BCBA review workflow (status: recommended/pendingGeneralization/confirmed/dismissed).');
ALTER TABLE `rt-aba-tracker.aba_tracker.clients`             SET OPTIONS (description = 'Client roster (dimension). name is PHI.');
ALTER TABLE `rt-aba-tracker.aba_tracker.therapists`         SET OPTIONS (description = 'Therapist/RBT roster (dimension).');
ALTER TABLE `rt-aba-tracker.aba_tracker.goals_reference`     SET OPTIONS (description = 'Goal definitions (dimension). Join on code.');
ALTER TABLE `rt-aba-tracker.aba_tracker.behaviors_reference` SET OPTIONS (description = 'Behavior definitions (dimension). Join on key.');
ALTER TABLE `rt-aba-tracker.aba_tracker.authorizations`     SET OPTIONS (description = 'Insurance authorizations per client + billing_code (dimension).');
ALTER TABLE `rt-aba-tracker.aba_tracker.billing_codes`       SET OPTIONS (description = 'Billing code matrix (profile x session_type -> code).');

-- ── Key column descriptions (fact tables) ───────────────────────────────────
ALTER TABLE `rt-aba-tracker.aba_tracker.sessions` ALTER COLUMN submission_id  SET OPTIONS (description = 'Stable unique session id; join key to behavior_records/trial_records/abc_incidents.');
ALTER TABLE `rt-aba-tracker.aba_tracker.sessions` ALTER COLUMN client_id      SET OPTIONS (description = 'FK -> clients.id.');
ALTER TABLE `rt-aba-tracker.aba_tracker.sessions` ALTER COLUMN therapist_email SET OPTIONS (description = 'FK -> therapists.email.');
ALTER TABLE `rt-aba-tracker.aba_tracker.sessions` ALTER COLUMN date_iso       SET OPTIONS (description = 'Session date as YYYY-MM-DD string. PARSE_DATE for time grouping.');
ALTER TABLE `rt-aba-tracker.aba_tracker.sessions` ALTER COLUMN duration_min   SET OPTIONS (description = 'BILLABLE minutes = active therapy time; EXCLUDES paused time. May be < (time_out - time_in).');
ALTER TABLE `rt-aba-tracker.aba_tracker.sessions` ALTER COLUMN billing_code   SET OPTIONS (description = 'CPT/billing code; FK -> billing_codes.code and authorizations.billing_code.');
ALTER TABLE `rt-aba-tracker.aba_tracker.sessions` ALTER COLUMN notes          SET OPTIONS (description = 'Free-text clinical note. PHI — exclude from de-identified use and model training.');
ALTER TABLE `rt-aba-tracker.aba_tracker.sessions` ALTER COLUMN is_draft       SET OPTIONS (description = 'TRUE = incomplete/draft; exclude from analytics and training.');

ALTER TABLE `rt-aba-tracker.aba_tracker.behavior_records` ALTER COLUMN behavior_key SET OPTIONS (description = 'Behavior code; FK -> behaviors_reference.key.');
ALTER TABLE `rt-aba-tracker.aba_tracker.behavior_records` ALTER COLUMN count        SET OPTIONS (description = 'Frequency count for the behavior in the session (or minutes for tantrumTotalMin).');

ALTER TABLE `rt-aba-tracker.aba_tracker.trial_records` ALTER COLUMN goal_code          SET OPTIONS (description = 'Goal code; FK -> goals_reference.code.');
ALTER TABLE `rt-aba-tracker.aba_tracker.trial_records` ALTER COLUMN percentage_numeric SET OPTIONS (description = 'Percent correct 0-100 for the goal in the session.');
ALTER TABLE `rt-aba-tracker.aba_tracker.trial_records` ALTER COLUMN correct_trials     SET OPTIONS (description = 'Number of correct trials.');
ALTER TABLE `rt-aba-tracker.aba_tracker.trial_records` ALTER COLUMN total_trials       SET OPTIONS (description = 'Number of trials presented.');

ALTER TABLE `rt-aba-tracker.aba_tracker.mastery_log` ALTER COLUMN status SET OPTIONS (description = 'recommended | pendingGeneralization | confirmed | dismissed (empty = none).');
ALTER TABLE `rt-aba-tracker.aba_tracker.mastery_log` ALTER COLUMN type   SET OPTIONS (description = 'goal or behavior.');

-- Tip: read it all back with
--   SELECT table_name, ddl FROM `rt-aba-tracker.aba_tracker`.INFORMATION_SCHEMA.TABLES;
--   SELECT * FROM `rt-aba-tracker.aba_tracker`.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS;
