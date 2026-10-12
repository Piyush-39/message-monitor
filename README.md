# IS Message Watchdog

A small Chrome extension for SAP Integration Suite tenants in any region, including trial tenants and custom domains. The tenant is detected from the active Monitor Message Processing tab; there is no tenant allowlist to edit. It checks for new `FAILED` messages every minute for nine hours using the existing browser session and emails alerts through a local Gmail SMTP relay. No SAP client ID, client secret, copied cookie, or bearer token is required.

Compatible tenants must expose the HTTPS `/shell/monitoring/Messages` page and browser-session `/odata/api/v1/MessageProcessingLogs` route used by this extension. A different monitoring UI/API requires a reader change; recognizing a domain alone does not guarantee compatibility. Multiple tenants can run together in the same Chrome profile. Each tenant has its own signed-in session, dedicated watchdog tab, nine-hour end time, failed-message counter and duplicate tracking. Only one run per tenant origin can be active at a time.

The extension uses Chrome's [optional host permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions) to request each detected tenant separately.

## Set up email locally

Use Node.js 20.12 or later. From this folder:

```sh
npm install
npm run setup
npm start
```

Setup defaults to sending from and to **piyushsahu9846@gmail.com**. Enter the Gmail app password in your own terminal; input is hidden. Setup writes a private `.env` and prints a separate relay key for the extension. Run `npm start` in your own Terminal and keep it running for the monitoring shift; a process started by an agent can be cancelled when its tool server restarts. The relay verifies Gmail authentication before it starts.

The current local configuration sends from **piyushsahu9846@gmail.com** to **piyushsahu731@gmail.com**. The local `.env` is not included in the ZIP.

Create an app password at https://myaccount.google.com/apppasswords if you do not already have one. Google requires 2-Step Verification and may restrict app passwords on some accounts: [Google instructions](https://support.google.com/accounts/answer/185833). Use an app password, not your normal Gmail password.

## Load the extension

1. In the **same Chrome Work profile where you log in to IS**, open `chrome://extensions`.
2. Enable Developer mode, choose **Load unpacked**, and select this folder's `extension` directory.
3. Open the extension popup and paste the **relay key**, not the Gmail app password.
4. Click **Send test email** and confirm that it arrives at your Gmail address.
5. Open any tenant's IS **Monitor Message Processing** page and click **Start this tenant** in the extension popup. Allow access to that tenant when Chrome asks. Chrome remembers approved tenants; approval is required the first time you use a new tenant.
6. Repeat step 5 from each additional tenant's monitor page. Existing runs keep monitoring. Each tenant appears as a separate card in the popup.
7. Click **Open watchdog tab** or **Stop** on the card for the tenant you want to manage.

Open each tenant in the same signed-in Chrome profile. Starting a second tenant does not stop the first. Stopping or finishing one run does not change another tenant's alarms or keep-awake request. Each tenant needs its own active login; different Chrome profiles require separate extension runs.

The extension creates a dedicated background monitor tab. It reads the same `/odata/api/v1/MessageProcessingLogs` request observed on your tenant, with `Status eq 'FAILED'`. Leave that tab open. Do not start from an iFlow editor or a different Chrome profile.

Email detection makes a fresh SAP request every minute and does not depend on the displayed table or manually clicking Refresh. The extension also invokes **Reload content** through the button's SAP UI5 press handler in the dedicated tab's Messages toolbar after each successful check, keeping that table current. A plain DOM click does not trigger this handler on the observed monitor; the extension uses the registered `sap.m.Button.firePress()` event ([SAP UI5 API](https://ui5.github.io/typescript/api/sapui5/1.148/sap.m/sap/m/Button/classes/Button.html)). Other open monitor tabs are not refreshed. The popup shows the last table-refresh time; if SAP changes its toolbar or the button is unavailable, email checks continue and the popup reports that table refresh is unavailable.

Existing failures are recorded as a baseline and do not trigger emails. New failures are grouped into emails with up to 50 messages, including flow name, message ID, time and a link to IS. Payloads and detailed exception text are not emailed. Successfully emailed message IDs are deduplicated across checks; the local relay also persists delivery receipts for 30 days. Failed email attempts retry on subsequent checks.

The popup shows each tenant's status, last successful SAP check, table-refresh time, sent-message count and end time. Email subjects identify the tenant. **Stop** ends the selected tenant's run; the run also stops automatically after nine hours. The dedicated tab stays open. Starting another run creates a fresh tab; old watchdog tabs can be closed after stopping. A check has a 20-second / 200-page budget; unusually high failure volume is reported as a monitoring problem rather than silently truncated.

## Session and laptop behavior

Each check sends an actual authenticated SAP read request. For an inactivity timeout, these requests are intended to keep the session active. This was verified as an authenticated HTTP 200 read on your tenant; continuous operation beyond 15 minutes and a full nine-hour shift still need live validation. Tenant or identity-provider policies can still require reauthentication.

If the session expires, access is denied, or a check fails, the badge turns red and a local notification appears. The relay sends one monitoring-problem email per tenant outage when Gmail is reachable. An issue in one tenant does not stop another tenant from checking or emailing failures. Sign in again in the dedicated tab; checks retry every minute and scan from the start of the run with a five-minute overlap to catch missed/late logs. There is no password/MFA automation or automatic SSO workaround.

Chrome requests permission to keep the computer awake during a run (display may sleep), and releases that request after all tenant runs have stopped or ended. Keep Chrome and the relay running and the laptop lid open. Closing the lid, quitting Chrome, a network outage or an OS sleep override can interrupt monitoring. Chrome alarms are best-effort, not a precise real-time schedule.

If the relay is unavailable, the extension cannot email you; the popup and local notification show the error. If the local relay process has an ambiguous SMTP failure after acceptance, a retry can occasionally duplicate an email; SMTP does not support guaranteed exactly-once delivery. A message that leaves Failed status between checks may not be observed. Only SAP `FAILED` status is monitored, not handled errors marked Completed, Retry or Escalated.

## Alerts when monitoring is interrupted

The extension registers each run with the local relay and sends a heartbeat after every poll, including polls that report a known SAP problem. If the relay receives no heartbeat for **three minutes**, it sends one **monitoring stopped** email for that tenant. Its timer checks every 30 seconds, so allow that extra interval plus email delivery time. A recovered run can generate a new alert if a later interruption occurs. Chrome being quit, the extension being disabled or its worker failing can be detected even when the extension cannot send its own warning, provided the relay and network remain available.

Manual **Stop** and normal nine-hour expiry disarm heartbeat monitoring and do not send interruption emails. If the relay is unreachable during Stop, the cancellation is saved and retried; the relay can still report a missed heartbeat until it receives that cancellation. A stale cancellation for an old run cannot cancel a newer run for the same tenant.

On a normal relay shutdown (`SIGINT`/`SIGTERM`, including Ctrl+C), the relay attempts to email active tenants before exiting. Monitoring windows and undelivered notices are saved privately in `.relay-state.json.monitoring`; delivery receipts are in `.relay-state.json`. After a restart, it checks persisted windows and retries pending notices. Restarting after a missed heartbeat during a completed shift can also produce a delayed interruption alert.

A relay that is force-killed, an offline computer, or an unavailable Gmail connection cannot send an immediate email. Such gaps are reported after the relay/network recovers; truly immediate detection while the whole computer is offline needs an external monitor. Long Chrome alarm delays can also trigger the three-minute warning.

## Upgrade from version 1.0.x

Restart the relay with the updated code before reloading the extension in `chrome://extensions`. The active single-tenant run migrates automatically with its original end time, sent count and seen message IDs. Then start additional tenants from their monitor pages. No new install-time Chrome permissions are required.

## Check the implementation

```sh
npm test
```

Automated tests cover simultaneous tenants with matching message IDs, independent Stop/expiry, slow or failed tenants, permission denial/revocation, worker restart and legacy state migration, missing table refresh, and persisted delivery receipts. An end-to-end test runs the actual serialized page reader against fake SAP responses, sends requests through the real authenticated HTTP relay, and checks mail delivery with a fake SMTP transport. Tests do not create SAP messages or send real Gmail email.

Earlier versions were validated live on the trial tenant, including successful failure emails and automatic SAP table refresh. Version 1.1.0's concurrent tenant and outage behavior is covered by automated tests; simultaneous live tenant sessions and a full nine-hour shift still need live validation.

The relay binds only to `127.0.0.1:43171`, requires its random key, fixes the email recipient in `.env`, and accepts no SMTP password from the extension. The Gmail password stays outside the extension in the local `.env`; do not commit or share it. HTTPS host access is optional: Chrome grants access only to the individual tenants approved through Start, not to all websites. The active tab is inspected when you open the popup. SAP requests and pagination stay on the selected tenant; emailed message links must match it.
