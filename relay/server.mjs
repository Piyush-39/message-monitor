import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import nodemailer from 'nodemailer';
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
  if (value.kind !== 'failures' || !Array.isArray(value.messages) || !value.messages.length || value.messages.length > 50) throw new Error('Invalid message batch');
  for (const message of value.messages) {
    if (typeof message.id !== 'string' || !/^[\w-]{1,200}$/.test(message.id)) throw new Error('Invalid message ID');
    if (typeof message.flow !== 'string' || message.flow.length > 300 || typeof message.time !== 'string' || message.time.length > 50) throw new Error('Invalid message');
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
    text: `Monitoring cannot currently confirm new failed messages.\n\n${alert.problem}\n\nOpen the watchdog tab and sign in again if needed. Checks will retry every minute until the nine-hour run ends.\n\n${alert.tenant}/shell/monitoring`
  };
  return {
    subject: `IS Watchdog: ${alert.messages.length} new failed message${alert.messages.length === 1 ? '' : 's'} — ${new URL(alert.tenant).hostname}`,
    text: alert.messages.map(message => `Status: FAILED\nFlow: ${message.flow}\nMessage ID: ${message.id}\nTime: ${message.time || 'Unavailable'}\nOpen: ${message.url}`).join('\n\n')
  };
}
async function jsonBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 100000) throw new Error('Request too large');
  }
  return JSON.parse(body);
}
export async function createRelay({token, user, recipient, transport, stateFile = '.relay-state.json', monitorFile = `${stateFile}.monitoring`, now = Date.now}) {
  if (!token || token.length < 32 || !EMAIL.test(user || '') || !EMAIL.test(recipient || '')) throw new Error('Run npm run setup first.');
  let receipts = {};
  try { receipts = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  receipts = Object.fromEntries(Object.entries(receipts).filter(([, time]) => time > cutoff));
  let queue = Promise.resolve();
  function serialize(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  async function deliver(alert) {
    const key = alertKey(alert);
    if (receipts[key]) return {ok: true, duplicate: true};
    const filtered = alert.kind === 'failures' ? {...alert, messages: alert.messages.filter(message =>
      !receipts[`message:${alert.tenant}:${message.id}`] && !(alert.tenant === LEGACY_TENANT && receipts[`message:${message.id}`])
    )} : alert;
    if (filtered.kind === 'failures' && !filtered.messages.length) return {ok: true, duplicate: true};
    const mail = composeEmail(filtered);
    const info = await transport.sendMail({from: user, to: recipient, ...mail});
    if (!info.accepted?.length || info.rejected?.length) throw new Error('Gmail did not accept the recipient');
    receipts[key] = Date.now();
    if (filtered.kind === 'failures') for (const message of filtered.messages) receipts[`message:${alert.tenant}:${message.id}`] = Date.now();
    await writeFile(`${stateFile}.tmp`, JSON.stringify(receipts), {mode: 0o600});
    await rename(`${stateFile}.tmp`, stateFile);
    return {ok: true};
  }
  const monitor = await createMonitoringWatch({stateFile: monitorFile, sendAlert: deliver, now});
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
    if (request.method === 'GET' && request.url === '/health') return reply(200, {ok: true});
    if (request.method !== 'POST' || !['/alert', '/monitor'].includes(request.url)) return reply(404, {error: 'Not found'});
    let alert;
    try { alert = (request.url === '/monitor' ? validateMonitor : validateAlert)(await jsonBody(request)); }
    catch { return reply(400, {error: 'Invalid alert request'}); }
    const result = serialize(() => request.url === '/monitor' ? monitor.receive(alert) : deliver(alert));
    try { return reply(200, await result); }
    catch (error) {
      // Do not log SMTP credentials, message bodies, or provider responses.
      console.error('Email delivery failed:', error.code || 'DELIVERY_ERROR');
      return reply(502, {error: 'Email delivery failed. Check the Gmail app password and relay terminal.'});
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.checkMonitoring = () => serialize(() => monitor.check());
  server.notifyShutdown = () => serialize(() => monitor.shutdown());
  let timer;
  server.once('listening', () => {
    server.checkMonitoring().catch(error => console.error('Monitoring check failed:', error.code || 'MONITOR_ERROR'));
    timer = setInterval(() => server.checkMonitoring().catch(error => console.error('Monitoring check failed:', error.code || 'MONITOR_ERROR')), 30000);
    timer.unref();
  });
  server.once('close', () => clearInterval(timer));
  return server;
}
async function main() {
  const {SMTP_USER: user, SMTP_PASS: pass, ALERT_TO: recipient = user, RELAY_TOKEN: token} = process.env;
  if (!pass || !/^[a-zA-Z0-9]{16}$/.test(pass.replace(/\s/g, ''))) throw new Error('Run npm run setup and supply a Gmail app password.');
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: {user, pass: pass.replace(/\s/g, '')},
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
  });
  // Fail before starting if Gmail login is invalid. This does not send an email.
  await transport.verify();
  const server = await createRelay({token, user, recipient, transport});
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // SIGKILL/power loss cannot run this handler. Persisted leases detect the gap after restart.
    const deadline = setTimeout(() => process.exit(1), 20000);
    deadline.unref();
    server.close();
    server.closeIdleConnections();
    try {await server.notifyShutdown();}
    catch (error) {console.error('Shutdown notice could not be sent:', error.code || 'MONITOR_ERROR');}
    transport.close();
    process.exit(0);
  });
  server.listen(43171, '127.0.0.1', () => console.log(`Email relay ready at http://127.0.0.1:43171. Alerts go to ${recipient}.`));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Relay could not start:', error.code || error.message);
    process.exitCode = 1;
  });
}
