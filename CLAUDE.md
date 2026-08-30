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
| `rt_feature_tracker.jsx` | Roadmap / feature tracker component |

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
| Clients | id, name, initials, sheetId, status |
| Behaviors | key, label, icon, color, clientIds, status |
| Goals | clientId, clientIds, code, description, numTrials, status |
| Billing | profile, sessionType, code |
| Authorizations | clientId, payerType, insuranceCompany, authorizationNumber, billingCode, authorizedHours, startDate, endDate, coInsurance, stepUpProgram, status, unitRate, hourlyRate |
| Admins | email, name, status |
| Suspended Sessions | suspendId, therapistEmail, clientId, clientName, sheetId, dateISO, updatedAt, status, stateJson **(v4 pause/resume; transient — NOT synced to BigQuery)** |

### Per-client sheet tabs — analytics columns appended after core columns
`Time In Time Out`: Date, Billing Code, Session Type, Time In, Time Out, Duration (min), Therapist, Submission ID, Notes, submissionId, clientName, clientId, therapistEmail, sessionType, billingCode, isDraft, payloadHash, submittedAt, dateISO

`Behavior Data`: Date, Therapist, Setting, \<behavior labels\>, Tantrum Frequency, Tantrum Total (min), submissionId, clientName, clientId, therapistEmail, sessionType, billingCode, isDraft, payloadHash, submittedAt, dateISO

`Trial Data`: Date, Therapist, \<goal code columns\>, Percent Correct (JSON), submissionId, ...analytics

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
| `processSession` | Writes all 4 tabs + audit log |

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
- 11 tables synced hourly via time-based trigger
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

### GAS Deployment (CRITICAL)
Code.gs changes require TWO steps to take effect:
1. Copy from GitHub Raw → paste in script.google.com → Cmd+S
2. Deploy → Manage deployments → edit (pencil icon) → Version: New version → Deploy

Without step 2, the web app continues running the old version.
**App version**: v4 (status string `RT ABA Tracker v4 - online`). URL (unchanged across redeploys): `https://script.google.com/macros/s/AKfycbz8AJ-6WIoNdBNh-z3iuT9BXNnw3r95gTqONo78wpTJDXQ9QPGaIp_fmR6gjZlB2yQf/exec`

---

## Version 4 (current)

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

### Medium Term — BigQuery as Source of Truth (10+ clients)
When Sheets latency becomes noticeable:
- App writes directly to BigQuery via Apps Script (`BigQuery.Jobs.insert`)
- Sheets become read-only mirrors (or eliminated)
- Eliminates column alignment problems permanently
- Schema versioning via BigQuery table metadata

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

## Roadmap reference

- Feature tracker: `rt_feature_tracker.jsx` in repo root
- **Phase 1.5**: LHBM First Signal — fine-tune LLM on ABA data, local on Mac Mini M4
- **Phase 2**: Video Annotation & Recording
- **Phase 3**: Skeleton Extraction & VANT Foundation
- **Phase 4**: Multimodal LHBM & Products
