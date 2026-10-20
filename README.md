# IS Message Watchdog

A small Chrome extension for SAP Integration Suite tenants in any region, including trial tenants and custom domains. The tenant is detected from the active Monitor Message Processing tab; there is no tenant allowlist to edit. It checks for new messages in your selected statuses every minute (all statuses except `COMPLETED` are selected by default) for nine hours using the existing browser session and emails alerts through a local Gmail SMTP relay. No SAP client ID, client secret, copied cookie, or bearer token is required.

Compatible tenants must expose the HTTPS `/shell/monitoring/Messages` page and browser-session `/odata/api/v1/MessageProcessingLogs` route used by this extension. A different monitoring UI/API requires a reader change; recognizing a domain alone does not guarantee compatibility. Multiple tenants can run together in the same Chrome profile. Each tenant has its own signed-in session, dedicated watchdog tab, nine-hour end time, emailed-message counter and duplicate tracking. Only one run per tenant origin can be active at a time.

The extension uses Chrome's [optional host permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions) to request each detected tenant separately.

## Set up email locally

Use Node.js 20.12 or later. From this folder:

```sh
npm install
npm run setup
npm start
```

Your local `.env` already contains the email settings. `npm run setup` reads it and prints only the relay key for the extension, without asking for credentials or changing the email settings. It reuses the saved key; if one is missing, it generates and saves one. For a new installation, copy `.env.example` to `.env` and fill in the email settings there first. `npm start` automatically loads `.env`; keep it running in your own Terminal for the monitoring shift, since a process started by an agent can be cancelled when its tool server restarts. The relay verifies Gmail authentication before it starts.

The current local configuration sends from **piyushsahu9846@gmail.com** to **piyushsahu731@gmail.com**. The local `.env` is not included in the ZIP.

Create an app password at https://myaccount.google.com/apppasswords if you do not already have one. Google requires 2-Step Verification and may restrict app passwords on some accounts: [Google instructions](https://support.google.com/accounts/answer/185833). Use an app password, not your normal Gmail password.

## Load the extension

1. In the **same Chrome Work profile where you log in to IS**, open `chrome://extensions`.
2. Enable Developer mode, choose **Load unpacked**, and select this folder's `extension` directory.
3. Open the extension popup and paste the **relay key**, not the Gmail app password.
4. Click **Send test email** and confirm that it arrives at your Gmail address.
5. Open any tenant's IS **Monitor Message Processing** page. Select the desired **Artifacts** and package, then click **Go** to apply the filters. Choose the **Email these statuses** checkboxes in the extension popup, then click **Start this tenant**. Allow access to that tenant when Chrome asks. Chrome remembers approved tenants; approval is required the first time you use a new tenant.
6. Repeat step 5 from each additional tenant's monitor page. Existing runs keep monitoring. Each tenant appears as a separate card in the popup.
7. Click **Open watchdog tab** or **Stop** on the card for the tenant you want to manage.

Open each tenant in the same signed-in Chrome profile. Starting a second tenant does not stop the first. Stopping or finishing one run does not change another tenant's alarms or keep-awake request. Each tenant needs its own active login; different Chrome profiles require separate extension runs.

The extension creates a dedicated background monitor tab. It reads the same `/odata/api/v1/MessageProcessingLogs` request observed on your tenant, restricted to the run’s selected statuses. Leave that tab open. Do not start from an iFlow editor or a different Chrome profile.

Each run captures the applied page's selected technical iFlow IDs (`artifactIds`) and package (`packageId`) when you click Start. The baseline, subsequent SAP queries and email results use that selection. Multiple selected iFlows are matched by ID; a package selection also restricts results to that package. **All** starts unrestricted monitoring. The popup shows the saved selection's iFlow count instead of listing every name or technical ID. Without explicit artifact IDs, it shows **All iFlows** or **All iFlows in the selected package**. The dedicated tab preserves these filters and shows All statuses with a rolling Past Hour window; email checks independently use the statuses saved in the extension and always exclude Completed. To change a run's selection, Stop it, apply the new filters with Go, and Start again from that page. Changing the original tab's filters does not change an existing run.

Email detection makes a fresh SAP request every minute and does not depend on the displayed table or manually clicking Refresh. The extension also invokes **Reload content** through the button's SAP UI5 press handler in the dedicated tab's Messages toolbar after each successful check, keeping that table current. A plain DOM click does not trigger this handler on the observed monitor; the extension uses the registered `sap.m.Button.firePress()` event ([SAP UI5 API](https://ui5.github.io/typescript/api/sapui5/1.148/sap.m/sap/m/Button/classes/Button.html)). Other open monitor tabs are not refreshed. The popup shows the last table-refresh time; if SAP changes its toolbar or the button is unavailable, email checks continue and the popup reports that table refresh is unavailable.

Existing messages matching the selected statuses are recorded as a baseline and do not trigger emails. Each new message matching the selected statuses gets its own email, including actual status, flow name, message ID, time, error text and a link to IS. The subject includes the tenant and SAP message ID, keeping unrelated messages in separate Gmail conversations. Gmail error-text filters can therefore archive one message without hiding other alerts. Error text is fetched from the message’s `ErrorInformation/$value` endpoint using the same tenant session. Message payload and attachment endpoints are not read. Successfully emailed message IDs are deduplicated across checks; the local relay also persists delivery receipts for 30 days. Failed email attempts retry on subsequent checks.

The popup shows each tenant's status, last successful SAP check, table-refresh time, sent-message count and end time. Email subjects identify the tenant. **Stop** ends the selected tenant's run; the run also stops automatically after nine hours. The dedicated tab stays open. Starting another run creates a fresh tab; old watchdog tabs can be closed after stopping. A check has a 20-second / 200-page budget; unusually high message volume is reported as a monitoring problem rather than silently truncated.

## Session and laptop behavior

Each check sends an actual authenticated SAP read request. For an inactivity timeout, these requests are intended to keep the session active. This was verified as an authenticated HTTP 200 read on your tenant; continuous operation beyond 15 minutes and a full nine-hour shift still need live validation. Tenant or identity-provider policies can still require reauthentication.

If the session expires, access is denied, or a check fails, the badge turns red and a local notification appears. The relay sends one monitoring-problem email per tenant outage when Gmail is reachable. An issue in one tenant does not stop another tenant from checking or emailing messages. Sign in again in the dedicated tab; checks retry every minute and scan from the start of the run with a five-minute overlap to catch missed/late logs. There is no password/MFA automation or automatic SSO workaround.

Chrome requests permission to keep the computer awake during a run (display may sleep), and releases that request after all tenant runs have stopped or ended. Keep Chrome and the relay running and the laptop lid open. Closing the lid, quitting Chrome, a network outage or an OS sleep override can interrupt monitoring. Chrome alarms are best-effort, not a precise real-time schedule.

If the relay is unavailable, the extension cannot email you; the popup and local notification show the error. If the local relay process has an ambiguous SMTP failure after acceptance, a retry can occasionally duplicate an email; SMTP does not support guaranteed exactly-once delivery. Messages observed as Failed, Retry, Processing, Escalated, Cancelled, Discarded or Abandoned are eligible; Completed messages are excluded. Each message ID is emailed once, even if its status later changes. Messages that become Completed between checks may not be observed. Checks use both start and end times so messages without an end time can be detected.

## Alerts when monitoring is interrupted

The extension registers each run with the local relay and sends a heartbeat after every poll, including polls that report a known SAP problem. If the relay receives no heartbeat for **three minutes**, it sends one **monitoring stopped** email for that tenant. Its timer checks every 30 seconds, so allow that extra interval plus email delivery time. A recovered run can generate a new alert if a later interruption occurs. Chrome being quit, the extension being disabled or its worker failing can be detected even when the extension cannot send its own warning, provided the relay and network remain available.

Manual **Stop** and normal nine-hour expiry disarm heartbeat monitoring and do not send interruption emails. If the relay is unreachable during Stop, the cancellation is saved and retried; the relay can still report a missed heartbeat until it receives that cancellation. A stale cancellation for an old run cannot cancel a newer run for the same tenant.

On a normal relay shutdown (`SIGINT`/`SIGTERM`, including Ctrl+C), the relay attempts to email active tenants before exiting. Monitoring windows and undelivered notices are saved privately in `.relay-state.json.monitoring`; delivery receipts are in `.relay-state.json`. After a restart, it checks persisted windows and retries pending notices. Restarting after a missed heartbeat during a completed shift can also produce a delayed interruption alert.

A relay that is force-killed, an offline computer, or an unavailable Gmail connection cannot send an immediate email. Such gaps are reported after the relay/network recovers; truly immediate detection while the whole computer is offline needs an external monitor. Long Chrome alarm delays can also trigger the three-minute warning.

## Error text in emails

Each new alert includes an **Error** field containing up to 2,000 characters of SAP error information. Longer errors end with `[truncated]`; open the message link for the full details. No error lookups are made for baseline messages, previously emailed IDs, unchecked statuses or artifacts outside the run’s saved selection.

If SAP returns no error information, the email says **No error information available**. A failed lookup, expired detail request or unavailable watchdog tab produces **Error details unavailable** while the message alert still sends. Detail lookups use up to five concurrent requests and a 15-second budget per lookup batch of up to 50 messages. Email delivery is still one SAP message per email. [Discarded messages have no error information according to SAP](https://help.sap.com/docs/integration-suite/isuite-integrations-and-apis/message-processing-logs), so their detail requests are skipped.

## Choose email statuses

The popup offers **Failed**, **Retry**, **Processing**, **Escalated**, **Cancelled**, **Discarded** and **Abandoned** checkboxes. All seven are selected by default; Completed is always excluded. Select at least one before starting. Each tenant saves its own selection, and each card shows its email statuses.

To change an active tenant, open its monitor or watchdog tab and reopen the popup. Its saved checkboxes load automatically. Change them and click **Save statuses**. The selection takes effect on the next check without restarting the run or changing its saved artifact/package filters, end time or duplicate tracking. Other tenants keep their selections. Saved selections survive Chrome/worker restarts and load again when starting that tenant later.

Enabling another status can email previously unseen messages in that status within the run’s scan window. A message ID already recorded in the baseline or successfully emailed is still suppressed, even if it changes status.

## Upgrade to version 1.5.1: independent email alerts

Version 1.5.0 combined up to 50 SAP messages in one email. A Gmail filter matching one error archived or marked the entire email as read, including unrelated errors. Version 1.5.1 sends one email per SAP message and includes that message's ID in the subject. This increases the number of emails compared with batching. The updated relay also splits requests from older extensions, and persists each successful message receipt before attempting the next so partial failures and restarts do not resend confirmed deliveries.

1. Until the upgrade is active, edit error-text Gmail filters to turn off **Skip the Inbox** and **Mark as read**, so mixed emails remain visible.
2. In the Terminal running the relay, press Ctrl+C, then run `npm start` from this project directory. A normal shutdown may send a monitoring-interruption notice for active tenants.
3. Open `chrome://extensions` and click **Reload** on **IS Message Watchdog**. Its version should show **1.5.1**. Existing runs, filters, end times and duplicate tracking are retained; there is no need to Stop and Start a tenant.
4. Confirm that new SAP alert emails each contain one message and have different message IDs in their subjects. You can then restore **Skip the Inbox** and **Mark as read** on your error-text Gmail filters. Gmail still controls notification behavior for each matching email.

Previously emailed messages are not resent. Review older mixed emails under your error labels (and in Trash if you deleted them), since this change cannot recover missed notifications or split emails already delivered. A test email checks SMTP connectivity; the next real SAP alert checks the new per-message format.

## Upgrade to version 1.5.0

Restart the relay with `npm start`, then reload the extension in `chrome://extensions`. New alert emails include error details automatically; existing tenant runs and saved status/artifact selections continue. Previously emailed messages are not resent.

## Upgrade to version 1.4.0

Reload the extension in `chrome://extensions` to see the status checkboxes. Existing runs without a saved status selection default to all seven non-Completed statuses. If upgrading from the original failure-only extension, restart the updated relay with `npm start` too.

## Upgrade to version 1.3.0

Restart the relay with `npm start` and reload the extension in `chrome://extensions` to enable alerts for every status except Completed. Existing runs keep their saved artifact/package scope, end time and seen IDs, and use the broader status checks on the next poll. Stop and Start from the applied filtered page to take a fresh baseline and open a watchdog tab showing All statuses. Existing non-Completed messages in a continuing run may now generate alerts if their IDs were never recorded by the previous failure-only reader.

## Upgrade from version 1.0.x

Restart the relay with the updated code before reloading the extension in `chrome://extensions`. The active single-tenant run migrates automatically with its original end time, sent count and seen message IDs. Then start additional tenants from their monitor pages. No new install-time Chrome permissions are required.

For the **1.1.1 iFlow filter fix**, reload the extension, Stop any existing run that should be filtered, and Start again from its filtered page after clicking Go. Older runs have no saved artifact selection and continue monitoring all iFlows until restarted.

## Check the implementation

```sh
npm test
```

Automated tests cover error-text lookup and email delivery, absent/unavailable details, long UTF-8 errors, bounded concurrency, isolation of mixed errors into separate emails with distinct subjects, splitting older 50-message requests, partial-delivery retries across extension/relay restarts, per-tenant status selections, live selection updates, persistence, invalid/empty selections, simultaneous tenants with matching message IDs, selected artifact/package baselines and polls, exact IDs despite identical display names, OData escaping, pagination filtering, malformed filters, independent Stop/expiry, slow or failed tenants, permission denial/revocation, worker restart and legacy state migration, missing table refresh, and persisted delivery receipts. An end-to-end test runs the actual serialized page reader against fake SAP responses, sends requests through the real authenticated HTTP relay, and checks mail delivery with a fake SMTP transport, including exclusion of unselected iFlows. Tests do not create SAP messages or send real Gmail email.


Earlier versions were validated live on the trial tenant, including successful failure emails and automatic SAP table refresh. Version 1.1.1's artifact and package query was also checked read-only against an authenticated tenant: HTTP 200 with a result matching both selected IDs. Filtered email delivery, concurrent tenant and outage behavior are covered by automated tests; simultaneous live tenant sessions and a full nine-hour shift still need live validation.

The relay binds only to `127.0.0.1:43171`, requires its random key, fixes the email recipient in `.env`, and accepts no SMTP password from the extension. The Gmail password stays outside the extension in the local `.env`; do not commit or share it. HTTPS host access is optional: Chrome grants access only to the individual tenants approved through Start, not to all websites. The active tab is inspected when you open the popup. SAP requests and pagination stay on the selected tenant; emailed message links must match it.
