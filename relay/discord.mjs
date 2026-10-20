import {createHash} from 'node:crypto';
import {readFile, writeFile, rename} from 'node:fs/promises';

const hash = value => createHash('sha256').update(value).digest('hex');
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
    const title = alert.kind === 'test' ? 'IS Watchdog · test notification' : alert.kind === 'stopped' ? 'IS Watchdog · monitoring stopped' : 'IS Watchdog · monitoring needs attention';
    embed = {title, color: alert.kind === 'test' ? 0x15803d : 0xb91c1c,
      description: alert.kind === 'test' ? 'Discord delivery is working. SAP alerts will show their status, iFlow, error details and SAP link here.' : safeText(alert.problem),
      ...(alert.tenant ? {fields: [{name: 'Tenant', value: safeText(new URL(alert.tenant).hostname)}]} : {})};
  }
  return {username: 'IS Watchdog', allowed_mentions: {parse: []}, flags: 0, ...(content ? {content} : {}), embeds: [embed]};
}
const deliveryKey = alert => hash(JSON.stringify(['discord', alert.kind, alert.tenant,
  ['messages', 'failures'].includes(alert.kind) ? alert.messages[0].id : alert.kind === 'test' ? alert.nonce : [alert.run, alert.episode]]));

export async function createDiscordDelivery({webhook, stateFile,
  fetcher = fetch, now = Date.now, autoDispatch = true}) {
  const destinationURL = webhookURL(webhook);
  let state = {version: 2, pending: {}, receipts: {}, destination: {}, globalUntil: 0};
  try {state = JSON.parse(await readFile(stateFile, 'utf8'));}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  // Preserve queued alerts and receipts from the removed two-channel implementation.
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
  if (state.version !== 2 || !state.pending || !state.receipts || !state.destination) throw new Error('Invalid Discord outbox state. Preserve the file and restore it from backup.');
  state.receipts = Object.fromEntries(Object.entries(state.receipts).filter(([, time]) => time > now() - 30 * 86400000));
  if (state.destination.identity !== hash(destinationURL)) state.destination = {identity: hash(destinationURL), nextAt: 0, error: null, blocked: false};
  let writes = Promise.resolve(), pumping, timer, running = false, stopped = false, controller, fatalError = null;
  function change(operation) {
    const result = writes.then(async () => {
      const next = structuredClone(state);
      const value = operation(next);
      await writeFile(`${stateFile}.tmp`, JSON.stringify(next), {mode: 0o600});
      await rename(`${stateFile}.tmp`, stateFile);
      state = next;
      return value;
    });
    writes = result.catch(() => {});
    return result;
  }
  await change(() => {});
  function status() {
    const jobs = Object.values(state.pending);
    return {provider: 'discord', pending: jobs.length,
      delivered: Object.keys(state.receipts).length, failed: jobs.filter(job => job.failed).length, fatalError,
      errors: state.destination.error ? {discord: state.destination.error} : {},
      blocked: state.destination.blocked};
  }
  function dueJob() {
    const eligible = job => !job.failed && !state.destination.blocked &&
      Math.max(state.destination.nextAt, state.globalUntil) <= now();
    const jobs = Object.values(state.pending);
    return jobs.find(job => job.priority && eligible(job)) || jobs.find(eligible);
  }
  function schedule() {
    if (!running || stopped || pumping) return;
    clearTimeout(timer);
    const ready = Object.values(state.pending).filter(job => !job.failed && !state.destination.blocked);
    if (!ready.length) return;
    const next = ready.reduce((earliest, job) => Math.min(earliest, Math.max(state.destination.nextAt, state.globalUntil)), Infinity);
    timer = setTimeout(() => flush().catch(() => {}), Math.min(60000, Math.max(0, next - now())));
    timer.unref();
  }
  async function attempt(job) {
    let response, body;
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const url = new URL(destinationURL); url.searchParams.set('wait', 'true');
      response = await fetcher(url.href, {method: 'POST', redirect: 'error', signal: controller.signal,
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(job.payload)});
      body = await response.json().catch(() => null);
    } catch { /* Persist a retry without exposing the webhook URL or response body. */ }
    finally {clearTimeout(timeout); controller = null;}
    await change(next => {
      const route = next.destination;
      const current = next.pending[job.key];
      if (response?.ok && typeof body?.id === 'string') {
        next.receipts[job.key] = now();
        delete next.pending[job.key];
        route.error = null;
        const reset = Number(response.headers.get('X-RateLimit-Reset-After'));
        route.nextAt = now() + (response.headers.get('X-RateLimit-Remaining') === '0' && Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000) : 100);
      } else if (response?.status === 429) {
        const delay = Number(body?.retry_after ?? response.headers.get('Retry-After') ?? 1);
        const until = now() + (Number.isFinite(delay) ? Math.max(1, delay * 1000) : 1000);
        route.nextAt = until;
        route.error = 'Discord rate limit; waiting to retry.';
        if (body?.global === true || response.headers.get('X-RateLimit-Global') === 'true' || response.headers.get('X-RateLimit-Scope') === 'global') next.globalUntil = until;
      } else if ([401, 403, 404].includes(response?.status)) {
        route.blocked = true;
        route.error = `Discord webhook rejected (HTTP ${response.status}). Recreate the webhook and rerun setup.`;
      } else if (response?.status === 400) {
        current.failed = true;
        route.error = 'Discord rejected an alert format (HTTP 400). The alert is retained locally; update the relay before retrying.';
      } else {
        current.attempts++;
        route.nextAt = now() + Math.min(60000, 1000 * 2 ** Math.min(current.attempts, 6));
        route.error = response ? `Discord delivery failed (HTTP ${response.status}); retrying.` : 'Discord unreachable or delivery unconfirmed; retrying.';
      }
    });
  }
  function flush() {
    if (pumping) return pumping;
    if (stopped || fatalError) return Promise.resolve();
    pumping = (async () => {
      // Work in short passes. Network waits never hold the relay's HTTP/heartbeat lock.
      for (let count = 0; count < 20 && !stopped; count++) {
        const job = dueJob();
        if (!job) break;
        await attempt(job);
      }
    })().catch(async () => {
      // A local write failure must not cause a tight loop resending an accepted message.
      running = false;
      fatalError = 'Discord outbox could not be saved. Check disk access, then restart the relay.';
      throw new Error(fatalError);
    }).finally(() => {pumping = null; schedule();});
    return pumping;
  }
  return {
    status, flush,
    async enqueue(alert) {
      const key = deliveryKey(alert);
      const payload = discordMessage(alert);
      const duplicate = await change(next => {
        if (next.receipts[key] || next.pending[key]) return true;
        next.pending[key] = {key, payload, priority: ['problem', 'stopped'].includes(alert.kind), attempts: 0, acceptedAt: now()};
        return false;
      });
      schedule();
      return {ok: true, queued: !duplicate, duplicate, provider: 'discord'};
    },
    start() {stopped = false; running = autoDispatch; schedule();},
    stop() {stopped = true; running = false; clearTimeout(timer); controller?.abort();}
  };
}
