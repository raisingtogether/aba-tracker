# Raising Together ABA Tracker v4

Mobile-first PWA for ABA therapy data collection with HIPAA compliance layer.

## What's new in v4

- **Pause & resume sessions** — a therapist can pause an in-progress session for
  any interruption (travel, patient break, bathroom, connectivity loss) and
  resume later on **any device**. Paused time is **excluded from billable
  duration** (active-time accounting); never-paused sessions are unchanged.
- **Offline-safe capture** — continuous device auto-save (crash recovery), an
  **offline submit queue** that auto-sends on reconnect, and a **live
  cross-device backup** so a lost/dead device is recoverable. All submissions are
  **idempotent** via a stable per-session `submissionId` (no duplicate rows).
- **Client sheet auto-provisioning** — create + link a client's Google Sheet
  from the admin console (owned by the app account; no manual sharing), plus a
  **Verify Sheet** check.
- **Live Trial Summary writes** — the normalized Trial Summary tab is now written
  on every session (previously batch-only), with a scoped backfill helper for
  sheets that predate it.
- **Read-only BigQuery analyst scaffold** — optional MCP + skills for
  conversational analytics (see `analyst/README.md`). Analyst/admin tool only —
  not part of the end-user app.

See [CHANGELOG / feature detail](#v4-feature-detail) below and `CLAUDE.md` for
the full data-model notes.

## Files
| File | Purpose |
|------|---------|
| `index.html` | Complete frontend (all JS/CSS inline) |
| `manifest.json` | PWA manifest for Add to Home Screen |
| `sw.js` | Service worker (offline support) |
| `Code.gs` | Google Apps Script backend |
| `BigQuerySync.gs` | BigQuery analytics sync (same Apps Script project, hourly trigger) |
| `firebase.json` | Firebase Hosting config (site `rt-aba-tracker`) |
| `rt_feature_tracker.jsx` | Roadmap / feature tracker component (served at `/tracker`) |

Deployed on **Firebase Hosting** (`https://rt-aba-tracker.web.app`). Deploy the frontend with `firebase deploy --only hosting`.

---

## Setup Steps

### 1. Create Google Sheets

**RT Admin Sheet** (config + data)
1. Create a new Google Sheet called **RT Admin**
2. Leave it blank — the app populates tabs automatically
3. Copy the Sheet ID from the URL

**RT Audit Log Sheet** (HIPAA audit trail — separate from admin data)
1. Create a second Google Sheet called **RT Audit Log**
2. Leave it blank — the app creates the "Audit Log" tab automatically
3. Copy the Sheet ID

**Per-client sheets** (one spreadsheet per client) are **not created by hand** — see
[Adding a New Client](#adding-a-new-client) below. The admin console can auto-create
and link them, and the data tabs populate on the first submitted session.

### 2. Deploy Google Apps Script
1. Go to [script.google.com](https://script.google.com) → **New Project**
2. Paste contents of `Code.gs`
3. Set the two constants at the top:
   ```javascript
   var ADMIN_SHEET_ID = 'your-rt-admin-sheet-id';
   var AUDIT_SHEET_ID = 'your-rt-audit-log-sheet-id';
   ```
4. **Deploy → New Deployment → Web App**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the Web App URL

> **Updating `Code.gs` later:** paste the new code and Save (Cmd+S), then
> **Deploy → Manage deployments → edit → Version: New version → Deploy**. Without the
> new version, the web app keeps running the old code. (Editor-run functions like
> `backfillMissingTrialSummaries` use the saved code and don't need a redeploy.)

### 3. Configure `index.html`
Find these constants near the top of the `<script>` tag:

```js
const GAS_URL          = 'YOUR_GOOGLE_APPS_SCRIPT_URL_HERE';
const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID_HERE';  // for Tier 1 auth
const ADMIN_PIN_DEFAULT = '1234';  // legacy fallback
```

---

## Two-Tier Authentication

### Tier 1 — Admin / BCBA (Google Sign-In)
- Uses Google Identity Services OAuth
- Email must be in the **Admins** tab of the admin panel
- Full access: admin panel, payroll, audit log, all clients

**Google Cloud Console setup:**
1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create or select a project
3. APIs & Services → Credentials → Create Credentials → **OAuth 2.0 Client ID**
4. Application type: **Web application**
5. Authorized JavaScript origins: add your hosted URL (e.g. `https://rt-aba-tracker.web.app`)
6. Copy the **Client ID** → paste into `GOOGLE_CLIENT_ID` in `index.html`
7. Add authorized Tier 1 emails in Admin panel → **Admins** tab

Tatiana (`tatiana@raisingtogether.com`) is pre-configured as the initial admin in `DEFAULT_CONFIG`.

### Tier 2 — RBT / Data Collection (Email + PIN + TOTP)
- Email + 6-digit PIN (set by admin in Therapists tab)
- Optional TOTP 2FA (Google Authenticator compatible)
- Restricted access: data collection only — no admin panel, no payroll, no audit log

**TOTP / Google Authenticator setup:**
1. Admin panel → **Therapists** → Edit a therapist → click **Generate** (creates a random TOTP secret)
2. Click **Show QR** → therapist scans with Google Authenticator or Authy
3. Therapist enters the 6-digit test code to verify setup
4. Click **Verify & Save** — secret is saved to the Therapists sheet

---

## Security Features

| Feature | Details |
|---------|---------|
| Auto-logout | 30-minute inactivity timeout; 27-minute warning |
| Failed login lockout | 5 failed attempts → 30-minute account lock |
| PHI clear on logout | All session data, CFG, and non-essential localStorage cleared |
| Background re-auth | App in background >5 min while session active → PIN prompt on return |
| Privacy notice | Shown on first login; user must accept before proceeding |

---

## Audit Log

Every significant action writes to the **RT Audit Log** Google Sheet:

| Column | Description |
|--------|-------------|
| Timestamp | ISO 8601 UTC |
| User | Email or name |
| Action | `login`, `logout`, `session_submit`, `failed_login`, `account_locked`, `admin_config_change`, `reauth_success` |
| Client | Client name (if applicable) |
| Details | Free-text context |

Actions are also buffered in `localStorage` (last 1000 entries).

**Export:** Admin panel → Settings → **Export Audit Log (CSV)**

---

## Role-Based Access Control

| Feature | Tier 1 (Admin) | Tier 2 (RBT) |
|---------|:--------------:|:------------:|
| Admin panel | ✓ | ✗ |
| All clients | ✓ | Assigned only |
| Payroll tab | ✓ | ✗ |
| Audit log export | ✓ | ✗ |
| Data collection | ✓ | ✓ |
| Weekly hour limit | Exempt | ✓ (default 30h) |

**Assign clients to therapists:** Admin panel → Therapists → Edit → Assigned Clients checkboxes

---

## RBT Weekly Hour Limit

- Default: **30 hours/week** (Mon–Sun)
- Configurable per therapist in Admin panel → Therapists → Edit → Weekly Hour Limit
- Hours are read from the **Time In Time Out** tab across all client sheets
- **Warning:** shown when ≤2 hours remain
- **Block:** session cannot start when limit is reached; message says "Contact your administrator"

---

## Authorization Tracking

Admin panel → **Auth** tab. All fields optional except Client and Payer Type.

**Per billing code tracking:** Each code (e.g. 97153, 97155) has its own separate pool of authorized hours. Consuming 97153 hours does not reduce the 97155 balance.

Dashboard shows (when data is available):
- Per-code progress bar: green (<75%), yellow (75–90%), red (>90%)
- Hours used / remaining / authorized per code
- Total summary across all codes
- ⚠️ Alert when <10% remaining on any code
- ⏰ Alert when authorization expires within 45 days

Payer types: **Insurance**, **Step Up**, **Private Pay**

---

## Biweekly Payroll (Admin Only)

Admin panel → **Payroll** tab (Tier 1 only).

- Select pay period: 1st–15th or 16th–end of current and previous month
- Shows each therapist's hours, hourly rate, and calculated pay
- Breakdown by client
- **Export CSV** button
- Set hourly rate: Admin panel → Therapists → Edit → Hourly Pay Rate

---

## Goals: Multi-Client Assignment

Goals can now be assigned to multiple clients simultaneously (same as behaviors). In Admin panel → Goals → Edit, select one or more clients using checkboxes. A goal like `G11` can be active for Camila AND Dylan at the same time.

---

## Adding a New Client

Admin panel → **Clients** → **Add** (or **Edit** an existing client). Each client's
therapy data lives in its own Google Spreadsheet, linked by **Sheet ID**.

**Auto-create (recommended):** Save the client, reopen it, then click
**➕ Auto-create Google Sheet**. The backend creates a new spreadsheet, links its ID
to the client, and shares it with active admins. Because the sheet is owned by the
Apps Script account, `processSession` and the BigQuery sync can read it with **no
manual sharing step**.

**Verify:** For a client that already has a Sheet ID, click **✓ Verify Sheet** to
confirm the backend can open it and see which data tabs exist yet (none until the
first session — that's normal).

**Manual:** You can still paste an existing Sheet ID into the **Google Sheet ID**
field. If you do, share that spreadsheet (Editor) with the Apps Script account.

The per-client data tabs (Time In Time Out, Behavior Data, Trial Data, Trial Summary,
ABC Data, Mastery Log) are generated automatically with correct headers on the first
submitted session. For historical trial data added before the Trial Summary feature,
run `backfillMissingTrialSummaries()` from the Apps Script editor — it builds the
Trial Summary tab only for sheets that lack one, so working sheets are never touched.

---

## Google Sheets Architecture

### RT Admin Sheet (shared config)
| Tab | Columns |
|-----|---------|
| Therapists | id, name, initials, color, profile, email, pin, totpSecret, clientIds, weeklyHourLimit, payRate, status, role |
| Clients | id, name, initials, sheetId, status |
| Behaviors | key, label, icon, color, clientIds, status |
| Goals | clientId, clientIds, code, description, numTrials, status |
| Billing | profile, sessionType, code |
| Authorizations | clientId, payerType, insuranceCompany, authorizationNumber, billingCode, authorizedHours, startDate, endDate, coInsurance, stepUpProgram, status, unitRate, hourlyRate |
| Admins | email, name, status |
| Suspended Sessions | suspendId, therapistEmail, clientId, clientName, sheetId, dateISO, updatedAt, status, stateJson *(v4 — pause/resume; transient, not synced to BigQuery)* |

### RT Audit Log Sheet (separate — HIPAA audit trail)
| Tab | Columns |
|-----|---------|
| Audit Log | Timestamp, User, Action, Client, Details |

### Per-Client Sheets (one per client)
Created automatically — see [Adding a New Client](#adding-a-new-client). Tabs are
generated with correct headers on the first submitted session.

| Tab | Purpose |
|-----|---------|
| Time In Time Out | Date, Billing Code, Session Type, Times, Duration, Therapist, Submission ID, Notes |
| Behavior Data | Dynamic columns per behavior |
| Trial Data | Dynamic columns per goal |
| Trial Summary | Normalized one-row-per-goal analytics view (used by reports/BigQuery) |
| ABC Data | Incident records |
| Mastery Log | Goal/behavior mastery entries + BCBA approval status |

Analytics columns (`submissionId`, `clientId`, `dateISO`, etc.) are appended after the
core columns on every tab. Column writes are colMap-based — positions are never hardcoded.

### BigQuery Analytics (optional)
`BigQuerySync.gs` (same Apps Script project) syncs all client sheets into BigQuery
hourly for Looker Studio reporting. New clients are picked up automatically once they
are active and have a Sheet ID.

---

## Session Data Integrity

Each submitted session includes:
- **Submission ID:** UUID v4 for traceability
- **Payload Hash:** Simple checksum of core fields (therapist, client, date, times)
- **Submitted By:** Email of the logged-in user

---

## Demo Mode

If `GAS_URL` is left as `YOUR_GOOGLE_APPS_SCRIPT_URL_HERE`:
- Uses built-in default config
- Login accepts any credentials matching local config (no server verification)
- Session data logged to console instead of Google Sheets
- Audit log stored in localStorage only

---

## v4 feature detail

### Pause & resume (cross-device, offline-safe)
- **Pause** button on the session screen (with optional reason: Travel / Patient
  break / Bathroom / Connectivity / Other). Saves a lossless JSON snapshot to the
  server (`Suspended Sessions` tab) **and** to `localStorage`.
- **Resume** cards appear on the client screen (from server + local); tapping one
  fully rehydrates the session and continues the clock.
- **Billing:** duration = active therapy time only. `Time Out − Time In` will be
  larger than the billed `Duration` by the total paused time — expected.
- **Partial data is never written to the real data tabs** — only the completed
  session is, on final submit. No orphan/half rows.

### Offline resilience
- **Crash-safe auto-save** to `localStorage` every 15s during an active session.
- **Offline submit queue (A):** if Submit fails on network, the completed session
  is queued and auto-sent on the browser `online` event and on next login.
- **Live cross-device backup (B):** while online, the in-progress session mirrors
  to the server (`status='live'`, ~every 60s). Resume cards surface a `live`
  record only when **stale (>3 min)** — i.e. the working device likely died — so
  an actively-used device is never duplicated elsewhere.
- **Idempotency:** a stable per-session `submissionId` (generated at session
  start; preserved across pause/resume/re-auth and across devices) lets the
  backend dedup retries and cross-device completion — **no duplicate rows**.
- Logout warns if an unsynced pause or a queued submit would be lost.

### Backend actions (Code.gs, ES5)
| Action | Purpose |
|--------|---------|
| `provisionClient` | Create + link a client's data spreadsheet (app-owned) |
| `verifyClientSheet` | Confirm the backend can open a client's sheet + list tabs |
| `saveSuspendedSession` | Upsert a paused/live session (LockService, colMap) |
| `listSuspendedSessions` | This therapist's resumable sessions (paused always; live if stale) |
| `deleteSuspendedSession` | Remove a backup record |
| `cleanupSuspendedSessions` | TTL sweep of abandoned records (>14 days) |

- `processSession` dedups by `submissionId` (`_sessionAlreadyRecorded` on the
  Time In Time Out tab) and deletes the backup record after a successful write.
- `cleanupStaleSuspendedSessions` should run on a **daily time-based trigger**
  (Apps Script → Triggers) to sweep abandoned pauses/live records.

### Editor-run maintenance helpers
- `backfillMissingTrialSummaries()` / `previewMissingTrialSummaries()` — build the
  Trial Summary tab only for sheets missing it (working sheets untouched).
- `checkTrialSummaryHealth()` — read-only report of Trial Summary tab health.

### Analyst side (optional)
See `analyst/README.md` — a read-only BigQuery MCP + `bq-analyst` skill for
conversational analytics. Not part of the end-user app; requires a read-only
service account (developer machine) or Google's OAuth-based BigQuery MCP
(recommended for non-technical BCBA use).
