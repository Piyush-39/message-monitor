# IS Message Watchdog

A small Chrome extension for SAP Integration Suite tenants in any region, including trial tenants and custom domains. The tenant is detected from the active Monitor Message Processing tab; there is no tenant allowlist to edit. It checks for new `FAILED` messages every minute for nine hours using the existing browser session and emails alerts through a local Gmail SMTP relay. No SAP client ID, client secret, copied cookie, or bearer token is required.

Compatible tenants must expose the HTTPS `/shell/monitoring/Messages` page and browser-session `/odata/api/v1/MessageProcessingLogs` route used by this extension. A different monitoring UI/API requires a reader change; recognizing a domain alone does not guarantee compatibility. Only one tenant is monitored at a time.

Version 1.0.2 uses Chrome's [optional host permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions) to request each detected tenant separately.

## Set up email locally

Use Node.js 20.12 or later. From this folder:

```sh
npm install
npm run setup
npm start
```

Setup defaults to sending from and to **piyushsahu9846@gmail.com**. Enter the Gmail app password in your own terminal; input is hidden. Setup writes a private `.env` and prints a separate relay key for the extension. Keep `npm start` running for the monitoring shift. The relay verifies Gmail authentication before it starts.

The current local configuration sends from **piyushsahu9846@gmail.com** to **piyushsahu731@gmail.com**. The local `.env` is not included in the ZIP.

Create an app password at https://myaccount.google.com/apppasswords if you do not already have one. Google requires 2-Step Verification and may restrict app passwords on some accounts: [Google instructions](https://support.google.com/accounts/answer/185833). Use an app password, not your normal Gmail password.

## Load the extension

1. In the **same Chrome Work profile where you log in to IS**, open `chrome://extensions`.
2. Enable Developer mode, choose **Load unpacked**, and select this folder's `extension` directory.
3. Open the extension popup and paste the **relay key**, not the Gmail app password.
4. Click **Send test email** and confirm that it arrives at your Gmail address.
5. Open any tenant's IS **Monitor Message Processing** page and click **Start 9 hours** in the extension popup. Allow access to that tenant when Chrome asks. Chrome remembers approved tenants; approval is required the first time you use a new tenant.
6. Click **Open watchdog tab** to see the dedicated monitored table.

To switch tenants, click **Stop**, open the other tenant's monitor page in the same signed-in Chrome profile, then click **Start 9 hours**. The new run uses that tenant's session and links. Each tenant needs its own active login.

The extension creates a dedicated background monitor tab. It reads the same `/odata/api/v1/MessageProcessingLogs` request observed on your tenant, with `Status eq 'FAILED'`. Leave that tab open. Do not start from an iFlow editor or a different Chrome profile.

Email detection makes a fresh SAP request every minute and does not depend on the displayed table or manually clicking Refresh. Version 1.0.3 also invokes **Reload content** through the button's SAP UI5 press handler in the dedicated tab's Messages toolbar after each successful check, keeping that table current. A plain DOM click does not trigger this handler on the observed monitor; the extension uses the registered `sap.m.Button.firePress()` event ([SAP UI5 API](https://ui5.github.io/typescript/api/sapui5/1.148/sap.m/sap/m/Button/classes/Button.html)). Other open monitor tabs are not refreshed. The popup shows the last table-refresh time; if SAP changes its toolbar or the button is unavailable, email checks continue and the popup reports that table refresh is unavailable.

Existing failures are recorded as a baseline and do not trigger emails. New failures are grouped into emails with up to 50 messages, including flow name, message ID, time and a link to IS. Payloads and detailed exception text are not emailed. Successfully emailed message IDs are deduplicated across checks; the local relay also persists delivery receipts for 30 days. Failed email attempts retry on subsequent checks.

The popup shows status, last successful SAP check, sent-message count and end time. **Stop** ends a run; the run also stops automatically after nine hours. The dedicated tab stays open. Starting another run creates a fresh tab; old watchdog tabs can be closed after stopping. A check has a 20-second / 200-page budget; unusually high failure volume is reported as a monitoring problem rather than silently truncated.

## Session and laptop behavior

Each check sends an actual authenticated SAP read request. For an inactivity timeout, these requests are intended to keep the session active. This was verified as an authenticated HTTP 200 read on your tenant; continuous operation beyond 15 minutes and a full nine-hour shift still need live validation. Tenant or identity-provider policies can still require reauthentication.

If the session expires, access is denied, or a check fails, the badge turns red and a local notification appears. The relay sends one monitoring-problem email per outage when Gmail is reachable. Sign in again in the dedicated tab; checks retry every minute and scan from the start of the run with a five-minute overlap to catch missed/late logs. There is no password/MFA automation or automatic SSO workaround.

Chrome requests permission to keep the computer awake during a run (display may sleep), and releases that request on Stop/end. Keep Chrome and the relay running and the laptop lid open. Closing the lid, quitting Chrome, a network outage or an OS sleep override can interrupt monitoring. Chrome alarms are best-effort, not a precise real-time schedule.

If the relay is unavailable, the extension cannot email you; the popup and local notification show the error. If the local relay process has an ambiguous SMTP failure after acceptance, a retry can occasionally duplicate an email; SMTP does not support guaranteed exactly-once delivery. A message that leaves Failed status between checks may not be observed. Only SAP `FAILED` status is monitored, not handled errors marked Completed, Retry or Escalated.

## Check the implementation

```sh
npm test
```

All 24 automated tests pass using fake SAP responses and fake email delivery. They cover previously unknown regional/custom origins, per-tenant permission requests and denial/revocation, tenant changes, relay validation, separate delivery receipts per tenant, table refresh and continued email detection when table refresh is unavailable. They do not create a failed SAP message or send real email.

Live validation on October 10, 2026 used version 1.0.1 of the installed extension on the trial tenant. A background alarm read the two existing `ERROR_FLOW_1_Groovy` failures and sent one real Gmail alert containing both messages to **piyushsahu731@gmail.com**. The alert was verified in Gmail; it initially arrived in Spam and was marked Not spam, moving it to Inbox. The temporary test baseline was restored, and subsequent scheduled polls with the debugger closed left the emailed-message count at two.

Version 1.0.2 was subsequently reloaded in Chrome, the relay restarted, and a fresh nine-hour run started on the automatically detected trial tenant at 15:08 IST. Its scheduled poll succeeded at 15:09 IST without emailing the existing baseline failures. Other regional/custom domains are covered by automated tests; live compatibility must be checked against each tenant's actual UI/API. Continuous operation beyond the 15-minute inactivity window and a full nine-hour shift still need live validation.

Version 1.0.3 was reloaded while preserving that run and its delivery history. The dedicated table still displayed the original two failures while API polling had emailed four newer failures. After adding the UI5 press handler, a scheduled poll with DevTools closed detected the new 15:33 failure, sent its Gmail alert and refreshed the table to seven rows at 15:34 IST. The run's emailed-message count was five, and its original 00:08 IST end time was preserved. The relay remained healthy; no SAP message was created by this validation.

The relay binds only to `127.0.0.1:43171`, requires its random key, fixes the email recipient in `.env`, and accepts no SMTP password from the extension. The Gmail password stays outside the extension in the local `.env`; do not commit or share it. HTTPS host access is optional: Chrome grants access only to the individual tenants approved through Start, not to all websites. The active tab is inspected when you open the popup. SAP requests and pagination stay on the selected tenant; emailed message links must match it.
