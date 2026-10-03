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

**Admin config editing is NOT duplicated into the console.** `objectsToSheet`
rewrites each config tab from a fixed header list, so any column missing from that
list is dropped on save — two editors feeding one destructive writer would mean one
page silently erasing the other's fields. (We hit exactly that twice in a week with
only one editor: `goalId` and `parentEmail`.) One implementation each, surfaced
where it belongs, never copied; the console links out to the app's admin panel.
Tabs that are genuinely desktop work — authorizations, payroll, billing, settings —
may *move* here later, one at a time, deleting the app copy as each lands.

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

---

## 8. goalId migration — runbook

Built additive and reversible. Run these **in order**, from the Apps Script editor,
reading the Execution log after each.

| # | Call | Writes? | What |
|---|---|---|---|
| 1 | `backupGoalsTab()` | yes (new tab) | Timestamped duplicate of Goals. Prints the rollback command. **Do not skip.** |
| 2 | `previewGoalIdMigration()` | no | Lists every id it would assign; refuses nothing, but reports duplicate `clientId\|code` rows as collisions. |
| 3 | `migrateGoalIds(false)` | yes | Fills blank `goalId` cells only. Throws if collisions exist. |
| 4 | `verifyGoalIds()` | no | PASS/FAIL: every goal has a unique, non-empty id. |

**Rollback:** `rollbackGoalsFromBackup("Goals_backup_YYYYMMDD-HHMMSS")` — the name is
printed by step 1 and written to the Audit Log.

**Why it is safe:**
- **Additive only.** A column is appended; no cell outside it is touched.
  `ensureSheetColumns` never moves an existing column.
- **Deterministic ids** (`SHA-256` of `clientId|CODE`, first 12 hex) so a rollback
  followed by a re-run produces *identical* ids. Replay cannot drift.
- **Idempotent.** Only blank cells are filled; a second run is a no-op.
- **Lock-protected**, like every other config write.
- **Audited** at backup, migration and rollback.

**The one sharp edge.** `objectsToSheet` rewrites the Goals tab from the header list in
`saveConfig`. Reverting `Code.gs` to a build without `'goalId'` in that list will
**drop the column** on the next config save. So a code rollback must be paired with
`rollbackGoalsFromBackup`, and the backup tab should be kept until the migration has
survived a few days of normal use.

**Nothing reads `goalId` yet.** It is written and preserved but not joined on, so this
migration changes no behaviour — by design. Downstream references move from `code` to
`goalId` as a separate, later step, once the column is populated and verified.

---

# PART 2 — Reality check against Tatiana's actual workbooks (Oct 3 2026)

Read from her real files. **This supersedes several assumptions in Part 1.** The
lesson: designing the plan schema from first principles would have been wrong in
at least two structural ways.

## What she actually uses — six instruments, not two

| Instrument | Shape |
|---|---|
| **ABLLS-R** | Baseline / 6-Month / 12-Month / 18-Month tabs + History & Compare + Recommended Goals + Summary Dashboard |
| **VB-MAPP** | Milestones, Barriers, Milestones Grid, Goal Targets, Graphs |
| **AFLS** ×3 | Basic Living Skills, Home Skills, Community Participation — each Dashboard/Assessment/Baseline/6/12/18-Month/History/Goals |
| **QABF** | Per-target-behavior sheets (up to 10), informant-rated, X/0/1/… key |
| **Family Intake Questionnaire** | 7 sections, her own instrument |

**This vindicates building f36 before f34/f35 more strongly than argued.** Six
instruments would have been six hand-built screens.

## Finding 1 — administrations are FIXED PERIODS, not free dates

Every instrument uses **Baseline / 6-Month / 12-Month / 18-Month**, and the
History & Compare tab lays them out as aligned columns with **delta columns**
(`Δ B→6`, `Δ 6→12`). Part 1 modelled `administeredDate` as a free date, which
would not produce a comparison grid.

**Change:** add `administrationType` = `baseline | 6-month | 12-month | 18-month |
ad-hoc`. `isBaseline` becomes a special case of it. Deltas stay computed, never
stored.

## Finding 2 — the plan's goals are TWO-LEVEL

Part 1 had a flat `plan_goal`. The real template is a hierarchy:

```
Long Term Objective        Domain | Description | Status
  └─ Short Term Objective  Target Behavior | Short Term Objective | Measure |
                           Status | Baseline | Initiation Date | Current Level
```

**Change:** `plan_lto` and `plan_sto`, with `plan_sto.goalId` linking to the goal
registry. An LTO is narrative and has no trial data behind it — which answers the
Part 1 open question "can an objective be narrative-only": yes, at the LTO level.

## Finding 3 — she already does f39, by hand

The **Recommended Goals** tab is `Task | Skill Name | Max | Score | Status |
Mastery Criteria | IEP Goal | BCBA Notes`, with `IEP Goal` = *Pending* and a free
BCBA note per item.

So the gap→goal decision is **an annotation on the assessment item**, not a
separate recommendation table. That is simpler than Part 1 proposed.

**Change:** `Assessment Items` gains `iepGoalStatus` (`pending | selected |
declined`) and `bcbaNote`. f39 becomes "compute status, let her annotate" rather
than a new entity.

## Finding 4 — the item model needs one more column

ABLLS-R items are `Task | Skill Name | Max | Score | % Score | Status | Mastery
Criteria | Notes | Domain`, and **`Max` varies per item** (2.0, 4.0 …) — already
handled by per-item `scoreMin`/`scoreMax`. But each item also carries a **text
mastery-criteria anchor** ("4 = takes within 3 sec, all the time; 2 = sometimes…")
which is what makes scoring consistent between scorers.

**Change:** `Instruments` gains `masteryCriteria` (text). Note this is publisher
item text, so it falls under the licensing decision — see below.

## Finding 5 — "Curricular assessments" IS the assessment→plan bridge

A plan sheet already exists: `Assessment | Date | Results | Target Goals`. The
link we were designing is one she already draws manually. Build it as that sheet.

## Finding 6 — the Lists sheet is a controlled vocabulary we should adopt

`Sex · Language · Diagnosis (ICD-10, e.g. F84.0) · FundingSource · ServiceType ·
AssessmentTool (QABF/FAST/MAS/ABC Data/Structured Interview) ·
HypothesizedFunction · BehaviorCategory · SupportLevel · measure dimensions
(Rate, Latency)`.

Two conflicts to resolve:
1. **`SupportLevel` (Independent / Minimal / Moderate / Full) is NOT the f30a
   prompt hierarchy (I/VT/G/V/M/PP/FP).** Two different support scales now exist
   in the system. Either map them explicitly or pick one — silently keeping both
   will produce two incompatible answers to "how much support does this child
   need".
2. `HypothesizedFunction` must match the ABC incident list already in the app (q15).

## Finding 7 — fields the app does not have but the plan needs

- `Behaviors`: **no topographical (operational) definition.** The plan requires
  one per target behavior, and it is what makes two scorers agree.
- `Clients`: no DOB, diagnosis, address, phone, funding source, service type, or
  requested date range — all present on the plan's General Info sheet.
- Behavior measurement: the app records frequency and duration; the plan allows
  **Rate** and **Latency** dimensions.

## Licensing, revisited now that the forms are visible

Her workbooks contain the publishers' `Skill Name` and `Mastery Criteria` text.
She is licensed for that. The open question is whether **our** system stores it:

- Storing it in **her own RT Admin sheet** is arguably equivalent to her existing
  workbook — same account, same practice, no redistribution.
- Storing it in **our repo or a shipped config** would be redistribution, and
  would become a real problem the moment the app is multi-tenant or sold.

**Recommendation:** import item text into her RT Admin sheet (so scoring is
usable), but never commit instrument text to the repo and never ship it in a
default config. The repo keeps codes, maxima and structure only.

---

# PART 3 — Tatiana's answers (Oct 3 2026)

Answered directly in the design-review page. All eight questions plus the five
closing asks. **Q1, Q3, Q4, Q5, Q6, Q7 agreed as recommended.** The rest refine
or change the plan.

## Q2 — who may score, refined

> *"They score, still needs Tatiana approval."*

Not quite either option offered. Student analysts **score directly** — the score
is recorded as entered — but it is **pending her approval** until she confirms it.
So an assessment item carries an approval state, and this mirrors the behavior
mastery workflow exactly: the system records, the BCBA confirms.

**Implication:** `Assessment Items` needs `approvalStatus`
(`pending | approved | amended`), `approvedBy`, `approvalDate` — the same four
columns the Mastery Log gained in q17. An administration is not *complete* until
its session-scored items are approved.

## Q8 — next objective, refined and now very concrete

> *"Give me the next 3-5 instrument sequence, I will pick one from there."*

She does not want a single recommendation; she wants a **shortlist of 3 to 5 in
instrument sequence** and will choose. That is **Tier 0 exactly**, and it removes
any need for a model to pick a winner — the ranking only has to be good enough to
put the right item in a shortlist of five.

This makes f61 considerably easier and more honest than first scoped.

## Instrument order — VB-MAPP first, not ABLLS-R

> *"Lets use to prove the whole loop VBMAPP it is shorter than ablls"*

**f35 moves ahead of f34.** VB-MAPP (~170 milestones) proves the loop faster than
ABLLS-R (500+). Reorder: f36 (done) → **f35** → f37 → f38/f39.

## BAA — confirmed for Gmail and Drive

So parent alert emails may go to real families once the sending address is
chosen, and uploaded assessment PDFs may live in the practice Drive. The From
address is now the only thing still blocking f54 from real use.

## Student analyst — a profile value, not a credential column

> *"add a profile option in the therapist profile in the admin panel called
> RBT - Student Analyst"*

Simpler than the `credential` column proposed in Part 1, and it reuses a field
that already exists. **But it has a billing consequence that must be handled
first.**

```
CFG.BILLING_MATRIX[`${b.profile}|${b.sessionType}`] = b.code
```

`profile` is **half the billing key**, and the Billing tab only has rows for
`RBT` and `BCBA`. Add the profile without adding Billing rows and every session
run by a student analyst submits with **no billing code** — which flows into
`Time In Time Out`, `sessions.billing_code` in BigQuery, the weekly billing
report, and authorization consumed-hours tracking. The practice would silently
fail to bill those sessions and authorization utilisation would be wrong.

**So this is not a one-line change.** Before the profile option ships, Billing
needs rows for `RBT - Student Analyst` against each session type — and *which
codes apply is a billing question only Tatiana can answer* (a student analyst may
bill as a technician under 97153, or as an assistant under supervision, depending
on credential and payer).

## New requirement — plan approval pushes goals automatically

> *"once a behavioral plan is finalized and approved the goals should be
> automatically transfered to the tracker app for the sessions"*

This is **seam A, and it is automatic** — not a manual "create goal" step. On
finalise/approve, every short-term objective creates or links its row in the goal
registry, and it appears on the RBT's trial screen from the next session.

Consequences worth stating:
- **Approval becomes a real state transition**, not a signature. `draft →
  approved` is the event that writes goals.
- Per Q5, a shared goal gets a **per-client copy** at that moment.
- Un-approving must not orphan collected data: a goal that already has trial rows
  is **deactivated**, never deleted.
- Writing goals is a config write, so it goes through the same lock as every
  other `saveConfig`, and must preserve `goalId` on existing rows.

## Billing resolved — and goals must remain addable outside the plan

> *"RBT and RBT-STUDENT ANALYST IS THE SAME from the billing perspective"*

So the new profile does not need its own Billing rows. Rather than duplicating
every RBT row and then keeping two sets in step forever, the lookup follows an
explicit alias:

```js
BILLING_PROFILE_ALIAS: { 'RBT - Student Analyst': 'RBT' }
```

`billingCodeFor(profile, sessionType)` tries the exact key, then the alias. One
resolver, used by both the End-screen display and the submit payload, so the two
can no longer disagree. Verified against six cases including the ones that
*should* return nothing (`RBT | Supervision` has no row and still must not
silently borrow a BCBA code).

> *"even after the behavioral plan send automatically the goals to the tracker
> for that patient we still want to be able to add more in the tracker that are
> not in the behavioral plan"*

Confirmed as a requirement, and it constrains f40 more than it first appears.
**The plan contributes goals; it does not own the goal list.**

- A goal may exist with **no plan behind it** — created directly in admin, as all
  243 current goals were. That stays true forever.
- So every goal needs **provenance**: `sourcePlanId` and `sourceStoId` are set for
  plan-created goals and empty for ad-hoc ones.
- **A plan may only ever touch goals it created.** Re-approving, amending or
  un-approving a plan must never deactivate or rewrite a goal with no
  `sourcePlanId` — otherwise a BCBA's ad-hoc goal would vanish when an unrelated
  plan is revised. This is the single most dangerous edge in f40.
- The reverse also holds: an ad-hoc goal that later belongs in the plan gets
  **adopted** (its `sourceStoId` filled in), never duplicated.

---

# PART 4 — The completed plan (read Oct 3 2026)

A finished plan, not the template. Seven findings the blank form could not show.
Structure only recorded here; the plan itself is PHI and stays out of the repo.

## 1. Assessment billing codes the app cannot express

The `Lists` sheet carries a **ServiceCode** vocabulary:

```
97151  Behavior Identification Assessment
97152  Behavior ID Supporting Assessment
97153  Adaptive Behavior Treatment by Protocol
```

The app's Billing matrix only knows 97153, 97155 and 97156 — **treatment codes**.
So an **assessment session cannot currently be billed at all**: there is no
session type that maps to 97151 or 97152.

This lands directly on f58. A mobile assessment session is not just a different
screen, it is a **differently billed activity**, and shipping it without the
session type and Billing rows would repeat the student-analyst billing hole in a
new place. f58 therefore needs: session types for assessment, Billing rows
mapping them to 97151/97152, and a decision from Tatiana about which code applies
to a student-analyst-run assessment versus a BCBA-run one.

## 2. Her goal codes already encode assessment provenance

The Curricular Assessments sheet lists target goals as `VL-DaR-10`, and the Goals
tab already holds codes like `VL-16`, `VL17`, `VL25`, `VL-C`, `DaReMath02`.

The pattern is **instrument + client initials + sequence**. She has been encoding
*which assessment a goal came from* in the code string by hand, for years.

So `sourceAssessmentId` / `sourceItemCode` provenance is not a new concept being
imposed — it **formalises an existing convention** and frees the code string to be
a readable label. Worth saying to her in those terms.

## 3. Long-term objective domains are a controlled vocabulary

`Domain` on the Lists sheet: **Health and Safety · Self-Advocacy · Social
Relationships** (and more below the sample). The LTO row is
`Domain | <value> | Description | <text> | Status | <value>` — so an LTO is a
*domain* plus a narrative description plus a status, with the domain picked from a
list rather than typed.

## 4. Problem behaviors has two columns the template lacked

The completed sheet adds **Expected mastery date** and **Status** to the template's
columns. Expected mastery date is a clinical commitment with a date on it — which
is exactly the quantity f61's prediction tier would eventually estimate, and which
gives us a ready-made accuracy measure: predicted versus actual.

## 5. Lists is 21 vocabularies, not the 9 the template showed

Beyond the ones already recorded: **Dimension** (Frequency/Duration/Intensity),
**Measure** (Frequency/Percentage/Duration — separate from Dimension),
**Status** (New/Continued/Mastered), **CurricularAssessment**,
**StaffRole** (Parent/Caregiver, BCBA, BCaBA), **FidelityFrequency**,
**ServiceCode**, **Allocation** (Weekly/Monthly/Per Period),
**Location** (Home/School/Community), **Satisfaction**, **YesNo**, **Domain**.

Two to reconcile with the app:
- **Location** (Home/School/Community) against the app's session Setting values.
- **Status** (New/Continued/Mastered) as the objective lifecycle — note *Continued*
  is the state an objective carries across plan versions, which is what Part 1
  guessed at and this confirms.

## 6. Curricular assessment results are narrative, not just scores

For Vineland the `Results` cell is a written summary, with `Target Goals` holding
a grouped list of goal codes and their wording. So **f62 needs a narrative
Results field alongside the domain scores** — the numbers alone would lose the
interpretation, which is the part that justifies the goals.

## 7. The signature block carries credential and certificate number

`BCBA / Clinician` is followed by name with post-nominals and a **Certificate No.**
Any generated plan has to reproduce both, so they belong on the therapist record
rather than being typed per plan.

## Scale, for sizing the editor

FBA runs to ~106 rows, Curricular Assessments ~98, Instructional Goals ~76,
Integration/Generalization ~63. These are **long narrative documents**, not compact
forms — so the plan editor is closer to a structured document editor than to a
table, and the narrative sections need generous text areas with the same
continuous-save behaviour as session notes.
