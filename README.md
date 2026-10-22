# IS Message Watchdog

A Chrome extension that checks SAP Integration Suite messages every minute until you stop monitoring and sends alerts through a local relay to Discord or Gmail. It uses your signed-in browser session; no SAP API credentials are needed.

Monitor multiple tenants at once, filter by iFlow or package, and choose which statuses trigger alerts. Completed messages are always excluded.

## Requirements

- Node.js 20.12 or later and Chrome 120 or later.
- Access to your tenant’s **Monitor Message Processing** page in Chrome.
- A Discord channel webhook or a Gmail account with an app password.

## Set up notifications

From the project directory, install dependencies:

```sh
npm install
```

Choose one delivery option below.

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

The popup shows the current tenant and a separate bordered card for every monitored tenant, with a consistent color marker, its full hostname, health, last successful check, and accepted-message count. The current tenant has a **Current tab** label. Use the **Relay settings** tab for the full-width key field and connection controls. The tenant list scrolls inside the popup when needed:

- **Open watchdog tab** opens that tenant’s monitoring tab.
- **Details** expands a tenant’s saved filters, alert statuses, activity, and table-refresh time.
- **Edit statuses** expands the active tenant’s checkboxes; **Save alert statuses** applies changes on its next check. Open that tenant’s monitor or watchdog tab before editing its selection.
- **Stop** ends only that tenant’s run. There is no automatic end time. A problem in one tenant does not stop other tenants from checking.

To change iFlow or package filters, stop the run, apply the new filters with **Go**, and start again. Changing filters in the original page does not update an active run.

## Keep monitoring running

Keep Chrome, the relay, and your internet connection running, with the laptop lid open. The extension requests that the computer stay awake, but sleep, browser shutdown, or an expired SAP session can interrupt monitoring.

The relay sends an interruption alert after roughly three minutes without an extension heartbeat, provided it can reach the notification service. Manual **Stop** does not trigger this alert. Immediate alerts are unavailable while the whole computer is offline.

Discord alerts are queued on disk and retried after delivery failures. The popup’s **Messages accepted by relay** count includes queued alerts; check the delivery status for confirmation. Preserve `.relay-state.json*` files when troubleshooting to avoid losing queued alerts and duplicate tracking.

## Troubleshooting and updates

- **Relay unavailable or invalid key:** run `npm start`, check the Terminal for errors, and paste the key from `npm run setup` into the popup. The relay listens at `127.0.0.1:43171`.
- **SAP sign-in or access error:** open the watchdog tab, sign in again if needed, and return to **Monitor Message Processing**. Checks retry every minute.
- **Watchdog tab closed:** stop the affected run and start it again from the tenant’s monitor page.
- **Discord delivery paused:** check the popup’s delivery error. For an invalid or deleted webhook, rerun `npm run setup:discord` and restart the relay.
- **After updating the project:** restart the relay and click **Reload** for the extension in `chrome://extensions`. Version **1.8.0** removes the nine-hour limit from existing active runs while preserving their filters, selected statuses, counters, and duplicate tracking. Stopped runs stay stopped. Update both the relay and extension; older extensions retain their original finite windows during the transition.

Version **1.8.1** improves tenant separation and moves relay settings into their own tab. Reload the extension to apply this UI update; no relay restart is needed when upgrading from 1.8.0.

## Development

Run the automated tests:

```sh
npm test
```
