# CLAUDE.md — Raising Together ABA Tracker

## Project overview
Mobile-first PWA for ABA therapy data collection with HIPAA compliance layer.
Single-file frontend (`index.html` — all JS/CSS inline) backed by Google Apps Script (`Code.gs`).
Deployed on Firebase Hosting at `rt-aba-tracker`.

## File map
| File | Purpose |
|------|---------|
| `index.html` | Complete frontend (all JS/CSS inline, ~5600 lines) |
| `Code.gs` | Google Apps Script backend (ES5 strict, ~1800 lines — migration code removed) |
| `BigQuerySync.gs` | BigQuery sync (ES5 strict, ~1050 lines — separate file, same GAS project) |
| `manifest.json` | PWA manifest for Add to Home Screen |
| `sw.js` | Service worker (offline support) |
| `firebase.json` | Firebase Hosting config — site must be `rt-aba-tracker` |
| `rt_feature_tracker.jsx` | Roadmap / feature tracker component (source; `tracker/index.html` is the deployed page) |
| `clinical/index.html` | **Clinical console** (`/clinical`) — desktop BCBA surface for assessments + plans |
| `docs/architecture/assessments_plans_design.md` | Assessment + plan schema, Tatiana's rulings, findings from her real workbooks |
| `docs/architecture/api_bus_design.md` | f26a/f26b integration bus design |
| `docs/architecture/phase1_5_plan.md` | m1–m4 ML scope (MLX not bitsandbytes; **IBM Granite** — Qwen dropped on provenance, Llama on licence) |
| `Assessments for BP/` | **PHI — gitignored.** Her real workbooks + a completed plan, used as schema reference |

## Critical Code.gs constraint
**ES5 only.** No `??`, no `?.`, no template literals, no arrow functions, no spread `...`,
no `let`/`const`, no `Array.from`, no destructuring. GAS runs V8 but the codebase is kept
ES5 for consistency and safety.

## Architecture

### Two-tier authentication
- **Tier 1 — Admin/BCBA:** Google OAuth implicit flow (`GOOGLE_CLIENT_ID`)
- **Tier 2 — RBT/Collector:** Email + 6-digit PIN + optional TOTP (Google Authenticator)

### Google Sheets layout
| Sheet | Purpose |
|-------|---------|
| RT Admin | Shared config: Therapists, Clients, Behaviors, Goals, Billing, Authorizations, Admins |
| RT Audit Log | HIPAA audit trail (separate sheet) |
| Per-client sheets | Time In Time Out, Behavior Data, Trial Data, ABC Data, Mastery Log |

### RT Admin tabs — column order matters
| Tab | Columns |
|-----|---------|
| Therapists | id, name, initials, color, profile, email, pin, totpSecret, clientIds, weeklyHourLimit, payRate, status, role |
| Clients | id, name, initials, sheetId, status, **parentName, parentEmail, parentLang, alertConsent, alertConsentDate** (f54) |
| Behaviors | key, label, icon, color, clientIds, status, **alertEnabled, alertThreshold, alertMode** (f54) |
| Goals | clientId, clientIds, code, description, numTrials, status |
| Billing | profile, sessionType, code |
| Authorizations | clientId, payerType, insuranceCompany, authorizationNumber, billingCode, authorizedHours, startDate, endDate, coInsurance, stepUpProgram, status, unitRate, hourlyRate |
| Admins | email, name, status |
| Suspended Sessions | suspendId, therapistEmail, clientId, clientName, sheetId, dateISO, updatedAt, status, stateJson **(v4 pause/resume; transient — NOT synced to BigQuery)** |
| Parent Alerts | alertId, createdAt, submissionId, dateISO, clientId, clientName, behaviorKey, behaviorLabel, count, threshold, mode, status, recipient, sentAt, sentBy, note **(f54; status = blocked\|pending\|sent\|dismissed\|failed)** |
| Behavior Definitions | clientId, behaviorKey, topography, onsetOffset, examples, nonExamples, updatedAt, updatedBy **(f74b — grain is clientId + behaviorKey: same behaviour name, different topography per child)** |
| Definition Acks | ackId, clientId, behaviorKey, defHash, ackAction, therapistEmail, therapistName, acknowledgedAt, dateISO **(f78 — APPEND-ONLY; `ackAction` = read\|skipped)** |
| Phase Changes | phaseId, clientId, dateISO, category, label, description, affectsBehaviors, createdAt, createdBy **(f77 — blank `affectsBehaviors` = all behaviours)** |
| Plan Lists | listName, value, sortOrder, status, notes **(f75 — 22 controlled vocabularies from her plan template; extend by adding a row)** |
| Instruments | instrumentId, version, domain, subdomain, itemCode, label, scoreMin, scoreMax, criterion, sortOrder, status **(f36 — the instrument is DATA, not code)** |
| Assessments | assessmentId, clientId, clientName, instrumentId, instrumentVersion, administeredDate, assessorEmail, assessorName, status, isBaseline, startedAt, updatedAt, completedAt, itemCount, scoredCount, notes, scoresJson **(f36)** |
| Assessment Items | assessmentId, clientId, instrumentId, itemCode, domain, subdomain, score, criterion, belowCriterion, administeredDate, dateISO **(f36 — written only at completion)** |
| Goals | **gained `goalId` (f43b)** — immutable join key, 243 rows migrated Oct 2026 |

**`parentEmail` is a comma-separated list.** `_parseRecipients` validates and
de-duplicates it, and each recipient is sent a **separate** message — never a
shared `To:` line, because co-parents must not learn each other's address from
us. `alertConsent` must be `'yes'` AND at least one address must be valid or
nothing sends; consent is re-checked at approval time, not only at session time.

### Per-client sheet tabs — analytics columns appended after core columns
`Time In Time Out`: Date, Billing Code, Session Type, Time In, Time Out, Duration (min), Therapist, Submission ID, Notes, submissionId, clientName, clientId, therapistEmail, sessionType, billingCode, isDraft, payloadHash, submittedAt, dateISO

`Behavior Data`: Date, Therapist, Setting, \<behavior labels\>, Tantrum Frequency, Tantrum Total (min), submissionId, clientName, clientId, therapistEmail, sessionType, billingCode, isDraft, payloadHash, submittedAt, dateISO

`Trial Data`: Date, Setting, Therapist, \<goal code columns\>, ...analytics, Percent Correct, **Prompt Levels, Trial Times, Probe Flags**

**The three f30 columns are ONE column each, whatever the goal count** — JSON maps
keyed by goal code, deliberately mirroring the `Percent Correct` pattern. Per-goal
column pairs would multiply the dynamic columns this tab has already needed
structural repairs for. Only `true` is written into `Probe Flags`, so an absent
key reads as "not a probe" — the same convention as an absent prompt level.

`Trial Summary` (normalized, one row per goal per session — 18 cols):
Date, Therapist, Setting, Goal Code, Goal Description, Trial 1-5, Percentage,
Source, Session ID, **Prompt Level, Prompt Level Label, First Scored At,
Last Scored At, Is Probe**

**Columns 1-13 are frozen.** Rows here are built as fixed-position arrays, and
two legacy writers (`recoverTrialData`, `checkTrialSummaryHealth`) still use the
original 13-column layout. Anything new must be **appended** to `TS_HEADERS` and
appended in the same order to the row push, so those writers keep working
untouched (they write/compare only columns 1-13).
**Do not run `recoverTrialData(false)`** casually now — it clears and rewrites
the tab 13 columns wide. It does preserve `Source = 'Live'` rows, which is what
protects the f30 data.

`Mastery Log`: type, code, description, masteryDate, lastScores, therapistName, therapistEmail, clientName, clientId, dateISO, **status**, **approvedBy**, **approvalDate**, **settingsObserved**

### Column alignment pattern
All sheet writes use `ensureSheetColumns` + colMap-based row building. **Never hardcode column positions.** Read the actual header row, build `{header: colIndex}` map, write by key. `sheetToObjects` returns raw cell values (not String-cast).

### Key GAS functions
| Function | Purpose |
|----------|---------|
| `doPost(e)` | Router — dispatches on `data.action` |
| `verifyLogin(email, pin, totp)` | Tier 2 auth; never returns pin/totpSecret |
| `hashPin(email, pin)` | SHA-256 of `email:pin` → 64-char hex |
| `saveConfig(cfg)` | LockService-protected; hashes new PINs; checks duplicate goal codes |
| `getWeeklyHours` / `getBiweeklyHours` | Prefer `dateISO` column; fallback to `date` |
| `checkBehaviorMastery` | 10 consecutive sessions ≤1; reads Setting column; returns status string |
| `getMasteryLogStatus` | Returns most recent mastery status for type+code; backfills old entries |
| `writeMasteryLog` | colMap-based row write; includes status, approvedBy, approvalDate, settingsObserved |
| `approveBehaviorMastery` | BCBA/Admin only; sets status='confirmed' on mastery log row |
| `dismissBehaviorMastery` | BCBA/Admin only; sets status='dismissed'; allows recovery recommendation |
| `checkGoalUsage` | Reads header row first; only scans full data when goal column found |
| `getMasteryStatus` | Goal mastery: 80%+ for 5 consecutive → 'confirmed'; Behavior: ≤1 for 10 consecutive |
| `getMasteryReport` | Aggregates mastery log across all clients; keeps most recent entry per behavior |
| `processSession` | Writes all 4 tabs + audit log, then `evaluateParentAlerts` (wrapped — never blocks a session write) |
| `evaluateParentAlerts` | f54. Behaviours past threshold → Parent Alerts rows; `auto` sends now, `review` queues |
| `_sendParentAlertEmail` | One message PER recipient; re-checks the consent gate itself so no call path bypasses it |
| `_parseRecipients` | Comma/semicolon/newline list → valid, de-duplicated addresses |
| `listParentAlerts` / `approveParentAlert` / `dismissParentAlert` | Admin/BCBA-gated; approve re-checks consent then sends |
| `deleteSuspendedSession(suspendId, reason, actorEmail)` | `reason='discarded'` audits as `session_discarded`; anything else keeps the historical `session_resumed_completed` |
| `checkGoalMastery` | f30b. 80% × 5 consecutive sessions **the goal was run in**, at Independent. No level = not run = **skipped**, not a break |
| `_promptLevelLabel` / `PROMPT_LEVEL_ORDER` | Server-side mirror of the frontend `PROMPT_LEVELS` order |
| `_defHash(topo, onset, ex, nonEx)` | f78. **Server mirror of frontend `simpleHash`** over the four definition fields, NUL-separated. Must stay byte-identical to `_defHashFor` — see below |
| `acknowledgeDefinition(data)` | f78. Appends a read/skip row. `read` is idempotent on `ackId`; `skip` always appends |
| `listDefinitionAcks(email, clientId)` | f78. Narrow by design — the acks table grows without bound and must NEVER ride along in `getConfig` |
| `getDefinitionAckReport(clientId, role)` | f78. Admin/BCBA-gated; every ack for one client, newest first |
| `_readPhaseChanges` / `_phaseCategories` | f77. Tolerant reads; categories come from `Plan Lists` with the seeded list as fallback |

### Key index.html globals/functions
| Symbol | Purpose |
|--------|---------|
| `GAS_URL` | Web App URL constant (set at top of `<script>`) |
| `GOOGLE_CLIENT_ID` | OAuth client ID |
| `S` | Session state object |
| `CFG` | Processed config (from `applyConfig`) |
| `RAW_CONFIG` | Raw config as received from GAS |
| `AUTH` | `{ user, tier, role }` |
| `escHtml(s)` | XSS-safe innerHTML — uses `div.textContent` |
| `escAttr(s)` | XSS-safe attribute values |
| `simpleHash(str)` | djb2 hash → hex (used for admin PIN storage) |
| `persistConfig(raw)` | Save config to GAS; debounces `renderAdminList` (500ms) |
| `loadMasteryStatus()` | 5-min module-level cache keyed by clientId+date |
| `loadAuthConsumedHours` | Parallel `Promise.all` fetches per billing code |
| `loginCheckTOTP()` | Shows TOTP field on email blur if therapist has totpSecret |
| `PROMPT_LEVELS` | f30a. Ordered array; **the stored value is the CODE, never the rank**, so reordering needs no migration. `V`=Verbal, `VT`=Visual/Textual |
| `setPromptLevel` / `setProbe` | Probe ticks → level forced to `I` and the select locked; unticking **clears** it so an accidental tick can't record Independent |
| `restorePromptLevelSelects()` | `buildTrials()` rebuilds the selects empty — call after BOTH snapshot restore paths (suspended session AND OAuth re-auth) |
| `S.promptLevels` / `S.trialTimes` / `S.isProbe` | Per-goal session state; all default to `{}` so pre-f30a snapshots resume cleanly |
| `discardActiveSession` / `discardSuspendedSession` | Clear a trial session from all **three** stores: server row, local snapshot, offline submit queue |
| `purgePendingSubmit(submissionId)` | The one that matters — a queued test session would otherwise auto-submit on reconnect |
| `renderParentAlertsTab` / `saveParentAlertRecipients` | f54 Alerts tab. Recipients live here too because `'clients'` is in `bcbaBlocked` |
| `_defHashFor(d)` | f78. **Mirror of `_defHash` in Code.gs.** Same djb2, same NUL separator, same field order, **no trimming on either side** — both read the same untrimmed sheet values, so trimming on one side only would split the hash and re-prompt everyone once |
| `unacknowledgedDefinitions()` | f78. **Fails open:** returns `[]` whenever `_defAcks.ready` is false, so no network failure can block data collection |
| `startSessionFlow()` | f78. The gate. Replaced `promptLateStart()` on the Begin Session button; resumed sessions are NOT re-gated |
| `_defBodyHtml(b)` | f78. Shared by `showBehaviorDefinition` and the ack modal so the wording confirmed is byte-identical to the wording shown mid-session |
| `flushAckQueue` / `rtPendingAcks` | f78. Queue-first-then-send, so an ack made offline is not lost |
| `renderPhasesTab` / `addPhaseChange` | f77. Refuses to write when `raw.phaseCategories` is absent — that means an older GAS paste whose `saveConfig` would silently drop the rows |

---

## Features added since initial CLAUDE.md

- End session time adjustment modal (after submit, with validation)
- Session timer visible (elapsed time in turquesa)
- Session notes guided template (8 sections, 150 word minimum)
- Goal mastery detection (80% × 5 consecutive sessions, gold star badge)
- Behavior mastery detection — BCBA-reviewed system (≤1 × 10 consecutive, 3-state badge)
- Monthly mastery report (admin panel, CSV export, Approve/Dismiss workflow)
- Authorization multi-code cards (multiple billing codes per authorization with unit/hourly rates)
- Weekly billing report (admin panel, CSV export)
- Admin manual session entry (backdated up to 24 hours)
- Goal duplicate code validation + goal delete with usage check
- Client filter in Goals admin section
- Logout button with confirmation
- Beforeunload warning during active session
- Auto-logout extended to 60 minutes
- PWA standalone Google Sign-In fix (55-min token cache)
- Double-submission guard (`_submitting` flag in `doSubmitSession`)
- Behaviors filtered by client assignment (only assigned behaviors appear in session)
- ABC incidents: behaviors filtered by client; Hypothesized Function multi-select
- Trial screen displays goal description names (not just codes)

---

## Data Repairs Completed (May 2026)

- **Code audit**: 30 issues found and fixed (1 CRITICAL, 8 HIGH, 10 MEDIUM, 11 LOW)
- **BigQuerySync audit**: 15 issues found and fixed
- **Camila Behavior Data**: structural repair (empty column removed, Type A/B/C row shifts corrected)
- **Camila TITO**: structural repair (2 empty columns removed, Type B/C data realigned)
- **Dylan TITO**: structural repair (1 empty column removed, Type A/B data realigned)
- **Submission ID unification**: 117 IDs reconciled across all tabs for all 5 clients (TITO as source of truth)
- **Historical data cleanup**: 417 fields filled, 3 duplicates removed
- **isDraft backfill**: 70 fields set to false
- **Migration code removed**: all one-time repair/migration functions deleted from production (2,714 lines removed)

---

## Mastery System — Final Status (May 10, 2026)

- Behavior mastery: BCBA-reviewed recommendation system working end-to-end
- 10 consecutive sessions ≤1 + 2+ settings → `'recommended'`; 1 setting → `'pendingGeneralization'`
- Approve/Dismiss buttons functional (Version 9 deployment)
- Duplicate prevention: `getMasteryLogStatus` returns `'recommended'` (not `''`) when entry exists but status column missing — blocks writes on every submit
- Backfill: existing entries auto-set to `'recommended'` (behaviors) or `'confirmed'` (goals) when status column is first created by `writeMasteryLog`
- Clean Dupes button in mastery report panel for manual dedup of older rows
- `getMasteryReport` entry objects include `sheetId` — frontend uses it directly (no `CFG.CLIENTS` lookup)
- Goal mastery: separate system (80% × 5 sessions), auto-confirmed, unchanged

---

## Behavior Mastery System (Updated May 2026)

- Changed from auto-declaration to BCBA-reviewed recommendation system
- **Threshold**: 10 consecutive sessions with count ≤1 (was 8)
- **Generalization**: 2+ distinct settings observed = `'recommended'`; 1 setting = `'pendingGeneralization'`
- **BCBA Approve/Dismiss workflow**: Admin mastery report shows action buttons for pending recommendations
- **Role-gated**: only `Admin`/`BCBA` can approve/dismiss (enforced at UI and server level; server checks `approverRole` param)
- **Goal mastery unchanged**: 80% × 5 sessions → auto-set to `'confirmed'` status
- **Mastery log new columns**: `status`, `approvedBy`, `approvalDate`, `settingsObserved`
- **BigQuery**: all 4 new fields synced in `mastery_log` table
- **Duplicate prevention**: no re-recommendation while status is `recommended`, `pendingGeneralization`, or `confirmed`
- **Recovery after dismiss**: if behavior meets threshold again after dismissal, a new recommendation row is created
- **Dedup fix**: mastery report keeps the most recent entry per behavior (last row wins), so recover-after-dismiss shows the new entry

---

## Security fixes applied

- XSS protection via `escHtml()` on all innerHTML injections (renderAdminList, renderMasteryReportResults, client buttons, behavior pills)
- TOTP QR code generated client-side via inline `_QR` module — no external API call (was leaking secrets to `api.qrserver.com`)
- PIN hashing: SHA-256 `hashPin(email, pin)` in GAS; `simpleHash('rtadmin:'+pin)` for admin PIN in localStorage; backward-compat migration on first successful login
- Offline login blocks TOTP users — requires network for 2FA verification
- `verifyLogin` strips `pin`/`totpSecret` from response object
- OAuth token cache reduced to 55 minutes (was 24 hours)
- `saveConfig` wrapped with `LockService.getScriptLock()` to prevent concurrent-write races
- Mastery approve/dismiss: role check at UI level (early return) AND server level; `approverRole` sends actual role, not hardcoded 'BCBA'
- onclick JS string embedding uses `esc()` (escapes `'` and `\`), not `escAttr()` (which only escapes HTML chars)

---

## Data pipeline (BigQuery)

- **BigQuerySync.gs** is a SEPARATE file in the same Apps Script project
- 14 tables synced hourly via time-based trigger
- Tables: `sessions`, `behavior_records` (normalized), `trial_records` (normalized), `abc_incidents`, `mastery_log`, `therapists`, `clients`, `authorizations`, `goals_reference`, `behaviors_reference`, `billing_codes`
- Looker Studio connected with 8 report queries
- `WRITE_TRUNCATE` with `NEWLINE_DELIMITED_JSON` format (free tier compatible)
- Data validation: `validateRowAlignment` safety net on every write
- Column alignment: colMap-based row building (never hardcoded positions)
- **Setup**: BigQuery advanced service must be enabled in Apps Script editor; `appsscript.json` needs `oauthScopes` for `bigquery`, `spreadsheets`, `script.scriptapp`, `script.external_request`

---

## Known issues resolved

- Column misalignment in Behavior Data / Trial Data tabs (colMap fix + structural repairs)
- Mastery log: first-entry dedup kept dismissed entry after recovery (fixed: last-row-wins dedup)
- Goal mastery entries incorrectly shown as 'recommended' (fixed: type-aware status defaulting)
- `g.name` blank goal name everywhere — `applyConfig` maps `g.description` → `name`; `buildTrials` uses `g.name`
- Submit Session not responding on mobile (Back→End navigation bug — `cancelEndTimeModal` was stopping timer)
- Session timer stopping on modal cancel (fixed: restart interval if not running)
- Supervision toggle resetting on Back→End navigation
- ABC behaviors showing all behaviors instead of client-assigned only — fixed `renderABCList` to use `S.client.behaviors`
- Hypothesized Function was single-select — now multi-select (`inc.fns[]` array)
- `masteryApprove`/`masteryDismiss` sent `approverRole:'BCBA'` for all non-admin roles (security fix)
- `verifyTOTPSetup` double fetch (wasted first call removed)
- ABC pill tap rebuilding DOM (confirmed not a bug — `setABCField` only updates CSS)
- `authAutoHourly` removed (referenced non-existent DOM IDs `auth-unitrate`/`auth-hourlyrate`)

### Bugs Resolved May 10, 2026
- **Mastery Report crash** "Cannot read properties of null (reading 'clientName')" — root cause: `getMasteryReport` two-pass refactor stored entries directly in `latestByKey` but build loop still accessed `latestByKey[key].entry` (stale pattern from old `{ rowIndex, entry }` shape) → every entry was `undefined`
- **Mastery Approve/Dismiss "Invalid argument: id"** — root cause: frontend was looking up `sheetId` via `CFG.CLIENTS.filter(c => c.id === ent.clientId)` which could fail on whitespace/case mismatch; fixed by returning `sheetId` in each `getMasteryReport` entry object and using `ent.sheetId` directly
- **Mastery duplicates (6 elopement entries)** — root cause: `getMasteryLogStatus` returned `''` when status column was missing but an entry existed, causing `checkBehaviorMastery` to call `writeMasteryLog` on every session submit; fixed by returning `'recommended'` instead, plus one-time backfill in `writeMasteryLog` when status column is newly created
- **getMasteryReport cross-month dedup** — inline dedup was date-filtered (only saw duplicates in same month); replaced with two-pass: PASS 1 scans all rows regardless of date to delete physical duplicates, PASS 2 applies date filter for display

---

## Deployment notes

- **Firebase deploy**: `firebase deploy --only hosting`
- Sometimes needs: `firebase login --reauth`
- `firebase.json` site must be `"rt-aba-tracker"` (not `"raising-together"`)
- Git credential: use Personal Access Token, not password
- **GAS deploy**: Deploy → New Deployment → Web App; Execute as Me; Anyone can access
- After Code.gs changes: always create a new deployment version (don't reuse old URL)

### Editor-facing functions MUST take no arguments
**The Apps Script Run dropdown cannot pass arguments.** A diagnostic or migration
that needs one is a function nobody can run — it throws
`Error: Pass an email address.` or similar the moment it is selected. This mistake
has shipped **three times**: the goalId migration steps, `auditClientGoalColumns`,
and `sendTestParentAlertTo`.

**Rule:** anything meant to be run from the editor gets a no-arg wrapper, and the
wrapper is the one named in instructions. Current wrappers:
`whyCantISendMail` · `checkParentAlertSender` · `sendTestParentAlertNow` ·
`auditAllClientGoalColumns` · `previewDuplicateGoalColumns` ·
`inspectDuplicateGoalColumns` · `traceUnassignedGoalRows` · `migrateGoalIdsNow` ·
`rollbackGoalsToLatestBackup` · `importVBMAPP` · `importVBMAPPBarriers` ·
`listInstruments` · `seedAssessmentBillingCode` · `backupGoalsTab` ·
`verifyGoalIds` · `previewGoalIdMigration`.
(`inspectInstrumentSource` is safe — its argument defaults to
`VBMAPP_SOURCE_SHEET_ID`.)

### A diagnostic must not infer a cause it cannot observe
`checkParentAlertSender` reported **"MISSING SCOPE script.send_mail"** whenever a
`MailApp` call failed. That call throws **identically** when the scope is absent
from the manifest and when it is present but **not yet consented to** — opposite
fixes. The wrong message cost three rounds of editing a manifest that was already
correct, plus a wrong theory about script ownership.

`ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL)` answers it properly:
`getAuthorizationStatus()` (`REQUIRED` vs `NOT_REQUIRED`),
`getAuthorizedScopes()` (what is actually granted), and `getAuthorizationUrl()`
(a link that **forces** the consent screen). Use `whyCantISendMail()`.

**Granular consent is a trap:** the authorize URL carries
`enable_granular_consent=true`, so Google shows a checkbox per permission and you
can click Allow while leaving one unticked. Tick everything.

### GAS Deployment (CRITICAL)
**GAS BEFORE FIREBASE whenever the frontend sends a new action or field.**
`doPost`'s catch-all is the session write, so an action an older paste does not
know used to fall through to `processSession`. It is now guarded on
`data.sheetId` and answers with an explicit "this deployment may be older than
the app" instead — but a new frontend against an old backend still means the
feature silently does nothing, which is why the order matters.

**Step 0 — `git push` FIRST.** Step 1 copies from GitHub Raw, which serves
`origin/main`, NOT the working tree. A commit that has not been pushed is
invisible to the paste, and the symptom is identical to a botched deploy: the
web app keeps answering with the old code. This has already cost one debugging
round. Firebase Hosting deploys from the working tree while GAS deploys from
GitHub — two sources of truth for one release, so push before pasting.

**Bump `APP_BUILD` (Code.gs) and `BQ_SYNC_BUILD` (BigQuerySync.gs) to the same
new value on every release**, before pasting. `doGet` reports both plus a
`buildsMatch` flag, so one unauthenticated GET proves which version is live
without touching patient data. An unchanged marker makes a real deploy
indistinguishable from a stale paste.

Then:
1. Copy from GitHub Raw → paste in script.google.com → Cmd+S
   (**both** `Code.gs` and `BigQuerySync.gs` if both changed — they are pasted
   separately, and a stale BigQuerySync is otherwise invisible)
2. Deploy → Manage deployments → edit (pencil icon) → Version: New version → Deploy

Without step 2, the web app continues running the old version. Choosing
"New deployment" instead of "New version" mints a NEW URL and leaves the old one
frozen — the app's `GAS_URL` constant would then need updating too.

Verify after deploying:
```
curl -sL '<GAS_URL>'   # expect {"build":"<APP_BUILD>", "buildsMatch":true}
```

**App version**: v5 (status string `RT ABA Tracker v5 - online`). URL (unchanged across redeploys): `https://script.google.com/macros/s/AKfycbz8AJ-6WIoNdBNh-z3iuT9BXNnw3r95gTqONo78wpTJDXQ9QPGaIp_fmR6gjZlB2yQf/exec`

---

## Version 4 (superseded — see Version 5 below)

### Client sheet auto-provisioning
- Admin console → Clients → **Auto-create Google Sheet** creates an app-owned
  spreadsheet, links its id into the Clients tab (colMap), shares with admins.
  Backend can `openById` it with no manual sharing (script account owns it).
- **Verify Sheet** button → `verifyClientSheet` reports reachability + tabs.
- Data tabs auto-generate on first session (no manual tab setup).

### Trial Summary — live writes + backfill
- `_appendTrialSummaryRows` (called from `writeTrialData`) writes the normalized
  Trial Summary tab on **every** session (previously batch-only via `recoverTrialData`).
- Editor helpers: `backfillMissingTrialSummaries()` / `previewMissingTrialSummaries()`
  build the tab only for sheets missing it (working sheets untouched);
  `checkTrialSummaryHealth()` is a read-only health report.
- `recoverTrialData(dryRun, onlyClientIds)` gained an optional client-scope filter.

### Pause / resume + offline resilience (session data model)
- **`Suspended Sessions` tab** (RT Admin) stores a paused/live session as one row
  with the full state in `stateJson` (lossless JSON). Keyed by `suspendId`.
  Transient — NOT synced to BigQuery.
- **Status values:** `paused` (explicitly parked; always resumable) vs `live`
  (continuous in-progress backup ~every 60s; surfaced for recovery on another
  device only when **stale >3 min**). `active` accepted for back-compat.
- **Billing:** active-time accounting (`activeElapsedMs`, `S.activeMsAccum`,
  `S.pausedMsTotal`). Duration excludes paused time when `S.everPaused`; a
  never-paused session is byte-identical to v3. `Time Out − Time In` > billed
  `Duration` by the paused time.
- **Idempotency:** stable per-session `S.submissionId` (set at `beginSession`,
  preserved through snapshot / re-auth / cross-device). `processSession` dedups
  via `_sessionAlreadyRecorded` (scans Time In Time Out `submissionId` column) →
  no duplicate rows on offline retry or cross-device completion. Backup record
  deleted **after** a successful write.
- **Offline (frontend, index.html):** `startAutoSave` (15s local crash backup +
  throttled `pushLiveBackup`), `enqueuePendingSubmit`/`flushSubmitQueue` (offline
  submit queue in `localStorage` key `rtPendingSubmits`), `onReconnect` on the
  `online` event and on login. Logout warns on unsynced pause or queued submit.
- **Snapshot:** `buildSessionSnapshot` / `applySessionSnapshot` (mirror the
  re-auth restore path). Local backup key `rtSessionBackup` (cleared on
  logout/complete — PHI hygiene; server is the durable cross-device store).
- **Router actions:** `saveSuspendedSession`, `listSuspendedSessions`,
  `deleteSuspendedSession`, `cleanupSuspendedSessions`.
- **TTL:** `cleanupStaleSuspendedSessions(maxAgeDays=14)` — run on a daily
  time-based trigger to sweep abandoned pauses/live records.

### Analyst side (read-only BigQuery)
- `analyst/` + `.mcp.json` + `.claude/skills/bq-analyst` — read-only BigQuery MCP
  for conversational analytics. Analyst/admin tool ONLY, not the end-user app.
- Requires a read-only service account (dev machine) OR Google's OAuth BigQuery
  MCP (recommended for non-technical BCBA use). BQ project `rt-aba-tracker`,
  dataset `aba_tracker`. Prefer de-identified views; needs a BAA for real PHI.

---

## Data Model Evolution Plan

### Current Architecture (Phase 1)
- Source of truth: Google Sheets (one per client)
- Analytics warehouse: BigQuery (11 tables, hourly sync via WRITE_TRUNCATE)
- Reporting: Looker Studio connected to BigQuery
- Limitation: Sheets have dynamic columns (behaviors/goals as columns), which causes alignment issues. BigQuery normalizes these into rows (`behavior_records`, `trial_records`).

### Short Term — New Modules (Phase 1 → Phase 2)
New BigQuery tables as modules are built:
- `assessments`: clientId, assessmentType, date, domain, subdomain, itemCode, score, scorerEmail
- `behavioral_plans`: clientId, planVersion, createdDate, status, targetBehaviors, goals
- `plan_goals`: planId, goalCode, objective, baseline, target, status
- `video_sessions`: sessionId, recordingDate, deviceId, duration, storageUrl, annotationStatus
- `video_annotations`: sessionId, timestamp, type, code, promptLevel, result, reviewerEmail
- `skeleton_frames`: sessionId, frameNumber, timestamp, keypointsJson, behaviorLabel

### Medium Term — a HYBRID, not "BigQuery as source of truth" (revised Oct 7, 2026)

The earlier plan here said *BigQuery as source of truth at 10+ clients, Sheets
become read-only mirrors*. **Both halves of that are wrong.**

**The threshold is wrong.** Sheets capacity is not the constraint — one
spreadsheet per client bounds row growth per *child*, not per practice. A client
at 5 sessions/week for 3 years is ~7,500 Trial Summary rows ≈ 135k cells against
a 10M-cell limit. Nothing strains at 7 clients and nothing would at 100.

**The target store is wrong for half the data.** BigQuery is an append-optimized
warehouse: no primary keys, no constraints, no cheap single-row `UPDATE`,
streaming-buffer latency before rows are updatable. Approving a mastery row,
adjusting a session end time, changing a PIN — all row-level mutations. Those do
not belong in a warehouse.

**The target:**
| Layer | Store | Contents |
|---|---|---|
| Immutable events | **BigQuery** (already is) | sessions, trials, behaviours, ABC, assessments, annotations, skeletons |
| Mutable operational | Sheets today → **Cloud SQL Postgres** | config, PINs, authorizations, approvals, corrections |

**Postgres, not Firestore, and not BigQuery** (decided Oct 8, 2026). Firestore was
the close call — its native streaming export to BigQuery would delete
`BigQuerySync.gs` outright, and its real-time listeners do properly what
`pushLiveBackup` + "stale >3 min" approximates by hand. Postgres wins on this
codebase's own failure history: every expensive incident recorded in this file is
an **integrity** failure (three column-misalignment repairs, 117 submission IDs
reconciled, duplicate mastery entries, 417 missing fields), and Postgres makes
those structurally impossible rather than carefully managed —
`UNIQUE(submission_id)`, `UNIQUE(client_id, goal_code)`, real `FOREIGN KEY`s, one
transaction across what are currently four separate tab writes, and
`trial_records(session_id, goal_id, trial_no, score)` which **ends the
dynamic-column problem rather than mitigating it**. Apps Script reaches Cloud SQL
today via `Jdbc.getConnection()`, so dual-write is incremental with no Cloud Run
rewrite on day one. ~$10–25/month.

**Tatiana does NOT edit the sheets — she reads them for analysis.** That removes
the expensive half of this migration: config is already edited through the app's
admin panel, so there is no inventory of hand-corrections needing replacement
screens. The analysis layer (f52/f53, both done) replaces her read use; that is a
**one-week** job and touches no write path. Moving the system of record is a
separate **4–6 week** job gated on the sync clock or Phase 2.

### Schema findings (Oct 8, 2026) — extracted from the code, not from memory

1. **The HIPAA audit log is NOT in BigQuery.** Eleven tables sync; `audit_log` is
   not one of them. It is the one dataset with a **statutory six-year retention
   requirement** and the sheet is its only copy. Fix before anything else here.
2. **Three M:N relationships are comma-separated strings** — `Therapists.clientIds`,
   `Behaviors.clientIds`, `Goals.clientIds` (and `Clients.parentEmail`). No join
   tables. Second core weakness after dynamic columns.
3. **`goalId` never reaches BigQuery.** f43b minted an immutable key and migrated
   243 rows, but `goals_reference` syncs `code, description, client_ids,
   num_trials, status` with no `goalId`, and `trial_records` joins on `goal_code`.
   A renamed code still breaks the analytics join f43b existed to protect — **f43b
   is half done.**
4. **`Goals` carries both `clientId` and `clientIds`** — two fields for one
   relationship, with nothing declaring which wins.
5. **The dynamic-column problem leaked into the warehouse**: `trial_records` has
   `trial_1`…`trial_10` as fixed fields. Normalisation is partial — one row per
   goal, but trials are still columns.

### Measured Oct 24 2026 — the sync was almost entirely waiting

`syncAllToBigQuery()` on the live project, immediately after f79:

```
Sync complete in 50s | 14 tables, 7 clients, ~18,500 rows
```

| | |
|---|---|
| Before (Oct 23, serial waits) | **1233s** |
| After (f79, overlapped loads) | **50s** |
| BigQuery load jobs | 1–3s each — never the bottleneck |
| Read + build phase | **~45s**, i.e. the whole remaining cost |
| Rows | sessions 389 · behavior_records 4,727 · trial_records 12,829 · abc 176 · mastery 70 · goals_reference 260 · behavior_definitions 20 · phase_changes 1 · definition_acks 2 |

**A 25× reduction, and essentially all of the old runtime was pathological
waiting rather than work.**

**Correction worth keeping, because it nearly cost two days.** On first reading
the health report I inferred a ~420s read phase from the 7-minute gap between
when the reference tables and the event tables were written, and concluded
incremental sync was now urgent *on evidence*. That was wrong. The gap was the
**serial sleeping itself** — a couple of 170s unconfirmed polls landing between
the two phases — not reading. The read phase was always ~45s. Two timestamps are
not a measurement when there is an unmeasured wait between them; the Audit Log's
own `Sync complete in Ns` was the real number all along, and it is the one to
trust.

**So incremental sync is NOT urgent.** At 50s we are at 28% of the 180s
threshold below, with 7 clients. Reading is O(clients × history), so ~180s lands
near 25 clients — which is exactly what the original prediction said, and f79
restored that headroom rather than changing the shape. Do not start the
~2-day incremental-sync job on the strength of the Oct 23 email.

**The five Oct 23 "timeouts" have no confirmed cause.** Load jobs run in 1–3s,
so slowness does not explain a 170s poll failure, and nothing in the job history
reproduces it. Recorded as transient and unexplained rather than given a story.
f79 makes it moot three ways: loads overlap the read phase so they have slack,
`Jobs.get` is wrapped so an API blip no longer aborts a wait, and an unconfirmed
load is reported as unconfirmed instead of as failure.

**A diagnostic must check before it accuses — again.** The first
`checkBigQuerySyncHealth()` printed "usually means no schema branch" for the
three missing tables. The real reason was that no sync had yet run with code that
knew they existed. It now reads the load-job history first and distinguishes
**never attempted** from **attempted and failed**. Third time this rule has been
learned here, after `checkParentAlertSender` and the no-arg rule.

**What actually breaks, in arrival order:**
1. **The hourly sync** — re-reads every tab of every client and `WRITE_TRUNCATE`s
   11 tables inside a 6-min cap. O(clients × history). First wall, ~25–35 clients.
   **It already logs its own duration**: `'Sync complete in ' + elapsed + 's'` in
   the Audit Log. That number is the leading indicator — plot it, act at ~180s.
   Fix is incremental sync (`dateISO` watermark + `WRITE_APPEND` for the four
   event tables, `WRITE_TRUNCATE` only for small reference tables). ~2 days.
2. **Unlocked session writes** — `processSession` takes **no** lock; only
   `writeTrialData` does. Concurrent submits for one client race
   `ensureSheetColumns`, which is the exact class behind every structural repair
   in this file's history. Small fix, worth doing regardless of scale.
3. **Dynamic columns** — goals and behaviours as *columns* is a pivot table
   pretending to be a schema. Already biting (3 repairs). **Policy going forward:
   new per-goal/per-behaviour data gets ONE JSON column**, as f30 did, never a
   column per key.
4. **Skeleton frames (Phase 3) — absolute, no workaround.** 30fps × 60min ≈
   **108,000 rows per session**. Sheets cannot hold two of them and `appendRow`
   cannot write them at all. Device → GCS → BigQuery, bypassing Apps Script.

**So the forcing function is the ROADMAP, not the client count.** Phase 2/3 data
volumes require the direct path regardless of how many children are served, which
is why the hybrid is the destination rather than a staging post.

**The expensive part is not the data — it is that Sheets is Tatiana's correction
UI.** She fixes data by opening a tab. Every hand-correction needs a replacement
admin screen before the mutable half can move. Budget Phase C as UI work.

**The one thing that forces everything early:** multi-practice federation (`l6`).
Tenant isolation and row-level security in Sheets is not viable at any scale.

### Long Term — LHBM Training Pipeline
- BigQuery = data lake for all behavioral data
- Mac Mini M4 reads from BigQuery for training (de-identified)
- Trained model writes predictions back to BigQuery
- Looker Studio and app read predictions
- Federated learning: other practices sync to shared Master LHBM via differential privacy

### Data Integrity Safeguards (current)
- `validateRowAlignment`: safety net on every write, logs misalignment to Audit Log
- colMap-based row building: never hardcoded column positions
- `_ensureColumnsBefore`: inserts new behavior columns before analytics section, respects each client's existing layout
- `LockService`: prevents concurrent config saves
- Double-submission guard: prevents duplicate session records
- Mastery duplicate prevention: no re-recommendation while status is recommended/pendingGeneralization/confirmed
- BigQuery reconciliation query: run periodically to verify data quality
- BigQuery sync email alerts: tatiana@raising2gether.org notified on sync errors

---

---

## Version 5 (current) — October 2026

Shipped this release: **f54** parent alerts · **f55/f55b** structured session notes ·
**f30a/b/c** prompt hierarchy, probe flag, timestamps, mastery-at-Independent ·
**f43b** immutable `goalId` · **f33** BigQuery client coverage · **f36** assessment
framework · **f57** clinical console · session discard · billing profile alias.

**Behavioural changes to warn the team about:**
- **No new goal mastery confirms for ~5 sessions per goal** (f30b) — historical
  sessions carry no prompt level, so the Independent streak starts from zero.
  Nothing already confirmed is revoked.
- **Session notes now require every section answered**, not just 150 words total
  (f55b). Anyone who wrote a long overview and skipped the rest will be stopped.

Full detail and the decision history: `docs/architecture/assessments_plans_design.md`.

### Parent behavior alerts (f54)
- Fires in `processSession` AFTER the data is written, wrapped in try/catch — a
  mail or config failure must never cost a therapist their session.
- **Disclosure controls (do not relax without a consent/BAA review):** consent
  gate; minimal content tier; audit entry per send naming the recipient;
  idempotent via `alertId = submissionId + behaviorKey`.
- One email per session covering all auto behaviors, but **one message per
  recipient** so addresses are never shared between parents.
- Admin UI: **Alerts** tab (4th in the tab bar — it was 10th of 12 and scrolled
  off-screen on a phone). Recipients + consent are editable there **because
  `'clients'` is in `bcbaBlocked`**, which otherwise locks a BCBA out of the one
  field that decides whether anything can be sent.
- **Known limitation:** the role is caller-supplied, as with mastery
  approve/dismiss. Real enforcement needs device-token auth (**f26a**), which
  should land before auto-send is used widely.
- **Sending address:** `PARENT_ALERT_FROM = 'tatiana@raising2gether.org'`, always
  set as `Reply-To`. Whether it is also the **From** depends on who owns the
  deployment — see `docs/appsscript-scopes.md`. The audit entry records the
  address actually used, never the configured one.
- **`appsscript.json` IS NOT IN THIS REPO.** It had no mail scope, so f54 could
  never send: every `MailApp` call threw, the wrapper caught it, and the row was
  written `failed`. Add `script.send_mail` + `userinfo.email` to the EXISTING
  array and re-authorize. `https://mail.google.com/` is deliberately NOT added —
  it grants full mailbox read access for a cosmetic From line.
  `checkParentAlertSender()` / `sendTestParentAlertTo(email)` verify it.
- **WORKING as of Oct 11, 2026.** First alert email ever delivered. The blocker was
  consent, not the manifest and not the code: the manifest save had succeeded and
  only authorization was missing. Scope set is now 5 — the original four plus
  `script.send_mail`. `userinfo.email` was deliberately not added, so
  `_parentAlertFrom()` cannot read the deployment owner and the audit entry records
  `from=?`; the From line is whatever the deployment owner is, and a received test
  email shows it directly without needing the scope.
- **Prerequisite still open:** confirm the Workspace BAA covers Gmail before
  auto-send is used widely.

### Prompt hierarchy (f30a) + probe flag (f30c)
- One level per goal per session, recording the **programmed** level — that makes
  "one level per goal" true by definition rather than an approximation.
- Rejected v1 design was a level on every trial: ~40 seven-way decisions per
  session. The realistic failure there is RBTs backfilling from memory, giving a
  column that looks rich and is fabricated.
- Order lives in one array and the **code** is stored, so the hierarchy can be
  reordered or extended with no migration. This is also the label space for
  video annotation (**v4**) and the prompted-vs-independent skeleton classifier
  (**s3**), so the vocabulary must stay consistent across all three.
- **Probes are an RBT convention made structural:** there is no probe session
  type; the checkbox implies Independent. Probe sessions therefore count toward
  mastery. Whether mastery should *require* probes is an open clinical ruling.
- **Admin manual entry sends no prompt level**, so backdated sessions read as
  "not run" and are skipped from mastery streaks.

### Goal mastery change (f30b) — expect a visible pause
80% × 5 consecutive sessions **the goal was run in**, at Independent. Because no
historical session carries a level, **no new goal mastery confirms until five
Independent sessions accumulate per goal.** Nothing already confirmed is
revoked. Tell the BCBA before she notices, or it reads as mastery being broken.

### Discard a trial session
Three stores remember an in-progress session and clearing fewer than all three
brings it back: the `Suspended Sessions` row, `rtSessionBackup`, and
**`rtPendingSubmits`** — the last being the one that would auto-submit a test
session on reconnect. Logout deliberately does **not** discard: logging out on
one device and resuming on another is a supported flow.

### Service worker
`sw.js` is **network-first**, so online clients pick up new code without a cache
bump; the stale window is only a device that stayed offline across a release.
Bump `CACHE` anyway on each deploy (currently `rt-aba-v6`).

## Clinical console (`/clinical`, f57)

A **second page, not a second system**: own HTML file, same GAS backend, same
Google OAuth (shares the `googleAuthCache` key, so a token from either page works
in the other), same RT Admin config, design tokens copied from `index.html`.

- Role-gated to **admin or bcba** using the same admins-then-therapists precedence
  as the tracker.
- `REDIRECT_PATH = '/clinical/'` is pinned so only **one** authorized redirect URI
  needs registering on the OAuth client. Without it: `redirect_uri_mismatch`.
- **Admin config editing is NOT duplicated here** — it links out to the app's admin
  panel. `objectsToSheet` rewrites a config tab from a fixed header list, so two
  editors of one tab means one silently erasing the other's fields.
- See `clinical/README.md`.

## Assessment framework (f36)

`Instruments` / `Assessments` / `Assessment Items`, and the split is the point:

- **Draft scores live as `scoresJson` on the header row** — one cell write per
  autosave. A 500-item assessment cannot write 500 rows per keystroke.
- **Normalized item rows are written once, at completion**, and are the analysis
  record. Drafts are not analysis-ready anyway.
- `saveAssessmentDraft` **refuses** to touch a complete/signed administration: a
  re-assessment is a new record, never an edit.
- `completeAssessment` computes `belowCriterion` per item — the gap list that feeds
  plan creation.
- `seedRTCoreProbe()` seeds a 12-item practice-authored instrument for testing with
  zero licensing exposure.
- **Licensing:** store item **codes and scores**; publisher item text may go into her
  RT Admin sheet but **never the repo or a shipped config**.

## Behaviour definitions + acknowledgement (f74b / f78)

Four fields per **client per behaviour**: `topography`, `onsetOffset`,
`examples`, `nonExamples`. The grain is the point — one shared definition would
apply one child's topography to every other child assigned to that behaviour,
which is the exact misidentification the feature exists to prevent.

**The version identity is a CONTENT HASH, not `updatedAt`.** The Definitions tab
rewrites every row for a client on each save, so `updatedAt` moves on untouched
rows; keying acknowledgement off it would ask everyone to re-read eight
definitions because one was edited, and an acknowledgement control that fires
on unchanged text becomes a tap-through reflex. `saveBehaviorDefinitions` now
also **preserves `updatedAt` when the four fields are unchanged**, so the
timestamp means what it says.

**`_defHash` (Code.gs) and `_defHashFor` (index.html) must stay identical.**
Two implementations is a drift risk accepted for one reason: the server needs
the hash to stamp `def_hash` into `behavior_definitions`, without which "who has
not read the current version" is unanswerable in Looker. Verify with the
equivalence check in `tools/` rather than by eye.

**The gate fails open and is escapable.** Both are deliberate:
- *Fails open* — `unacknowledgedDefinitions()` returns nothing until the ack
  fetch has answered. Blocking a session on a network call is far the worse
  failure, and an un-timed fetch gating a UI path is exactly the bug in
  `renderResumeCards()` that cost a real session's data.
- *Escapable* — "Start anyway" records a `skipped` row. A hard wall would be
  defeated the first time a child escalated mid-read, and its realistic result
  is tapping through unread. A logged skip is a better instrument than a lock
  the BCBA cannot see past.

## Phase lines (f77)

Dated markers for what changed in the child's world — her examples: summer
recess, a new school, a change of teacher. Standard single-subject-design
annotation; a trend is only interpretable against what else changed.

**Capture ships before any chart reads it, on purpose.** This data has a short
memory window: nobody reconstructs in October that the teacher changed in March,
and every chart crossing that date is then quietly misleading with no way to
tell. Looker draws reference lines straight off the table with no app work.

She **declined definition versioning** and asked for this instead. A phase line
answers "what changed that might explain this trend", which is the weekly
question; versioning answers "what did the definition say when this was
recorded". `Definition revised` is one of the categories, so a definition change
can be marked as the phase-line event it effectively is.

## PHI classification of the newer tables

| Table | De-identified views | Why |
|-------|--------------------|-----|
| `behavior_definitions` | **excluded** | Free clinical text about a named child |
| `phase_changes` | **excluded** | `label`/`description` carry family, medical and third-party detail. Date + category alone would be safe; the prose is not |
| `definition_acks` | included | Ids, a behaviour key, an opaque version hash, a timestamp. No prose — `def_hash` identifies a version without revealing a word of it |

## Billing key hazard

```js
CFG.BILLING_MATRIX[`${b.profile}|${b.sessionType}`] = b.code
```

`profile` is **half the billing key**. A new profile value with no Billing rows
means sessions submit with **no billing code**, breaking the weekly billing report
and authorization consumed-hours. Use `billingCodeFor(profile, sessionType)` —
exact key then `BILLING_PROFILE_ALIAS`. `RBT - Student Analyst` aliases to `RBT`.

**Open:** assessment sessions bill under **97151/97152**, which the matrix does not
contain — so an assessment session cannot currently be billed (blocks f58).

## Roadmap reference

- Feature tracker: `rt_feature_tracker.jsx` in repo root
- **Phase 1.5**: LHBM First Signal — fine-tune LLM on ABA data, local on Mac Mini M4
- **Phase 2**: Video Annotation & Recording
- **Phase 3**: Skeleton Extraction & VANT Foundation
- **Phase 4**: Multimodal LHBM & Products
