import {createWebhookDelivery} from './webhook-delivery.mjs';

const invalidWebhook = () => new Error('Use the full HTTPS Teams Workflows webhook URL copied after saving, including its signature.');
export function teamsWebhookURL(value) {
  let url;
  try {url = new URL(value);} catch {throw invalidWebhook();}
  const modernHost = /^[a-z0-9-]+\.[a-z0-9-]+\.environment\.api\.powerplatform\.com$/i.test(url.hostname);
  const legacyHost = /^[a-z0-9.-]+\.logic\.azure\.com$/i.test(url.hostname);
  const modernPath = /^\/powerautomate\/automations\/direct\/(?:[a-z0-9-]+\/){0,3}workflows\/[a-f0-9]{32}\/triggers\/manual\/paths\/invoke$/i.test(url.pathname);
  const legacyPath = /^\/workflows\/[a-f0-9]{32}\/triggers\/manual\/paths\/invoke$/i.test(url.pathname);
  if (typeof value !== 'string' || /\s/.test(value) || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
      !(modernHost && modernPath || legacyHost && legacyPath) ||
      !url.searchParams.get('api-version') || !url.searchParams.get('sig') ||
      [...url.searchParams.keys()].some(key => !['api-version', 'sp', 'sv', 'sig'].includes(key) || url.searchParams.getAll(key).length !== 1)) {
    throw invalidWebhook();
  }
  return url.href;
}

export function teamsConfig(env) {
  return {webhook: teamsWebhookURL(env.TEAMS_WEBHOOK_URL)};
}

const istTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23'
});
function messageTime(value) {
  if (!value) return 'Unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${istTime.format(date)} IST`;
}
// TextBlock supports Markdown. Escape SAP text and omit mention entities entirely.
const safeText = value => String(value).replace(/([\\`*_~|>\[\]])/g, '\\$1');
const textBlock = (text, extra = {}) => ({type: 'TextBlock', text: safeText(text), wrap: true, ...extra});

export function teamsMessage(alert) {
  const isMessage = ['messages', 'failures'].includes(alert.kind);
  if (isMessage && alert.messages.length !== 1) throw new Error('Send one SAP message per Teams alert.');
  const message = isMessage ? alert.messages[0] : null;
  let title, body, link;
  if (message) {
    const status = message.status ?? 'FAILED';
    title = `IS Watchdog · ${status}`;
    body = [textBlock(title, {size: 'Large', weight: 'Bolder', color: status === 'FAILED' ? 'Attention' : 'Warning'}),
      textBlock('iFlow', {weight: 'Bolder'}), textBlock(message.flow || 'Unknown iFlow'),
      textBlock('Error details', {weight: 'Bolder'}),
      textBlock(message.errorText || 'Error details unavailable. Open the message in SAP IS.'),
      {type: 'FactSet', facts: [
        {title: 'Tenant', value: safeText(new URL(alert.tenant).hostname)},
        {title: 'Message ID', value: safeText(message.id)},
        {title: 'Time', value: safeText(messageTime(message.time))}
      ]}];
    link = message.url;
  } else {
    title = alert.kind === 'test' ? 'IS Watchdog · test notification' : alert.kind === 'stopped' ? 'IS Watchdog · monitoring stopped' : 'IS Watchdog · monitoring needs attention';
    body = [textBlock(title, {size: 'Large', weight: 'Bolder', color: alert.kind === 'test' ? 'Good' : 'Attention'}),
      textBlock(alert.kind === 'test' ? 'Teams delivery is working. SAP alerts will show their status, iFlow, error details and SAP link here.' : alert.problem)];
    if (alert.tenant) {
      body.push(textBlock(`Tenant: ${new URL(alert.tenant).hostname}`));
      link = `${alert.tenant}/shell/monitoring`;
    }
  }
  return {type: 'message', attachments: [{contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null,
    content: {$schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.2',
      body, ...(link ? {actions: [{type: 'Action.OpenUrl', title: 'Open in SAP IS', url: link}]} : {})}}]};
}

export function createTeamsDelivery(options) {
  return createWebhookDelivery({...options, webhook: teamsWebhookURL(options.webhook),
    provider: 'teams', label: 'Teams', formatMessage: teamsMessage, spacing: 1000,
    // Workflows return 202 with no message ID. This confirms workflow acceptance,
    // not the downstream Teams action; surface that distinction in the popup.
    isAccepted: response => response.ok});
}
