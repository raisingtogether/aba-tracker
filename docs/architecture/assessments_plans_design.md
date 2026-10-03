# Assessments & Behavioral Plans — design (f33–f42)

**Status:** design, Oct 3 2026. Covers the separate clinical console, how assessments
are defined/administered/archived, how they seed a plan draft, and the entity lineage
that keeps plans, goals, trial data and mastery consistent.

---

## 0. Five findings that change the plan

1. **Build f36 BEFORE f34/f35.** An assessment instrument must be **data, not code**.
   ABLLS-R is ~500+ items across 25 domains; VB-MAPP ~170 milestones. Hand-authoring
   either as markup means writing the same screen twice and ending with two
   unmaintainable monoliths. Build one data-driven renderer + scoring engine, then each
   instrument is a definition file. This inverts the current P0/P2 ordering.

2. **ABLLS-R and VB-MAPP are copyrighted commercial instruments.** ABLLS-R is
   Partington / Behavior Analysts Inc.; VB-MAPP is Sundberg / AVB Press. Embedding their
   item text in software is a licensing question and possibly a violation — practices
   normally hold per-client paper or digital licences, not redistribution rights.
   **Resolve this before f34 is built.** The safe design: store **item codes and scores
   only**, with the full item text staying in the licensed materials Tatiana already
   owns. The app becomes a scoring and tracking surface, not a copy of the instrument.
   A practice-authored criterion checklist is also an option and carries no licence risk.

3. **`Goals` has no stable identifier — this is a latent integrity bug today.**
   The tab is `clientId, clientIds, code, description, numTrials, status`. Everything
   downstream references a goal by its **user-editable `code` string**: Trial Data goal
   columns, `Trial Summary.Goal Code`, `trial_records.goal_code`, and `mastery_log`
   keyed on `type + code`. Rename a code and every historical trial row and mastery
   entry silently orphans. Plans make this far worse, because the plan would break too.
   **Add an immutable `goalId` to Goals before building plans.** Code stays the human
   label; `goalId` becomes the join key.

4. **The planned `assessments` BigQuery schema is missing an instance key.** The roadmap
   specifies `clientId, assessmentType, date, domain, subdomain, itemCode, score,
   scorerEmail` — item-grain, which is right, but with nothing grouping items into one
   administration. Two administrations in the same month become indistinguishable.
   Add **`assessmentId`**.

5. **Do not wait for the model to suggest goals.** Rule-based suggestion (items below
   criterion in prioritised domains → candidate objectives) is deterministic,
   explainable and insurance-defensible, works today with no ML, and generates exactly
   the accept/reject training data that m21 later learns from. Same logic as prompt
   level: ship the deterministic version, accumulate the signal.

---

## 1. Separate clinical console — yes, but as a second page

`index.html` is one ~6,900-line file, mobile-first, built for one-handed collection
during therapy. Adding 500-item assessment forms and plan authoring to it is wrong on
three counts: it bloats the bundle an RBT downloads on a phone for screens they will
never open; the admin panel is already straining (12 tabs overflowing horizontally —
the Alerts tab had to be moved because it sat off-screen); and the work itself is
keyboard-and-large-screen work.

**Recommendation: a second page in the same Firebase site** — `/clinical` alongside the
existing `/tracker`, its own HTML file, talking to the same GAS `doPost`, reusing tier-1
Google OAuth. No new infrastructure, no new auth, no new deploy path, and it mirrors a
pattern the project already uses.

**Rejected:** a separate SPA with a build pipeline (introduces tooling this project has
deliberately avoided, for a team of one); and desktop-responsive screens inside
`index.html` (worst of both — bundle cost plus maintenance cost).

**Still shared:** the GAS backend, RT Admin as config store, the audit log, and the role
model. The console is a different *view*, not a different *system*.

---

## 2. Instrument definition vs administration

Two entities that are easy to conflate:

| | **Instrument definition** | **Administration (instance)** |
|---|---|---|
| What | The item bank: domains, item codes, scoring scale, criteria | One scoring of one instrument, for one client, on one date |
| Scope | Same for every client | Per client, per date |
| Changes | Versioned, rarely | Created constantly |
| Store | `RT Admin → Instruments` tab (or a JSON file per instrument) | `assessments` (header) + `assessment_items` (rows) |

**Instrument definition** carries `instrumentId, version, domain, subdomain, itemCode,
label (practice's own wording), scoreScale, criterion, sortOrder`. Versioned, because
re-scoring against a changed item bank must stay interpretable.

**Choosing one for a patient:** client → instrument → *new administration* or
*re-assessment* (which copies the previous scores forward as a starting point, since
most items do not change between administrations — this is the difference between a
20-minute re-assessment and a 3-hour one).

---

## 3. Collection and archival → baseline

- **Item-grain rows, immutable once complete.** A re-assessment is a **new
  `assessmentId`**, never an edit of the old one. That is what makes comparison (f42)
  possible and what an insurer expects to see.
- **Partial entry must be safe.** 500 items is not one sitting. Draft status, continuous
  save, resume — the same lesson as f55 session notes, and the same mechanism as the
  existing suspended-session backup.
- **Store raw item scores; derive domain summaries.** Never store only the summary.
  Same principle as storing prompt level codes rather than ranks.
- **`isBaseline` is an explicit flag, not `min(date)`.** A client may transfer in with an
  existing assessment, and the first administration may be abandoned incomplete.
- **Status vocabulary:** `draft → complete → signed`. Only `complete`/`signed` feed goal
  suggestion or BigQuery.

---

## 4. Plan draft from assessment (f39 → f38)

```
assessment items below criterion
        │  rule: score <= threshold, in a domain the BCBA prioritised
        ▼
candidate objectives  (ranked; each carries its source itemCode)
        │  BCBA selects, edits wording, sets baseline + target
        ▼
plan_goals            (clinical intent)
        │  each creates or links a Goals row
        ▼
Goals                 (what the RBT actually collects)
```

The BCBA always edits before anything is committed — suggestion, never automation.
Every accept/reject is logged, which is the m21 training set.

---

## 5. Entity lineage (the core of the design)

**One goal registry. Plans reference goals; they do not own them.** The `Goals` tab stays
the single source of truth for what is collectible, because that is what the session
screen reads. A plan adds clinical context around a goal — baseline, target, rationale,
review date — but never becomes a second definition of it.

```
assessment (assessmentId, clientId, instrumentId+version, date, isBaseline, status)
     │
     └── assessment_item (assessmentId, itemCode, domain, score)
                │
                │  f39 suggestion  ─ provenance: sourceAssessmentId + sourceItemCode
                ▼
behavioral_plan (planId, clientId, planVersion, status, startDate, reviewDate)
     │
     └── plan_goal (planId, goalId ──┐ objective, baseline, target, status)
                                     │
                                     ▼
                              Goals (goalId ← NEW immutable key, clientId, code,
                                     description, numTrials, status,
                                     sourceAssessmentId, sourceItemCode, planId)
                                     │  referenced by code in sheets, goalId in BQ
                                     ▼
                     Trial Data / Trial Summary / trial_records
                       (goal_code, prompt_level, is_probe, pct)
                                     │
                                     ▼
                              mastery_log (type='goal', code)
```

**Rules that keep it consistent:**

- `goalId` is immutable and generated once. `code` remains the human-facing label and
  stays editable — renaming it must never break history, which is only true once
  `goalId` exists.
- A goal may exist **without** a plan (legacy goals, and anything created directly in
  admin today). Plans are additive; nothing existing breaks.
- A goal may be referenced by **successive** plan versions. `plan_goal.status` records
  `continued | mastered | discontinued` per version, so a goal's clinical history is
  readable across plans.
- **Plans are versioned, never edited in place.** Superseding creates `planVersion + 1`
  and archives the previous one — insurers and audits need the version that was in force
  on a given date.
- **Provenance is carried, not inferred.** A goal records the assessment item it came
  from. That is what answers "which assessment items predict fastest mastery" — a real
  LHBM question, and exactly what m20 wants.
- Nothing is ever deleted. Status transitions only.

---

## 6. Suggested build order

| Step | Item | Why here |
|---|---|---|
| 1 | **`goalId` migration** | Integrity bug today; hard prerequisite for lineage. Backfill ids, keep `code` as label. |
| 2 | **f33** Looker missing clients | Possibly producing wrong reports right now. Small. |
| 3 | **f36** instrument framework | Data-driven renderer + scoring. Build once. |
| 4 | **f34** ABLLS-R as a definition file | Only after the licensing question is answered. |
| 5 | **f37** assessments → BigQuery | With `assessmentId`. Unblocks m20. |
| 6 | **f38 + f39** plan generator + rule-based suggestion | Needs 1, 3, 4. |
| 7 | f40 / f41 / f35 / f42 | Assignment flow, sharing, VB-MAPP, re-assessment comparison. |

The clinical console (section 1) is the shell that steps 3–7 are built inside, so it
comes with step 3.

## 7. Open questions for Tatiana / Rodrigo

1. **Licensing** for ABLLS-R and VB-MAPP — what does the practice actually hold?
   This gates f34/f35 and decides whether the app stores item text at all.
2. Which instrument matters first in practice?
3. Does a plan need a **parent signature** (reuse f28's signature pad) and an
   **insurer-facing export**? f41 implies both.
4. Are plan objectives always 1:1 with collectible goals, or can an objective be
   narrative-only with no trial data behind it?
