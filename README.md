# Raising Together ABA Tracker v2

Mobile-first PWA for ABA therapy data collection. Config-driven — manage clients, therapists, behaviors, and goals from the in-app admin panel without touching code.

## Files
| File | Purpose |
|------|---------|
| `index.html` | Complete frontend (all JS/CSS inline) |
| `manifest.json` | PWA manifest for Add to Home Screen |
| `sw.js` | Service worker (offline support) |
| `Code.gs` | Google Apps Script backend |
| `icon-192.png` / `icon-512.png` | App icons (add your own) |

---

## Setup Steps

### 1. Add app icons
Create `icon-192.png` (192×192) and `icon-512.png` (512×512) with the Raising Together logo.
Free option: use [realfavicongenerator.net](https://realfavicongenerator.net).

### 2. Create the RT Admin Google Sheet
1. Go to [sheets.google.com](https://sheets.google.com) → create a new sheet called **RT Admin**
2. Leave it blank — the app creates tabs automatically on first save
3. Copy the Sheet ID from the URL (the long string between `/d/` and `/edit`)

### 3. Deploy the Google Apps Script
1. Go to [script.google.com](https://script.google.com) → **New Project**
2. Paste the contents of `Code.gs`
3. Set `ADMIN_SHEET_ID` at the top to your RT Admin Sheet ID
4. Click **Deploy → New Deployment**
   - Type: **Web App**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Click **Deploy** → copy the Web App URL

### 4. Configure `index.html`
Open `index.html` and find these two constants near the top of the `<script>` tag:

```js
const GAS_URL   = 'YOUR_GOOGLE_APPS_SCRIPT_URL_HERE';
const ADMIN_PIN = '1234';   // change to your preferred PIN
```

Replace `GAS_URL` with the Web App URL from step 3.
Optionally change `ADMIN_PIN` to a different 4-digit PIN.

### 5. Host the frontend
**Option A — GitHub Pages (free):**
1. Push these files to a GitHub repo
2. Settings → Pages → Source: main branch → `/` root
3. Your URL: `https://yourusername.github.io/repo-name/`

**Option B** — Netlify, Vercel, or any static host — just drag and drop the folder.

### 6. Add to Home Screen (iPhone)
1. Open the hosted URL in **Safari**
2. Tap the **Share** button → **Add to Home Screen**
3. Name it "RT ABA" → **Add**

---

## App Flow
```
Select Therapist → Select Client → Start Session
                                        ↓
                              [Behaviors | Trials | ABC]
                                        ↓
                                   End Session
                                  (submit → Sheets)
```

---

## Admin Panel

Tap the **⚙ gear icon** on the therapist selection screen → enter your PIN (default: **1234**).

The admin panel has four tabs:

| Tab | What you can manage |
|-----|-------------------|
| **Therapists** | Name, initials, color |
| **Clients** | Name, initials, Google Sheet ID |
| **Behaviors** | Key, display label, color |
| **Goals** | Client assignment, code, description, number of trials |

Changes are saved immediately to the RT Admin Google Sheet and take effect on the next app load.

To deactivate an entity (hide it without deleting), tap **Disable**. Tap **Activate** to re-enable it.

---

## Google Sheets Architecture

### RT Admin Sheet (one shared sheet)
| Tab | Columns |
|-----|---------|
| Therapists | id, name, initials, color, status |
| Clients | id, name, initials, sheetId, status |
| Behaviors | key, label, icon, color, status |
| Goals | clientId, code, description, numTrials, status |

### Per-client Sheets (one per client)
| Tab | Purpose |
|-----|---------|
| Session Log | Date, type, times, billing code, notes |
| Behavior Data | Dynamic columns based on active behaviors |
| Trial Data | Dynamic columns based on active goals |
| ABC Data | Incident records |

Tabs are created automatically on first session submit.

---

## Billing Codes
Auto-populated based on session type:
- 1:1 with client → **97153**
- Supervision → **97155**
- Parent Training → **97156**

---

## Demo Mode
If `GAS_URL` is left as `YOUR_GOOGLE_APPS_SCRIPT_URL_HERE`, the app runs in **demo mode**:
- Uses built-in default config (5 clients, 4 therapists, 7 behaviors, all goals)
- Session data is logged to the browser console instead of Google Sheets
- Admin panel changes apply in memory only (reset on page reload)
