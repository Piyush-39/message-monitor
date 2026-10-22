import {createWebhookDelivery} from './webhook-delivery.mjs';
const safeText = value => String(value).replace(/([\\`*_~|>\[\]])/g, '\\$1');
const istTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23'
});
function messageTime(value) {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${istTime.format(date)} IST`;
}
export function webhookURL(value) {
  let url;
  try {url = new URL(value);} catch {throw new Error('Enter a valid Discord webhook URL.');}
  if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname) ||
      url.port || url.username || url.password || url.search || url.hash ||
      !/^\/api(?:\/v\d+)?\/webhooks\/\d{10,24}\/[\w-]{20,200}$/.test(url.pathname)) {
    throw new Error('Use an HTTPS Discord webhook URL copied from a text channel, without extra query parameters.');
  }
  return url.href;
}
export function discordConfig(env) {
  return {webhook: webhookURL(env.DISCORD_WEBHOOK_URL)};
}
export async function verifyDiscordWebhook(config, fetcher = fetch) {
  let response;
  try {response = await fetcher(webhookURL(config.webhook), {signal: AbortSignal.timeout(10000), redirect: 'error'});}
  catch {throw new Error('Cannot reach the Discord webhook. Check your connection and webhook configuration.');}
  if (!response.ok) throw new Error(`The Discord webhook returned HTTP ${response.status}. Check or recreate it in Discord.`);
  const info = await response.json().catch(() => null);
  if (info?.type !== 1 || typeof info.channel_id !== 'string') throw new Error('Use a Discord incoming text-channel webhook.');
}
export function discordMessage(alert) {
  const isMessage = ['messages', 'failures'].includes(alert.kind);
  if (isMessage && alert.messages.length !== 1) throw new Error('Send one SAP message per Discord alert.');
  const message = isMessage ? alert.messages[0] : null;
  let embed, content;
  if (message) {
    const status = message.status ?? 'FAILED';
    // Mobile push previews can expose the embed's raw Markdown escapes. Give
    // Discord a separate summary with the original name and no added markup.
    content = `[${status}] ${message.flow || 'Unknown iFlow'}`;
    embed = {
      title: `IS Watchdog · ${status}`,
      description: `**iFlow**\n${safeText(message.flow || 'Unknown iFlow')}\n\n**Error details**\n${safeText(message.errorText || 'Error details unavailable. Open the message in SAP IS.')}`.slice(0, 4096),
      color: status === 'FAILED' ? 0xb91c1c : 0xb45309,
      url: message.url,
      fields: [
        {name: 'Tenant', value: safeText(new URL(alert.tenant).hostname)},
        {name: 'Message ID', value: safeText(message.id)},
        {name: 'Time', value: safeText(messageTime(message.time))}
      ],
      footer: {text: 'Open the title to view this message in SAP IS'}
    };
  } else {
    const title = alert.kind === 'test' ? 'IS Watchdog · test notification' : alert.kind === 'stopped' ? 'IS Watchdog · monitoring stopped' : alert.kind === 'started' ? 'IS Watchdog · monitoring started' : alert.kind === 'resumed' ? 'IS Watchdog · monitoring resumed' : 'IS Watchdog · monitoring needs attention';
    embed = {title, color: ['test', 'started', 'resumed'].includes(alert.kind) ? 0x15803d : 0xb91c1c,
      description: alert.kind === 'test' ? 'Discord delivery is working. SAP alerts will show their status, iFlow, error details and SAP link here.' : safeText(alert.problem),
      ...(alert.tenant ? {url: `${alert.tenant}/shell/monitoring`, fields: [{name: 'Tenant', value: safeText(new URL(alert.tenant).hostname)}]} : {})};
  }
  return {username: 'IS Watchdog', allowed_mentions: {parse: []}, flags: 0, ...(content ? {content} : {}), embeds: [embed]};
}
export function createDiscordDelivery(options) {
  return createWebhookDelivery({...options, webhook: webhookURL(options.webhook),
    provider: 'discord', label: 'Discord', formatMessage: discordMessage,
    requestURL(value) {const url = new URL(value); url.searchParams.set('wait', 'true'); return url.href;},
    isAccepted: (response, body) => response.ok && typeof body?.id === 'string',
    migrate(state) {
      // Preserve old queued alerts and receipts while removing obsolete archive routing.
      if (state.version === 1 && state.pending && state.receipts && state.targets) {
        state = {version: 2, pending: state.pending, receipts: state.receipts,
          destination: state.targets.active || {}, globalUntil: state.globalUntil || 0};
        for (const job of Object.values(state.pending)) {
          delete job.target;
          job.payload.flags = 0;
          for (const embed of job.payload.embeds || []) {
            if (embed.footer) embed.footer.text = 'Open the title to view this message in SAP IS';
          }
        }
      }
      return state;
    }
  });
}
