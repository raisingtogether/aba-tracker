# Apps Script manifest scopes

`appsscript.json` is **not in this repo** — it lives only in the Apps Script
editor (Project Settings → *Show "appsscript.json" manifest file*). That makes it
an unversioned source of truth, which is the same hazard CLAUDE.md already warns
about for GAS-vs-Firebase: a release can be correct in git and wrong in production
with no visible difference.

## The f54 incident (Oct 5, 2026)

`checkParentAlertSender()` threw:

```
Specified permissions are not sufficient to call MailApp.getRemainingDailyQuota.
Required permissions: https://www.googleapis.com/auth/script.send_mail
```

The manifest listed `bigquery`, `spreadsheets`, `script.scriptapp` and
`script.external_request` — **no mail scope**. An explicit `oauthScopes` array is
authoritative; Apps Script does not add missing scopes implicitly. So every
`MailApp.sendEmail` call threw, `evaluateParentAlerts`' try/catch swallowed it, and
the Parent Alerts row was written `status=failed` with the error in `note`.

**No parent alert had ever been delivered.** Session writes were never affected —
the wrapper exists precisely so a mail failure cannot cost a therapist their data.

## Required additions

Add to the **existing** `oauthScopes` array — do not replace it. Dropping
`bigquery` or `spreadsheets` breaks the hourly sync and every sheet write.

```json
"https://www.googleapis.com/auth/script.send_mail",
"https://www.googleapis.com/auth/userinfo.email"
```

| Scope | Why |
|---|---|
| `script.send_mail` | `MailApp.sendEmail`. Without it f54 cannot send at all. |
| `userinfo.email` | Read the deployment owner, so the diagnostic can say what a parent will actually see in the From line. |

**New scopes require re-authorization.** Save the manifest, run any function once,
and accept the consent prompt. Until that happens the old scope set is still in
force and nothing changes.

## Deliberately NOT added: `https://mail.google.com/`

Rewriting the From line needs `GmailApp`, which needs `https://mail.google.com/` —
**full read access to the deployment owner's entire mailbox**. In a practice
holding PHI that is a serious grant in exchange for a header line.

The better fix for the From address is ownership, not permission: **deploy the web
app from `tatiana@raising2gether.org`** (or transfer the script to it). `MailApp`
then already sends from that address with no additional scope.

Until either is done, alerts send from the deployment owner's address with
`Reply-To: tatiana@raising2gether.org`, so replies still reach the BCBA. The audit
entry and the Parent Alerts `note` column record the address **actually used**, so
the disclosure record never implies an address that was not on the message.

## Verifying

```
checkParentAlertSender()              # reads config, sends nothing
sendTestParentAlertTo('you@domain')   # real send, no patient data, no audit row
```

## The live manifest (captured 11 Oct 2026)

Recorded verbatim so the scope set is reviewable in git even though the editor
remains authoritative. **Update this block whenever the manifest changes.**

```json
{
  "timeZone": "America/New_York",
  "dependencies": {
    "enabledAdvancedServices": [
      {
        "userSymbol": "BigQuery",
        "version": "v2",
        "serviceId": "bigquery"
      }
    ]
  },
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE_ANONYMOUS"
  },
  "oauthScopes": [
    "https://www.googleapis.com/auth/bigquery",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/script.send_mail",
    "https://www.googleapis.com/auth/userinfo.email"
  ]
}
```

The first four scopes are the pre-existing set; the last two were added 11 Oct to
unblock f54. Replace the WHOLE file rather than hand-editing the array — the save
failed twice with *"Operation failed: invalid changes"*, which is Apps Script
rejecting malformed JSON, and the usual cause is a comma after the final entry.

**`clasp` was attempted and abandoned.** `clasp login` returns Google's generic
400 (*"The server cannot process the request because it is malformed"*) — a
long-standing problem with its bundled OAuth client, not with this project.
`clasp login --no-localhost` sometimes works. Worth revisiting so the manifest
lives in git properly, but not while it blocks a two-line edit.

## `access: ANYONE_ANONYMOUS` — deliberate, and the f26a gap

The web app is open to anonymous callers because the PWA posts to it without a
Google token. That is why the backend trusts a **caller-supplied identity** and
why mastery approval, alert approval and the clinical console all check a role
the client asserts about itself. Do not tighten this field without f26a
(device-token auth) — doing so breaks every session submit.
