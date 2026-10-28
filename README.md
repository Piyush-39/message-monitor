# IS Message Watchdog

A Chrome extension that checks SAP Integration Suite messages every minute until you stop monitoring and sends alerts through a local relay to Microsoft Teams, Discord or Gmail. It uses your signed-in browser session; no SAP API credentials are needed.

Monitor multiple tenants at once, filter by iFlow or package, and choose which statuses trigger alerts. Completed messages are always excluded.

## Requirements

- Node.js 20.12 or later and Chrome 120 or later.
- Access to your tenant’s **Monitor Message Processing** page in Chrome.
- A Teams Workflows webhook, a Discord channel webhook or a Gmail account with an app password.

## Set up notifications

From the project directory, install dependencies:

```sh
npm install
```

Choose one delivery option below.

### Microsoft Teams

1. In Teams desktop or web, open your channel's **⋯ → Workflows** and choose **Send webhook alerts to a channel**. Sign in, choose your team/channel, save, and copy the webhook URL. Use a workflow that allows **Anyone** to trigger it; this relay uses the signed URL and does not obtain Microsoft OAuth tokens. Your organization must allow Workflows. The Teams webhook template does not require a Power Automate Premium license. See [Microsoft's setup guide](https://support.microsoft.com/en-gb/workflows/send-messages-in-teams-using-incoming-webhooks).
2. Run the setup command and paste the full URL when prompted. Input is hidden, and the settings are saved privately in `.env`. Setup validates the URL format without sending a message.

   ```sh
   npm run setup:teams
   ```

3. Print the relay key, then start the relay:

   ```sh
   npm run setup
   npm start
   ```

4. Reload the extension if it was already installed, then use **Send test** and check your Teams channel. All alerts use the configured workflow, with one Adaptive Card per SAP message containing status, iFlow, tenant, IST time, message ID, error details and a link to SAP IS. Monitoring warnings use the same destination.

Teams accepts webhook requests before the workflow's channel-post action finishes. **Accepted by workflow** in the popup confirms the HTTP request succeeded; check the channel or the workflow's run history to confirm the post. Keep the webhook URL private, and enable channel/device notifications if you want mobile alerts. Add a workflow co-owner for continuity if its original owner becomes unavailable.

### Discord

1. In your Discord text channel, open **Edit Channel → Integrations → Webhooks → New Webhook** and copy the webhook URL.
2. Run the setup command and paste the URL when prompted. It saves the settings in `.env` with hidden input.

   ```sh
   npm run setup:discord
   ```

3. Print the relay key, then start the relay:

   ```sh
   npm run setup
   npm start
   ```

All alerts go to the configured channel. Enable channel and device notifications if you want mobile alerts.

### Gmail

1. For a new installation, copy `.env.example` to `.env`. Keep your existing `.env` if already configured.
2. Set these values in `.env`:

   - `NOTIFICATION_PROVIDER=email`
   - `SMTP_USER`: your Gmail address.
   - `SMTP_PASS`: your [Google app password](https://support.google.com/accounts/answer/185833), which requires 2-Step Verification.
   - `ALERT_TO`: the address that should receive alerts.
3. Generate or display the relay key, then start the relay:

   ```sh
   npm run setup
   npm start
   ```

Keep the relay running in your Terminal during monitoring. Restart it after changing notification settings. Keep `.env` private; paste only the **relay key** into the extension.

## Load the extension

1. In the Chrome profile where you sign in to SAP IS, open `chrome://extensions`.
2. Enable **Developer mode**, click **Load unpacked**, and select this project’s `extension` directory.
3. Open **Relay settings** in the extension popup, paste the relay key printed by `npm run setup`, and click **Connect relay** to validate and save it.
4. Click **Send test** and confirm the notification arrives.

## Start monitoring

1. Open your tenant’s **Monitor Message Processing** page.
2. Select the desired **Artifacts** and package, then click **Go** to apply the filters. Choose **All** to monitor all iFlows.
3. Open the extension popup, choose the notification statuses, and click **Start monitoring**. Allow access to the tenant when Chrome asks.
4. Leave the dedicated watchdog tab open. Repeat these steps for additional tenants in the same Chrome profile.

All seven non-Completed statuses are selected by default. Existing matching messages form the starting baseline and do not trigger alerts. New matching messages each get one notification with status, iFlow, tenant, time, message ID, error details when available, and a link to SAP IS. Previously recorded message IDs are suppressed, even if their status changes.

The popup shows the current tenant and a separate bordered card for every monitored tenant, with a consistent color marker, its full hostname, health, last successful check, accepted-message count, and alerts handed to the relay during the latest check. The current tenant has a **Current tab** label. Use the **Relay settings** tab for the full-width key field and connection controls. The tenant list scrolls inside the popup when needed:

- **Open watchdog tab** opens that tenant’s monitoring tab.
- **Details** expands a tenant’s saved filters, alert statuses, activity, and table-refresh time.
- **Edit statuses** expands the active tenant’s checkboxes; **Save alert statuses** applies changes on its next check. Open that tenant’s monitor or watchdog tab before editing its selection.
- **Stop** ends only that tenant’s run and cancels its locally queued alerts for the connected Discord or Teams provider. Other tenants and new runs are independent. Alerts already accepted by the notification service cannot be recalled. There is no automatic end time. A problem in one tenant does not stop other tenants from checking.

If the relay cannot confirm Stop, the popup warns that cancellation is pending and retries automatically. Keep the relay running until confirmation. The relay saves confirmed cancellations across restarts and ignores late handoffs from the stopped run. For queues saved by older relay versions without run information, Stop clears that tenant’s legacy queued alerts too.

To change iFlow or package filters, stop the run, apply the new filters with **Go**, and start again. Changing filters in the original page does not update an active run.

**Last successful check** records a completed SAP message API read, independently of the visible table refresh. Its age updates every second while the popup is open, even if monitoring stalls. After three minutes without a successful check, an active tenant shows **Needs attention**. Heartbeats and failed checks do not reset this timestamp.

**Reset data** at the bottom of the popup stops all tenant runs and clears the extension’s saved tenants, filters, counters, duplicate tracking and relay key after confirmation. Reconnect the relay to start again. Stopping cancels those runs’ queued alerts for the connected provider; delivery history, test notices and inactive providers’ queues are retained. Keep the relay running during reset so monitoring cancellation can be confirmed.

## Monitoring start and recovery alerts

Starting a tenant sends a **Monitoring started** notification through your configured Discord, Teams or email destination. If monitoring is interrupted, a **Monitoring resumed** notification follows the next successful SAP check. It includes the tenant, IST time and the previous interruption reason.

Recovery covers SAP check failures, missed heartbeats (including Chrome closing or computer sleep), and a relay restart. Reopening Chrome or receiving a heartbeat alone does not confirm recovery; a fresh SAP check must succeed. Routine heartbeats and extension reloads do not repeat start alerts. Starting a new run after pressing Stop sends a new start alert. Manual Stop remains silent.

These notifications are saved and retried across relay restarts, and do not increase the popup’s SAP message counters. Update and restart the relay to enable them; the existing extension already supplies the required monitoring updates.

## Keep monitoring running

Keep Chrome, the relay, and your internet connection running, with the laptop lid open. The extension requests that the computer stay awake, but sleep, browser shutdown, or an expired SAP session can interrupt monitoring.

When a SAP check returns HTTP 401, a redirect, or an HTML response that may be a login page, the extension attempts one full reload of that tenant's watchdog tab. If your SSO session can sign you back in automatically, monitoring resumes after the next successful check. Checks continue every minute; a reload alone does not count as recovery. If SAP requires sign-in or MFA, open the watchdog tab and complete it. The extension reports the interruption and reload attempt through the popup and configured alerts. It saves the attempt across Chrome/extension restarts and only allows another automatic reload after a successful SAP check. Filters, counters and duplicate tracking are preserved. Network failures, HTTP 403 permission errors and server errors do not trigger a reload, and tabs that have already left Message Monitoring are left for you to handle.

The relay sends an interruption alert after roughly three minutes without an extension heartbeat, provided it can reach the notification service. Manual **Stop** does not trigger this alert. Immediate alerts are unavailable while the whole computer is offline.

Teams and Discord alerts are queued on disk and retried after network failures, rate limits and server errors. Invalid or unauthorized webhooks pause delivery while retaining queued alerts. The popup's **Messages accepted by relay** count includes queued alerts; check the delivery status for confirmation. Delivery progress refreshes every two seconds while the popup is open. Switching providers leaves the old provider's outbox intact; the popup warns about these inactive queues, including rejected alerts. Connect the original provider to resume it, or explicitly transfer its pending alerts to the new destination. Preserve `.relay-state.json*` files when troubleshooting to avoid losing queued alerts and duplicate tracking. A request accepted remotely but interrupted before the relay saves its receipt can be retried and produce a duplicate notification.

## Troubleshooting and updates

- **Relay unavailable or invalid key:** run `npm start`, check the Terminal for errors, and paste the key from `npm run setup` into the popup. The relay listens at `127.0.0.1:43171`.
- **SAP sign-in or access error:** session errors trigger one automatic watchdog-tab reload. If monitoring still needs attention, open the watchdog tab, sign in again if needed, and return to **Monitor Message Processing**. HTTP 403 requires checking your monitoring permissions or signing in again. Checks retry every minute.
- **Watchdog tab closed:** stop the affected run and start it again from the tenant’s monitor page.
- **Discord delivery paused:** check the popup’s delivery error. For an invalid or deleted webhook, rerun `npm run setup:discord` and restart the relay.
- **Teams delivery paused:** check the popup's delivery error. For an invalid, disabled or deleted webhook, fix/recreate the workflow, rerun `npm run setup:teams` with its new URL and restart the relay. HTTP 401/403 can also mean the workflow requires Microsoft authentication; use the **Anyone** option if your organization permits it.
- **Teams accepted an alert but no channel post appeared:** check the workflow run history for a failed Teams connection, missing channel access or a disabled flow. The relay cannot observe failures after the webhook has accepted the request.
- **After updating the project:** restart the relay and click **Reload** for the extension in `chrome://extensions`. Version **1.8.0** removes the nine-hour limit from existing active runs while preserving their filters, selected statuses, counters, and duplicate tracking. Stopped runs stay stopped. Update both the relay and extension; older extensions retain their original finite windows during the transition.

Version **1.8.1** improves tenant separation and moves relay settings into their own tab. Reload the extension to apply this UI update; no relay restart is needed when upgrading from 1.8.0.

Version **1.9.0** adds Microsoft Teams Workflows delivery, durable retries and Teams delivery status in the popup. Restart the relay and reload the extension after upgrading. Teams setup preserves your existing relay key, so reconnecting is unnecessary if it is already saved.

Version **1.9.1** adds one automatic watchdog-tab reload per SAP session interruption, with recovery verified by a successful SAP check. Click **Reload** for the extension in `chrome://extensions` to apply it. No relay restart is needed when upgrading from 1.9.0.

Version **1.9.2** makes Stop cancel a run’s locally queued Discord and Teams alerts and prevents late handoffs from restarting delivery. The popup warns while relay cancellation is pending. Restart the relay and reload the extension to apply this update. Notifications already accepted by Discord or Teams cannot be recalled.

## Development

Run the automated tests:

```sh
npm test
```
