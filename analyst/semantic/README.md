# Semantic layer — RT ABA Tracker warehouse

Makes the BigQuery data **understandable to a model** (and to the Claude MCP)
without guessing meaning or joins. Three parts:

| File | What it is | How it's used |
|------|-----------|---------------|
| `schema.json` | Machine-readable data dictionary: entities, columns, types, meanings, allowed values, **join keys**, metric definitions, PHI flags, training notes | Feed to a model / attach for NL→SQL so it never hallucinates joins |
| `apply_descriptions.sql` | Sets BigQuery **table + column descriptions** in the catalog | Run once so the descriptions live in BigQuery itself (read by MCP, Looker, `INFORMATION_SCHEMA`) |
| `../deidentified_views.sql` | Curated, PHI-free, grain-consistent **views** | The safe query surface for analytics, Looker, and training-set construction |

## Setup
1. Run `apply_descriptions.sql` (BigQuery console or `bq query`).
2. Run `../deidentified_views.sql` to create the curated views.
3. Point the Claude MCP / Looker / any model at the views, and attach
   `schema.json` for full semantics.

## Key facts a model needs
- **Grain:** `behavior_records` and `trial_records` are **long format** (one row
  per behavior / per goal per session) — already tidy for ML.
- **Join keys:** `submission_id` ties a session to its behaviors/trials/ABC;
  `client_id`, `goal_code`, `behavior_key`, `billing_code`, `therapist_email`
  join to the dimensions.
- **Always filter `is_draft = FALSE`.**
- **PHI to exclude** for de-identified/training use: `notes`, `client_name`,
  ABC `antecedent`/`consequence`, `authorization_number`.
- **duration_min is billable (active) time** — excludes paused time (v4).

## For training the LHBM
`schema.json → training_notes` lists the exclusions, the draft filter, the tidy
shape, and the honest volume caveat (small dataset today → fine-tune / few-shot /
evaluation, not from-scratch training). The next artifact to add is a
**training-feature view** once a prediction target is chosen (e.g. time-to-
mastery, next-session frequency, regression risk) — say the word and I'll build
it on top of the de-identified views.
