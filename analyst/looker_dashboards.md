# Looker Studio dashboards — build spec

Dashboards are assembled in the Looker Studio **web UI** (they can't be created
from code). This spec makes that assembly mechanical: create the BigQuery views
in `deidentified_views.sql` first, then bind each chart to the named view below.

**Data sources:** in Looker Studio → *Add data* → **BigQuery** → project
`rt-aba-tracker` → dataset `aba_tracker` → pick each `v_*` view as its own data
source. (Using the de-identified views keeps PHI out of the reports.)

**Report-level controls (add once, apply to all pages):**
- **Date range control** → bound to `session_date` / `week_start`
- **Drop-down control** → `client_id` (or a client-initials view if you prefer)
- **Drop-down control** → `therapist_name`

---

## Page 1 — Billing & Hours   (source: `v_billing_by_week`, `v_sessions_deid`)
| Chart | Type | Dimension | Metric |
|-------|------|-----------|--------|
| Total hours | Scorecard | — | SUM `hours` (from `v_sessions_deid`) |
| Total sessions | Scorecard | — | COUNT `submission_id` |
| Hours by week | Time series | `week_start` | SUM `hours` |
| Hours by therapist × code | Table | `therapist_name`, `billing_code` | SUM `hours`, SUM `units`, `sessions` |
| Hours by billing code | Pie/Bar | `billing_code` | SUM `hours` |

## Page 2 — Authorization Utilization   (source: `v_authorization_utilization`)
| Chart | Type | Dimension | Metric / note |
|-------|------|-----------|---------------|
| Authorized vs used | Stacked/clustered bar | `client_id`, `billing_code` | `authorized_hours`, `used_hours` |
| Utilization % | Table | `client_id`, `billing_code` | `utilization_pct` (format %), `remaining_hours` |
| Burn alert | Table + conditional format | `client_id`, `billing_code` | red when `utilization_pct` > 0.9 |
| Expiring soon | Table | `client_id`, `billing_code`, `end_date` | filter `end_date` within 45 days |

## Page 3 — Goal Progress   (source: `v_goal_progress`)
| Chart | Type | Dimension | Metric |
|-------|------|-----------|--------|
| Avg % correct over time | Time series | `session_date` (breakdown `goal_code`) | AVG `avg_pct` |
| Latest % by goal | Table | `client_id`, `goal_code`, `goal_description` | AVG `avg_pct` |
| Trials completed | Scorecard | — | SUM `total_trials` |
> Add a **client** filter; a single client makes the goal breakdown readable.

## Page 4 — Behavior Trends   (source: `v_behavior_trend`)
| Chart | Type | Dimension | Metric |
|-------|------|-----------|--------|
| Behavior count over time | Time series | `session_date` (breakdown `behavior_label`) | SUM `total_count` |
| Count by behavior | Bar | `behavior_label` | SUM `total_count` |
> Filter to one `client_id` for meaningful trends.

## Page 5 — Therapist Productivity   (source: `v_therapist_hours_by_week`)
| Chart | Type | Dimension | Metric |
|-------|------|-----------|--------|
| Hours by therapist by week | Time series | `week_start` (breakdown `therapist_name`) | SUM `hours` |
| Sessions by therapist | Bar | `therapist_name` | SUM `sessions` |

---

## Notes
- **Refresh:** BigQuery is synced hourly by `BigQuerySync.gs`; set the Looker data
  source freshness to ~1 hour.
- **Percent fields:** format `avg_pct` / `utilization_pct` as Percent in the field
  settings.
- **Sharing:** share the report with BCBA/admin Google accounts (viewer). No PHI
  is exposed because the views omit notes and names.
- If you want client **names** (not just IDs) on a dashboard, add a small
  `v_clients_labels` view exposing `id, initials` (initials, not full names) and
  blend it in — keeps identifiability minimal.
