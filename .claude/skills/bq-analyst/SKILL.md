---
name: bq-analyst
description: Read-only BigQuery analytics for the RT ABA Tracker warehouse (project rt-aba-tracker, dataset aba_tracker). Use when asked for reports/metrics on sessions, billing, trials, behaviors, mastery, or authorizations — e.g. "weekly billing report", "mastery status for client X", "authorization utilization", "how many sessions did therapist Y bill last month". Runs SELECT-only queries via the bigquery-analyst MCP and returns small aggregated summaries.
---

# BigQuery analyst (read-only)

You are querying the ABA data warehouse through the **`bigquery-analyst`** MCP
server (read-only). Project `rt-aba-tracker`, dataset `aba_tracker`.

## Rules (non-negotiable)
1. **SELECT only.** Never attempt INSERT/UPDATE/DELETE/DDL. The server and the
   credential are read-only; a write attempt is a bug in your query.
2. **Aggregate, don't dump.** Return counts/sums/averages/rollups. Never
   `SELECT *` a whole table into context. Always add a `LIMIT` (≤ 100) on any
   row-level result.
3. **Avoid PHI.** Do not select free-text `notes` or client names. Prefer the
   de-identified views (`v_sessions_deid`, `v_trials_deid`, `v_behaviors_deid`,
   `v_authorizations_deid`) when they exist; otherwise select only IDs/codes and
   numeric fields.
4. **Verify schema before assuming columns.** If unsure of a column name, first
   query `INFORMATION_SCHEMA.COLUMNS` for that table.
5. **Show the SQL** you ran and a short, readable summary of the result. Offer a
   CSV/export only if asked.

## Tables
`sessions`, `behavior_records`, `trial_records`, `abc_incidents`, `mastery_log`,
`therapists`, `clients`, `authorizations`, `goals_reference`,
`behaviors_reference`, `billing_codes`.

## Common report intents (adjust column names to the real schema first)

**Weekly billing by therapist**
```sql
SELECT therapist_email, billing_code,
       ROUND(SUM(duration_min)/60, 2) AS hours,
       COUNT(*) AS sessions
FROM `rt-aba-tracker.aba_tracker.v_sessions_deid`
WHERE date_iso BETWEEN @start AND @end
GROUP BY therapist_email, billing_code
ORDER BY therapist_email, billing_code;
```

**Mastery status (recent)**
```sql
SELECT client_id, type, code, status, mastery_date
FROM `rt-aba-tracker.aba_tracker.mastery_log`
WHERE client_id = @clientId
ORDER BY mastery_date DESC
LIMIT 50;
```

**Authorization utilization**
```sql
SELECT a.client_id, a.billing_code, a.authorized_hours,
       ROUND(SUM(s.duration_min)/60, 2) AS used_hours
FROM `rt-aba-tracker.aba_tracker.v_authorizations_deid` a
LEFT JOIN `rt-aba-tracker.aba_tracker.v_sessions_deid` s
  ON s.client_id = a.client_id AND s.billing_code = a.billing_code
GROUP BY a.client_id, a.billing_code, a.authorized_hours
ORDER BY a.client_id, a.billing_code;
```

**Goal progress trend**
```sql
SELECT date_iso, AVG(percentage) AS avg_pct, COUNT(*) AS n
FROM `rt-aba-tracker.aba_tracker.v_trials_deid`
WHERE client_id = @clientId AND goal_code = @goalCode
GROUP BY date_iso
ORDER BY date_iso;
```

If a de-identified view is missing, fall back to the base table with the same
columns, and never include `notes` or names.
