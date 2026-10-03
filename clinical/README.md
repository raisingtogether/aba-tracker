# RT Clinical Console (`/clinical`)

Desktop console for **assessments** and **behavioral plans** — BCBA and admin work
that needs a keyboard, a large screen and a long sitting. Session data collection
stays in the tracker PWA, where it belongs.

A **second page, not a second system**: same GAS backend, same Google OAuth, same
RT Admin config store, same design tokens. Only the layout and the audience differ.

## Why it is separate

`index.html` is one ~7,000-line mobile-first file. Putting 500-item assessment
forms in it would bloat the bundle an RBT downloads on a phone for screens they
will never open — and the admin tab bar is already overflowing horizontally at 12
tabs. See `docs/architecture/assessments_plans_design.md` §1.

## One-time setup — required before sign-in works

`redirect_uri` must match **exactly** what Google has registered. Add this to the
OAuth client's **Authorized redirect URIs**:

```
https://rt-aba-tracker.web.app/clinical/
```

Add the `firebaseapp.com` equivalent too if anyone uses that domain:

```
https://rt-aba-tracker.firebaseapp.com/clinical/
```

Google Cloud Console → APIs & Services → Credentials → the OAuth 2.0 Client ID
(`145308926221-…`) → Authorized redirect URIs → Add → Save. Changes can take a few
minutes to take effect.

**Note the trailing slash.** The page pins `REDIRECT_PATH = '/clinical/'` precisely
so only one URI needs registering — `/clinical` and `/clinical/` are different
strings to Google, and without pinning you would have to register and maintain
both. If you see `redirect_uri_mismatch`, this is why.

## What is built

| | |
|---|---|
| Google OAuth | Reuses the tracker's `googleAuthCache` key. Same origin, so a token from either page works in the other, and signing out of one signs out of both. |
| Role gate | `admin` or `bcba` only, resolved with the **same admins-then-therapists precedence** as the tracker, so nobody can be admin in one page and not the other. An RBT gets a clear dead end rather than a degraded view. |
| Config | `getConfig` against the same endpoint. No second source of truth. |
| Client picker | All clients, discharged ones labelled. |
| Navigation | Overview (live) plus stubs for Assessments, Behavioral plans, Goals. |
| Audit | Login, logout and client selection are written to the audit log. |

## What is deliberately not built

Everything clinical. The shell exists first because auth, config, client selection
and navigation are what every later section depends on. Each stub names its
roadmap item and what it will do, so the page is honest rather than a mock.

Build order from here (`docs/architecture/assessments_plans_design.md` §6):
**f36** instrument framework → **f34** ABLLS-R as a definition file → **f37**
assessments to BigQuery → **f38/f39** plan generator with rule-based suggestion.

## Deploy

`firebase deploy --only hosting`. The `/clinical` rewrite is in `firebase.json`;
this README is excluded from hosting by the `**/*.md` ignore rule.

## Admin capabilities — deliberately NOT duplicated here

The console does **not** reproduce the app's 12 admin tabs, and copying them would
be actively dangerous in this codebase: `objectsToSheet` rewrites each config tab
from a **fixed header list in the backend**, so any column absent from that list is
dropped on save. Two separate `saveEntity` implementations feeding one destructive
writer means a BCBA saving from the console could silently wipe fields an admin
entered in the app. We hit that failure mode twice in one week (`goalId`,
`parentEmail`) with only *one* editor.

So: **one implementation each, surfaced where it belongs — never copied.** The
sidebar links out to the app's admin panel instead.

| Stays in the app | May MOVE here later | Never duplicated |
|---|---|---|
| Mastery approve/dismiss | Authorizations | Clients, Behaviors, Goals config |
| Alerts review queue | Payroll, Billing | |
| Manual session entry | Settings, Admins, Therapists | |

Anything in the middle column should be *moved* one at a time, deleting the app
copy as each lands — which also shrinks the bundle an RBT downloads for screens
they can never open.
