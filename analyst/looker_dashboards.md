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

### Quick start — pre-connect the data sources (Linking API)

Create the views first, then open this URL while signed into a Google account
with access. It spins up a new **"RT ABA Analytics"** report with all 7 views
already connected as BigQuery data sources — you just add charts per the pages
below (the Linking API can't create the charts themselves).

```
https://lookerstudio.google.com/reporting/create?c.mode=edit&r.reportName=RT+ABA+Analytics&ds.sessions.connector=bigQuery&ds.sessions.type=TABLE&ds.sessions.projectId=rt-aba-tracker&ds.sessions.billingProjectId=rt-aba-tracker&ds.sessions.datasetId=aba_tracker&ds.sessions.tableId=v_sessions_deid&ds.sessions.refreshFields=true&ds.billing.connector=bigQuery&ds.billing.type=TABLE&ds.billing.projectId=rt-aba-tracker&ds.billing.billingProjectId=rt-aba-tracker&ds.billing.datasetId=aba_tracker&ds.billing.tableId=v_billing_by_week&ds.billing.refreshFields=true&ds.therapisthours.connector=bigQuery&ds.therapisthours.type=TABLE&ds.therapisthours.projectId=rt-aba-tracker&ds.therapisthours.billingProjectId=rt-aba-tracker&ds.therapisthours.datasetId=aba_tracker&ds.therapisthours.tableId=v_therapist_hours_by_week&ds.therapisthours.refreshFields=true&ds.goalprogress.connector=bigQuery&ds.goalprogress.type=TABLE&ds.goalprogress.projectId=rt-aba-tracker&ds.goalprogress.billingProjectId=rt-aba-tracker&ds.goalprogress.datasetId=aba_tracker&ds.goalprogress.tableId=v_goal_progress&ds.goalprogress.refreshFields=true&ds.behaviortrend.connector=bigQuery&ds.behaviortrend.type=TABLE&ds.behaviortrend.projectId=rt-aba-tracker&ds.behaviortrend.billingProjectId=rt-aba-tracker&ds.behaviortrend.datasetId=aba_tracker&ds.behaviortrend.tableId=v_behavior_trend&ds.behaviortrend.refreshFields=true&ds.authutil.connector=bigQuery&ds.authutil.type=TABLE&ds.authutil.projectId=rt-aba-tracker&ds.authutil.billingProjectId=rt-aba-tracker&ds.authutil.datasetId=aba_tracker&ds.authutil.tableId=v_authorization_utilization&ds.authutil.refreshFields=true&ds.mastery.connector=bigQuery&ds.mastery.type=TABLE&ds.mastery.projectId=rt-aba-tracker&ds.mastery.billingProjectId=rt-aba-tracker&ds.mastery.datasetId=aba_tracker&ds.mastery.tableId=v_mastery&ds.mastery.refreshFields=true
```

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

## Page 6 — Mastery / RBT review   (source: `v_mastery`)
| Chart | Type | Dimension | Metric / note |
|-------|------|-----------|---------------|
| Pending BCBA review | Table | `client_id`, `type`, `code`, `description`, `status` | filter `status` = recommended / pendingGeneralization |
| Confirmed mastery | Scorecard | — | COUNT where `status` = confirmed |
| Mastery over time | Time series | `mastery_date` (breakdown `type`) | COUNT records |
| Review detail | Table | `code`, `status`, `approved_by`, `approval_date`, `settings_observed` | — |
> `type` = goal or behavior. Use the `status` filter to drive the BCBA
> Approve/Dismiss workflow queue.

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
