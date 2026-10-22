import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import nodemailer from 'nodemailer';
import {messageEmail} from './email.mjs';
import {discordConfig, createDiscordDelivery} from './discord.mjs';
import {teamsConfig, createTeamsDelivery} from './teams.mjs';
import { LEGACY_TENANT, isTenantOrigin } from '../extension/core.js';
import {createMonitoringWatch, validateMonitor} from './monitor.mjs';

const EMAIL = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
export function validateAlert(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid alert');
  if (value.kind === 'test') {
    if (typeof value.nonce !== 'string' || value.nonce.length > 100) throw new Error('Invalid test');
    return value;
  }
  if (!isTenantOrigin(value.tenant) || !Number.isSafeInteger(value.run)) throw new Error('Invalid tenant or run');
  if (value.kind === 'problem' || value.kind === 'stopped') {
    if (!Number.isSafeInteger(value.episode) || typeof value.problem !== 'string' || value.problem.length > 400) throw new Error('Invalid problem');
    return value;
  }
  // Accept legacy failure-only extensions during the upgrade as well.
  if (!['messages', 'failures'].includes(value.kind) || !Array.isArray(value.messages) || !value.messages.length || value.messages.length > 50) throw new Error('Invalid message batch');
  for (const message of value.messages) {
    if (value.kind === 'messages' || message.status !== undefined) {
      if (typeof message.status !== 'string' || !/^[A-Z][A-Z0-9_]{0,49}$/.test(message.status) || ['COMPLETED', 'ALL'].includes(message.status)) throw new Error('Invalid message status');
    }
    if (typeof message.id !== 'string' || !/^[\w-]{1,200}$/.test(message.id)) throw new Error('Invalid message ID');
    if (typeof message.flow !== 'string' || message.flow.length > 300 || typeof message.time !== 'string' || message.time.length > 50) throw new Error('Invalid message');
    if (message.errorText !== undefined && (typeof message.errorText !== 'string' || message.errorText.length > 2000)) throw new Error('Invalid error details');
    const url = new URL(message.url);
    if (url.origin !== value.tenant || url.username || url.password || !url.pathname.startsWith('/shell/monitoring/Messages/')) throw new Error('Invalid message link');
  }
  return value;
}
export function alertKey(alert) {
  // Per-message receipts are also stored, so regrouped retries do not re-email sent IDs.
  const identity = alert.kind === 'test' ? alert.nonce : ['problem', 'stopped'].includes(alert.kind) ? [alert.run, alert.episode] : alert.messages.map(message => message.id).sort();
  return createHash('sha256').update(JSON.stringify([alert.kind, alert.tenant, identity])).digest('hex');
}
export function composeEmail(alert) {
  if (alert.kind === 'test') return {subject: 'IS Watchdog: test email', text: 'Your IS Message Watchdog email relay is working.'};
  if (alert.kind === 'stopped') return {
    subject: `IS Watchdog: monitoring stopped — ${new URL(alert.tenant).hostname}`,
    text: `Monitoring was interrupted for ${alert.tenant}.\n\n${alert.problem}\n\nOpen the extension to check this tenant's status. Other tenant runs are independent.\n\n${alert.tenant}/shell/monitoring`
  };
  if (alert.kind === 'problem') return {
    subject: `IS Watchdog: monitoring needs attention — ${new URL(alert.tenant).hostname}`,
    text: `Monitoring cannot currently confirm new non-Completed messages.\n\n${alert.problem}\n\nOpen the watchdog tab and sign in again if needed. Checks retry every minute until you stop monitoring.\n\n${alert.tenant}/shell/monitoring`
  };
  if (alert.messages.length !== 1) throw new Error('Compose one SAP message per email.');
  return messageEmail(alert.tenant, alert.messages[0]);
}
// Allow 50 bounded error excerpts, including multibyte or JSON-escaped text.
async function jsonBody(request, limit = 1000000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
// Inspect inactive providers too: switching providers does not drain their outboxes.
export async function inactiveOutboxes(stateFile, activeProvider) {
  return (await Promise.all(['discord', 'teams'].filter(provider => provider !== activeProvider).map(async provider => {
    try {
      const state = JSON.parse(await readFile(`${stateFile}.${provider}`, 'utf8'));
      if (!state.pending || typeof state.pending !== 'object') throw new Error('Invalid outbox');
      const jobs = Object.values(state.pending);
      return jobs.length ? {provider, pending: jobs.length, failed: jobs.filter(job => job.failed).length} : null;
    } catch (error) {
      return error.code === 'ENOENT' ? null : {provider, error: 'Could not read the inactive notification queue. Check the relay terminal and saved outbox.'};
    }
  }))).filter(Boolean);
}
export async function createRelay({token, user, recipient, transport, stateFile = '.relay-state.json', monitorFile = `${stateFile}.monitoring`, now = Date.now, delivery: configuredDelivery, discordDelivery}) {
  // Keep the previous injected Discord option compatible with existing callers.
  const delivery = configuredDelivery || discordDelivery;
  const deliveryProvider = delivery?.status().provider;
  const deliveryLabel = deliveryProvider === 'teams' ? 'Teams' : 'Discord';
  if (!token || token.length < 32 || (!delivery && (!EMAIL.test(user || '') || !EMAIL.test(recipient || '')))) throw new Error('Run npm run setup first.');
  let receipts = {};
  try { receipts = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  receipts = Object.fromEntries(Object.entries(receipts).filter(([, time]) => time > cutoff));
  let queue = Promise.resolve();
  let monitorQueue = Promise.resolve();
  function serialize(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  async function deliver(alert) {
    const key = alertKey(alert);
    if (receipts[key]) return {ok: true, duplicate: true};
    const isMessageBatch = ['messages', 'failures'].includes(alert.kind);
    if (isMessageBatch && alert.messages.length > 1) {
      // Split older extensions' batches too. Each accepted message persists its own
      // receipt before attempting the next, so a partial failure can safely retry.
      for (const message of alert.messages) await deliver({...alert, messages: [message]});
      return {ok: true};
    }
    const filtered = isMessageBatch ? {...alert, messages: alert.messages.filter(message =>
      !receipts[`message:${alert.tenant}:${message.id}`] && !(alert.tenant === LEGACY_TENANT && receipts[`message:${message.id}`])
    )} : alert;
    if (isMessageBatch && !filtered.messages.length) return {ok: true, duplicate: true};
    if (delivery) {
      // The outbox must be durable before acknowledging this message to Chrome.
      // Queue deduplication also protects a retry if the receipt write below fails.
      await delivery.enqueue(filtered);
    } else {
      const mail = composeEmail(filtered);
      const info = await transport.sendMail({from: user, to: recipient, ...mail});
      if (!info.accepted?.length || info.rejected?.length) throw new Error('Gmail did not accept the recipient');
    }
    receipts[key] = Date.now();
    if (isMessageBatch) for (const message of filtered.messages) receipts[`message:${alert.tenant}:${message.id}`] = Date.now();
    await writeFile(`${stateFile}.tmp`, JSON.stringify(receipts), {mode: 0o600});
    await rename(`${stateFile}.tmp`, stateFile);
    return {ok: true, ...(delivery ? {queued: true, provider: deliveryProvider} : {})};
  }
  const monitor = await createMonitoringWatch({stateFile: monitorFile, sendAlert: alert => serialize(() => deliver(alert)), now});
  function monitorOperation(operation) {
    const result = monitorQueue.then(operation);
    monitorQueue = result.catch(() => {});
    return result;
  }
  const server = http.createServer(async (request, response) => {
    const reply = (code, body) => {
      response.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
      response.end(JSON.stringify(body));
    };
    const origin = request.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return reply(403, {error: 'Extension requests only'});
    if (!/^127\.0\.0\.1:\d+$/.test(request.headers.host || '')) return reply(403, {error: 'Invalid host'});
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type'});
      return response.end();
    }
    const supplied = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, {error: 'Invalid relay key'});
    if (request.method === 'GET' && request.url === '/health') {
      const inactiveDeliveries = await inactiveOutboxes(stateFile, deliveryProvider);
      return reply(200, {ok: true, ...(delivery ? {delivery: delivery.status()} : {}), ...(inactiveDeliveries.length ? {inactiveDeliveries} : {})});
    }
    if (request.method !== 'POST' || !['/alert', '/monitor'].includes(request.url)) return reply(404, {error: 'Not found'});
    let alert;
    try {
      const body = await jsonBody(request);
      alert = (request.url === '/monitor' ? validateMonitor : validateAlert)(body);
    }
    catch { return reply(400, {error: 'Invalid alert request'}); }
    // Heartbeat receipts must not wait behind SMTP/provider delivery or notice retries.
    const result = request.url === '/monitor' ? monitor.receive(alert) : serialize(() => deliver(alert));
    try { return reply(200, await result); }
    catch (error) {
      // Do not log SMTP credentials, message bodies, or provider responses.
      console.error('Notification delivery failed:', error.code || 'DELIVERY_ERROR');
      return reply(502, {error: delivery ? `Could not save the ${deliveryLabel} alert. Check relay disk access and the relay terminal.` : 'Email delivery failed. Check the Gmail app password and relay terminal.'});
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.checkMonitoring = () => monitorOperation(() => monitor.check());
  server.notifyShutdown = () => monitorOperation(() => monitor.shutdown());
  let timer;
  server.once('listening', () => {
    delivery?.start();
    server.checkMonitoring().catch(error => console.error('Monitoring check failed:', error.code || 'MONITOR_ERROR'));
    timer = setInterval(() => server.checkMonitoring().catch(error => console.error('Monitoring check failed:', error.code || 'MONITOR_ERROR')), 30000);
    timer.unref();
  });
  server.once('close', () => {clearInterval(timer); delivery?.stop();});
  return server;
}
async function main() {
  const {SMTP_USER: user, SMTP_PASS: pass, ALERT_TO: recipient = user, RELAY_TOKEN: token} = process.env;
  const provider = process.env.NOTIFICATION_PROVIDER || 'email';
  if (!['email', 'discord', 'teams'].includes(provider)) throw new Error('NOTIFICATION_PROVIDER must be email, discord or teams.');
  let transport, delivery;
  if (provider === 'discord') {
    delivery = await createDiscordDelivery({...discordConfig(process.env), stateFile: '.relay-state.json.discord'});
  } else if (provider === 'teams') {
    delivery = await createTeamsDelivery({...teamsConfig(process.env), stateFile: '.relay-state.json.teams'});
  } else {
    if (!pass || !/^[a-zA-Z0-9]{16}$/.test(pass.replace(/\s/g, ''))) throw new Error('Set SMTP_PASS in .env to your 16-character Gmail app password.');
    transport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: {user, pass: pass.replace(/\s/g, '')},
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
    });
    // Email mode checks login without sending. Webhook modes do not contact Gmail.
    await transport.verify();
  }
  const server = await createRelay({token, user, recipient, transport, delivery});
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // SIGKILL/power loss cannot run this handler. Persisted leases detect the gap after restart.
    const deadline = setTimeout(() => process.exit(1), 20000);
    deadline.unref();
    try {
      await server.notifyShutdown();
      if (delivery) await delivery.flush();
    } catch (error) {console.error('Shutdown notice could not be sent:', error.code || 'MONITOR_ERROR');}
    delivery?.stop();
    server.close();
    server.closeIdleConnections();
    transport?.close();
    process.exit(0);
  });
  server.listen(43171, '127.0.0.1', () => console.log(delivery ? `${provider === 'teams' ? 'Teams' : 'Discord'} relay ready at http://127.0.0.1:43171. All alerts use the configured ${provider === 'teams' ? 'Teams workflow' : 'Discord channel'}.` : `Email relay ready at http://127.0.0.1:43171. Alerts go to ${recipient}.`));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Relay could not start:', error.code || error.message);
    process.exitCode = 1;
  });
}
