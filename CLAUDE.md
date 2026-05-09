# CLAUDE.md — Raising Together ABA Tracker

## Project overview
Mobile-first PWA for ABA therapy data collection with HIPAA compliance layer.
Single-file frontend (`index.html` — all JS/CSS inline) backed by Google Apps Script (`Code.gs`).
Deployed on Firebase Hosting at `rt-aba-tracker`.

## File map
| File | Purpose |
|------|---------|
| `index.html` | Complete frontend (all JS/CSS inline, ~5500 lines) |
| `Code.gs` | Google Apps Script backend (ES5 strict, ~2200 lines) |
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

### Per-client sheet tabs — analytics columns appended after core columns
`Time In Time Out`: Date, Billing Code, Session Type, Time In, Time Out, Duration (min), Therapist, Submission ID, Notes, submissionId, clientName, clientId, therapistEmail, sessionType, billingCode, isDraft, payloadHash, submittedAt, dateISO

`Behavior Data`: Date, Therapist, Setting, \<behavior labels\>, Tantrum Frequency, Tantrum Total (min), submissionId, clientName, clientId, therapistEmail, sessionType, billingCode, isDraft, payloadHash, submittedAt, dateISO

`Trial Data`: Date, Therapist, \<goal code columns\>, Percent Correct (JSON), submissionId, ...analytics

`Mastery Log`: type, code, description, masteryDate, lastScores, therapistName, therapistEmail, clientName, clientId, dateISO

### Column alignment pattern
All sheet writes use `ensureSheetColumns` + colMap-based row building. **Never hardcode column positions.** Read the actual header row, build `{header: colIndex}` map, write by key. `sheetToObjects` returns raw cell values (not String-cast).

### Key GAS functions
| Function | Purpose |
|----------|---------|
| `doPost(e)` | Router — dispatches on `data.action` |
| `verifyLogin(email, pin, totp)` | Tier 2 auth; never returns pin/totpSecret |
| `hashPin(email, pin)` | SHA-256 of `email:pin` → 64-char hex |
| `migratePins()` | One-time: hash all plaintext PINs in Therapists sheet |
| `saveConfig(cfg)` | LockService-protected; hashes new PINs; checks duplicate goal codes |
| `getWeeklyHours` / `getBiweeklyHours` | Prefer `dateISO` column; fallback to `date` |
| `checkBehaviorMastery` | Derives behavior column range from headers (not hardcoded startCol=3) |
| `writeMasteryLog` | colMap-based row write |
| `checkGoalUsage` | Reads header row first; only scans full data when goal column found |
| `getMasteryStatus` | Goal mastery: 80%+ for 5 consecutive; Behavior: ≤1 for 8 consecutive |
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
- Behavior mastery detection (≤1 × 8 consecutive sessions, green checkmark)
- Monthly mastery report (admin panel, CSV export)
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

---

## Security fixes applied

- XSS protection via `escHtml()` on all innerHTML injections (renderAdminList, renderMasteryReportResults, client buttons, behavior pills)
- TOTP QR code generated client-side via inline `_QR` module — no external API call (was leaking secrets to `api.qrserver.com`)
- PIN hashing: SHA-256 `hashPin(email, pin)` in GAS; `simpleHash('rtadmin:'+pin)` for admin PIN in localStorage; backward-compat migration on first successful login
- Offline login blocks TOTP users — requires network for 2FA verification
- `verifyLogin` strips `pin`/`totpSecret` from response object
- OAuth token cache reduced to 55 minutes (was 24 hours)
- `saveConfig` wrapped with `LockService.getScriptLock()` to prevent concurrent-write races

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

- Column misalignment in Behavior Data / Trial Data tabs (colMap fix + `fixShiftedAnalytics` migration)
- Mastery log duplicate entries (`cleanDuplicateMasteries` action + `isMasteryLogged` guard)
- `g.name` blank goal name everywhere — goals use `g.description` not `g.name`
- Submit Session not responding on mobile (Back→End navigation bug — `cancelEndTimeModal` was stopping timer)
- Session timer stopping on modal cancel (fixed: restart interval if not running)
- Supervision toggle resetting on Back→End navigation
- `verifyTOTPSetup` double fetch (wasted first call removed)
- ABC pill tap rebuilding DOM (confirmed not a bug — `setABCField` only updates CSS)
- `authAutoHourly` removed (referenced non-existent DOM IDs `auth-unitrate`/`auth-hourlyrate`)

---

## Deployment notes

- **Firebase deploy**: `firebase deploy --only hosting`
- Sometimes needs: `firebase login --reauth`
- `firebase.json` site must be `"rt-aba-tracker"` (not `"raising-together"`)
- Git credential: use Personal Access Token, not password
- **GAS deploy**: Deploy → New Deployment → Web App; Execute as Me; Anyone can access
- After Code.gs changes: always create a new deployment version (don't reuse old URL)

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
- `LockService`: prevents concurrent config saves
- Double-submission guard: prevents duplicate session records
- BigQuery reconciliation query: run periodically to verify data quality

---

## Roadmap reference

- Feature tracker: `rt_feature_tracker.jsx` in repo root
- **Phase 1.5**: LHBM First Signal — fine-tune LLM on ABA data, local on Mac Mini M4
- **Phase 2**: Video Annotation & Recording
- **Phase 3**: Skeleton Extraction & VANT Foundation
- **Phase 4**: Multimodal LHBM & Products
