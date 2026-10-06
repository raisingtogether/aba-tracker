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

## Known-good scope set

```json
"oauthScopes": [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/bigquery",
  "https://www.googleapis.com/auth/script.scriptapp",
  "https://www.googleapis.com/auth/script.external_request",
  "https://www.googleapis.com/auth/script.send_mail",
  "https://www.googleapis.com/auth/userinfo.email"
]
```

Paste the live manifest into this file whenever it changes, so the scope set is at
least reviewable in git even though the editor remains authoritative.
