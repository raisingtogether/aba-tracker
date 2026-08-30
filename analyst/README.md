# Analyst side — read-only BigQuery access for Claude

Conversational, read-only analytics over the ABA data warehouse (BigQuery
project **`rt-aba-tracker`**, dataset **`aba_tracker`**). This is an
**analyst / admin / dev** surface — NOT the end-user app. Therapists keep using
the PWA; this lets you and BCBAs ask questions and generate one-off reports.

> **Read-only by design + defense in depth:** the MCP server only issues
> `SELECT` (validated by BigQuery's dry-run planner), **and** you authenticate
> with a read-only identity so the credential itself cannot write. Both layers
> must be in place.

---

## 1. Create a read-only service account (least privilege)

```bash
PROJECT=rt-aba-tracker

gcloud iam service-accounts create bq-readonly-analyst \
  --project="$PROJECT" \
  --display-name="RT ABA read-only analyst (MCP)"

SA="bq-readonly-analyst@$PROJECT.iam.gserviceaccount.com"

# Read data + run query jobs — nothing else.
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role="roles/bigquery.dataViewer"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role="roles/bigquery.jobUser"

# Key stored OUTSIDE the repo (path is git-ignored via .rt-aba/).
mkdir -p ~/.rt-aba
gcloud iam service-accounts keys create ~/.rt-aba/bq-readonly-sa.json \
  --iam-account="$SA"
```

Tighten further (optional): grant `dataViewer` on the **dataset** only, or
grant it on a **de-identified views dataset** (see step 4) instead of the raw
`aba_tracker` dataset, so PHI never leaves BigQuery.

## 2. Point Claude at the read-only key

Before launching Claude in this repo:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=~/.rt-aba/bq-readonly-sa.json
```

(Alternatively `gcloud auth application-default login` with an account that has
only read roles — but a dedicated read-only SA is the stronger guarantee.)

## 3. Enable the MCP server

The server is configured in `../.mcp.json` (project-scoped). In Claude:

- Run `/mcp` → approve the **`bigquery-analyst`** server.
- First run uses `npx -y @ergut/mcp-bigquery-server --project-id rt-aba-tracker`
  (auto-installs). If your dataset is not in the US multi-region, add
  `"--location", "<region>"` to the args in `.mcp.json`.

Verify with a question like *"list the tables in aba_tracker"* or
*"how many rows in sessions?"*.

## 4. De-identified views (recommended for PHI hygiene)

Prefer querying **de-identified views** rather than raw tables so free-text
notes and names never enter the LLM context. Templates are in
`deidentified_views.sql` — **verify the column names against your actual schema
first** (ask Claude: *"show columns of aba_tracker.sessions"*), then create the
views and grant the read-only SA access to only that views dataset.

## 5. HIPAA / security notes

- **Never commit** the SA key. `.gitignore` excludes `*.sa.json`, `analyst/*.json`,
  and `.rt-aba/`. The key lives in `~/.rt-aba/`.
- Prefer **aggregates over raw rows**, and query **de-identified views**; avoid
  pulling `notes` (free-text PHI) into context.
- If real PHI will pass through Claude, ensure a **BAA** with Anthropic on an
  eligible tier.
- This credential is **read-only**; it cannot modify the warehouse or the app.

## 6. Token efficiency

- The skill (`.claude/skills/bq-analyst`) constrains queries to **aggregates +
  `LIMIT`**, so results stay small and cheap.
- Ad-hoc analyst use (a few queries a day) costs pennies in both tokens and BQ.
- This is deliberately an analyst tool — do **not** wire it into the live app's
  per-interaction path.

## 7. Hardening upgrade path (optional)

For a stronger enterprise/HIPAA posture, switch to Google's **official BigQuery
MCP** (IAM-enforced HTTP endpoint `https://bigquery.googleapis.com/mcp`, uses
`execute_sql_readonly` and IAM deny policies, no local key file). Replace the
`bigquery-analyst` entry in `.mcp.json` with the official HTTP server config and
authenticate via OAuth/IAM. The skills and workflow are unchanged.

## Warehouse tables (from `BigQuerySync.gs`)

`sessions`, `behavior_records`, `trial_records`, `abc_incidents`, `mastery_log`,
`therapists`, `clients`, `authorizations`, `goals_reference`,
`behaviors_reference`, `billing_codes`.
