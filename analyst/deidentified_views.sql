-- ============================================================================
-- De-identified + report-ready views for read-only analytics (BigQuery)
-- Project: rt-aba-tracker   Dataset: aba_tracker
--
-- Column names below are taken from BigQuerySync.gs (the bqBuild*/bqRead* row
-- builders) — they ARE the authoritative schema. Free-text PHI (session `notes`)
-- and client `name` are intentionally excluded. Drafts are filtered out.
--
-- THESE VIEWS LIVE IN `aba_tracker_deid`, NOT `aba_tracker`. That is the whole
-- point and it was previously only a recommendation in this comment while every
-- CREATE below targeted `aba_tracker` — so the views sat beside the raw PHI
-- tables and isolated nothing. Worse, mcp_and_baa_setup.md granted
-- roles/bigquery.dataViewer at PROJECT level, i.e. read access to sessions,
-- behavior_records and audit_log directly. The de-identification was decorative.
--
-- THREE STEPS, AND THE SECOND IS THE ONE EVERYONE SKIPS:
--
--   1. bq mk --dataset --location=US rt-aba-tracker:aba_tracker_deid
--
--   2. AUTHORIZE the deid dataset on the source dataset. A view can only read a
--      table the CALLER cannot read if the view's dataset is an authorized
--      dataset of the source. Without this, every reader of v_sessions_deid also
--      needs read on aba_tracker — which is exactly what we are preventing:
--        bq update --source_dataset=rt-aba-tracker:aba_tracker \
--                  --authorized_dataset=rt-aba-tracker:aba_tracker_deid
--      (Console: aba_tracker > Sharing > Authorized datasets > add aba_tracker_deid)
--
--   3. Grant the analyst identity bigquery.dataViewer on aba_tracker_deid ONLY,
--      and bigquery.jobUser at project level so it can run queries. Do NOT grant
--      dataViewer on aba_tracker or at project level.
--
-- Point Looker dashboards and the MCP at these views. Raw PHI then never leaves
-- BigQuery even if the analyst identity is compromised.
--
-- f76: behavior_definitions is NOT selected by any view here, and must not be.
-- It holds free clinical text describing a NAMED CHILD's behaviour topography —
-- the same category as sessions.notes, which is excluded for the same reason.
-- Adding it would need the review that column got, not a one-line edit.
--
-- f77: phase_changes is excluded on the SAME grounds, and the reasoning is
-- worth stating because the table looks innocuous. `label` and `description`
-- are free text about a named child's circumstances — "moved to grandmother's
-- after removal", "started risperidone 0.5mg", "new teacher, Ms <name>". That
-- is family, medical and third-party information, not behaviour data. A phase
-- line's DATE and CATEGORY would be safe to expose; its prose is not. If a
-- de-identified chart needs phase lines, add a view selecting date_iso and
-- category only, never label or description.
--
-- f78: definition_acks IS safe to expose — it carries no free text, only who
-- read which version when. It is included below, and joins
-- behavior_definitions on client_id + behavior_key + def_hash to answer "who
-- has not read the current wording" WITHOUT exposing the wording itself.
--
-- NOTE ON SMALL n: with 7 clients, removing names is NOT de-identification in
-- any practical sense — "which client has the most elopement" re-identifies by
-- context alone. These views exist to limit what leaves the premises to an
-- external model, NOT to limit what the BCBA may infer; she is the covered
-- entity's clinician and is entitled to the PHI. That is why the Anthropic BAA
-- (Part C of mcp_and_baa_setup.md) carries more weight here than the views do.
--
-- date_iso is a 'YYYY-MM-DD' string → parse for time grouping.
-- ============================================================================

-- ── Base: completed sessions, no PHI notes ──────────────────────────────────
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker_deid.v_sessions_deid` AS
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
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker_deid.v_billing_by_week` AS
SELECT
  DATE_TRUNC(session_date, WEEK(MONDAY)) AS week_start,
  therapist_name,
  therapist_email,
  billing_code,
  COUNT(*)              AS sessions,
  ROUND(SUM(hours), 2)  AS hours,
  SUM(units_15min)      AS units
FROM `rt-aba-tracker.aba_tracker_deid.v_sessions_deid`
WHERE session_date IS NOT NULL
GROUP BY week_start, therapist_name, therapist_email, billing_code;

-- ── Therapist productivity: hours per therapist × week ──────────────────────
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker_deid.v_therapist_hours_by_week` AS
SELECT
  DATE_TRUNC(session_date, WEEK(MONDAY)) AS week_start,
  therapist_name,
  therapist_email,
  COUNT(*)             AS sessions,
  ROUND(SUM(hours), 2) AS hours
FROM `rt-aba-tracker.aba_tracker_deid.v_sessions_deid`
WHERE session_date IS NOT NULL
GROUP BY week_start, therapist_name, therapist_email;

-- ── Goal progress: percent-correct per client × goal × date ─────────────────
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker_deid.v_goal_progress` AS
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
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker_deid.v_behavior_trend` AS
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
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker_deid.v_authorization_utilization` AS
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
  LEFT JOIN `rt-aba-tracker.aba_tracker_deid.v_sessions_deid` s
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
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker_deid.v_mastery` AS
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


-- ============================================================================
-- f78 — DEFINITION ACKNOWLEDGEMENT COVERAGE
--
-- Who has confirmed reading the current wording of each behaviour definition,
-- and who started a session without reading it.
--
-- Safe in this dataset because the ack carries no clinical prose: only ids, a
-- behaviour key, an opaque version hash and a timestamp. Identifiers pass
-- through exactly as the other views here pass them — these views exclude free
-- text, they do not pseudonymise (see NOTE ON SMALL n above), and hashing ids
-- only here would break every join to the views alongside it.
--
-- def_hash is deliberately surfaced UNRESOLVED: it identifies a version
-- without revealing a word of what that version says, which is exactly why
-- this table can be here while behavior_definitions cannot.
-- ============================================================================
CREATE OR REPLACE VIEW `rt-aba-tracker.aba_tracker_deid.v_definition_acks` AS
SELECT
  a.client_id,
  a.behavior_key,
  a.def_hash,
  a.ack_action,
  a.therapist_email,
  a.therapist_name,
  SAFE.PARSE_DATE('%Y-%m-%d', a.date_iso) AS ack_date,
  a.date_iso,
  -- TRUE when this ack is for the wording currently in force. A FALSE here is
  -- the interesting row: it means the definition has been revised since.
  (a.def_hash = d.def_hash) AS is_current_version
FROM `rt-aba-tracker.aba_tracker.definition_acks` a
LEFT JOIN `rt-aba-tracker.aba_tracker.behavior_definitions` d
  ON d.client_id = a.client_id AND d.behavior_key = a.behavior_key;
