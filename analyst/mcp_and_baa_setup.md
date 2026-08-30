# BigQuery MCP for Claude + Anthropic BAA

Two audiences:
- **Developer machine** → the local read-only MCP already scaffolded (`.mcp.json`,
  ergut server, service-account key). See `README.md`.
- **BCBA (Tatiana) on her own computer** → the **OAuth** path below. No Node, no
  key file, no gcloud — she signs in with her Google account.

> ⚠️ **Compliance gate:** real PHI must not flow through Claude until the
> **Anthropic BAA is in place** (Part C) and you're using de-identified views
> where possible. Set up the BAA first.

---

## Part A — One-time GCP setup (developer / GCP admin)

1. **Enable the API:** GCP console → project `rt-aba-tracker` → enable **BigQuery API**.
2. **OAuth consent screen:** APIs & Services → OAuth consent screen → Internal (if
   Tatiana is in your Google Workspace org) → add her as a user/tester.
3. **OAuth client / redirect URI:** the claude.ai custom connector uses redirect
   URI **`https://claude.ai/api/mcp/auth_callback`** — add it to the OAuth client.
   (Propagation can take a few minutes.)
4. **Grant Tatiana read-only access** — prefer the de-identified dataset:
   ```bash
   PROJECT=rt-aba-tracker
   USER=tatiana@raising2gether.org
   # If you created a de-identified dataset (recommended), grant on THAT only:
   #   bq add-iam-policy-binding --member="user:$USER" \
   #     --role="roles/bigquery.dataViewer" $PROJECT:aba_tracker_deid
   gcloud projects add-iam-policy-binding "$PROJECT" \
     --member="user:$USER" --role="roles/bigquery.jobUser"     # run queries
   gcloud projects add-iam-policy-binding "$PROJECT" \
     --member="user:$USER" --role="roles/bigquery.dataViewer"  # read data
   ```
5. **Create the de-identified views** in `deidentified_views.sql` (so notes/names
   never surface), and point Tatiana at those.
6. **Get the managed MCP server URL** from Google's doc
   (https://docs.cloud.google.com/bigquery/docs/use-bigquery-mcp) — Google's
   fully-managed remote BigQuery MCP is an HTTPS endpoint using OAuth 2.0 + IAM.
   Copy the current endpoint URL for step B.

---

## Part B — Tatiana's setup (her computer, ~10 min, one time)

Plain-language steps for **claude.ai**:

1. Go to **claude.ai** → **Settings** → **Connectors**.
2. Click **+ Add custom connector**.
3. **Name:** `Google BigQuery`.  **Remote MCP server URL:** paste the URL from A-6.
4. Click **Add** → it appears under *Not connected* → click **Connect**.
5. A Google sign-in opens → sign in with **her** Google account → **Allow**.
6. Done. In a chat she can ask, e.g.:
   - *"From aba_tracker, weekly billed hours by therapist this month."*
   - *"Average percent-correct for client C123 by goal, last 8 weeks."*
   - *"Which authorizations are over 90% utilized?"*

The `bq-analyst` skill's rules (aggregate, LIMIT, de-identified views, no notes)
apply. Read-only is enforced by her IAM roles — she cannot modify anything.

> If she uses **Claude Desktop** instead of the web app, the same connector is
> added under Desktop → Settings → Connectors. If she uses **Claude Code**, add a
> remote server: `claude mcp add --transport http bigquery <URL>`.

---

## Part C — Anthropic BAA (business/legal — your action)

A BAA (Business Associate Agreement) is required for HIPAA-covered PHI to be
processed by Anthropic. Key points:

- **Where it applies:** the **Anthropic API** and **Claude for Work
  (Team/Enterprise)** can be covered under a BAA on eligible commercial plans.
  The **free/Pro consumer** claude.ai tier is **not** covered — so if Tatiana
  will query real PHI via claude.ai, she must be on a **Team/Enterprise** plan
  that is under your BAA.
- **How to get it:**
  1. Go to Anthropic → **Contact Sales / Enterprise** (or your account manager)
     and request a **BAA for HIPAA**.
  2. Confirm which products the BAA covers (API vs Claude for Work) and ensure the
     product Tatiana uses is in scope.
  3. Execute the BAA (legal signs), then enable/confirm any required account
     settings (e.g., zero-data-retention / no-training flags per the agreement).
- **Until the BAA is signed:** restrict analytics to **de-identified views only**
  (no notes, no names — the views in `deidentified_views.sql` are built for this),
  which keeps PHI out of Claude entirely.

**Recommended sequence:** (1) request the BAA, (2) build the de-identified views,
(3) set up the OAuth connector for Tatiana pointing at those views, (4) expand to
identified data only once the BAA is executed and the plan is in scope.

Sources: Google Cloud "Use the BigQuery MCP server"; claude.ai custom-connector
OAuth setup.
