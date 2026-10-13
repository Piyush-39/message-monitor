import { monitorTenant, monitorSelection, isTenantOrigin, monitoringState, DURATION, POLL_ALARM, END_ALARM, endAlarm, unseenMessages, activeRun } from './core.js';
import { readFailedMessages, refreshMessageTable } from './poll.js';
import {readMessageReport} from './report.js';
import {validateReport} from './report-contract.js';

const RELAY = 'http://127.0.0.1:43171';
let state;
let queue = Promise.resolve();
let writes = Promise.resolve();
const reports = new Set();
function serialize(operation) {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
}
function save() {
  // Concurrent tenant checks share state, but storage snapshots must commit in order.
  const snapshot = structuredClone(state);
  const result = writes.then(() => chrome.storage.local.set({state: snapshot}));
  writes = result.catch(() => {});
  return result;
}
async function relay(path, token, body) {
  if (!token) throw new Error('Paste the relay key from npm run setup first.');
  let response;
  try {
    response = await fetch(`${RELAY}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {Authorization: `Bearer ${token}`, ...(body ? {'Content-Type': 'application/json'} : {})},
      ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(20000)
    });
  } catch { throw new Error('Email relay unavailable. Keep npm start running.'); }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Email relay returned HTTP ${response.status}. Restart the updated relay if needed.`);
  }
  return response.json();
}
function heartbeat(run, action = 'heartbeat', status = run.problem ? 'problem' : 'healthy') {
  return relay('/monitor', run.token, {
    action, tenant: run.tenant, run: run.startedAt, endsAt: run.endsAt,
    lastCheck: run.lastCheck, status
  });
}
async function read(run, since) {
  const {tenant, tabId} = run;
  if (!isTenantOrigin(tenant)) throw new Error('Invalid tenant. Stop and start monitoring again.');
  if (!(await chrome.permissions.contains({origins: [`${tenant}/*`]}))) throw new Error('Tenant access missing. Stop and click Start on this tenant to allow access.');
  const tab = await chrome.tabs.get(tabId);
  if (monitorTenant(tab.url) !== tenant) throw new Error('Watchdog tab closed or signed out. Sign in again in this tenant.');
  const result = await chrome.scripting.executeScript({target: {tabId}, world: 'MAIN', func: readFailedMessages, args: [since, tenant, run.scope || {}]});
  if (!Array.isArray(result[0]?.result)) throw new Error(result[0]?.error?.message || 'SAP check failed. Sign in again if the tab shows a login page.');
  return result[0].result;
}
async function report(token, sourceTabId) {
  if (!Number.isInteger(sourceTabId)) throw new Error('Open your IS Monitor Message Processing page first.');
  const source = await chrome.tabs.get(sourceTabId);
  const tenant = monitorTenant(source.url);
  if (!tenant) throw new Error('Open your IS Monitor Message Processing page in this Chrome profile first.');
  const {scope} = monitorSelection(source.url);
  if (reports.has(tenant)) throw new Error('A report for this tenant is already being generated.');
  reports.add(tenant);
  try {
    if (!(await chrome.permissions.contains({origins: [`${tenant}/*`]}))) throw new Error('Tenant access missing. Click Email 24-hour report again and allow access.');
    token ||= (await chrome.storage.local.get('relayToken')).relayToken;
    const health = await relay('/health', token);
    if (health.reports !== true) throw new Error('This relay does not support reports. Update and restart the relay on this device first.');
    const to = Math.floor(Date.now() / 1000) * 1000;
    const from = to - 86400000;
    const result = await chrome.scripting.executeScript({target: {tabId: sourceTabId}, world: 'MAIN', func: readMessageReport, args: [from, to, tenant, scope]});
    const read = result?.find(frame => frame.frameId === 0)?.result ?? result?.[0]?.result;
    if (read?.ok === false && typeof read.error === 'string') throw new Error(read.error);
    if (read?.ok !== true || !Array.isArray(read.flows)) throw new Error('SAP report reader did not return data. Reload the extension and the tenant page, then try again; no report was emailed.');
    const payload = validateReport({tenant, from, to, scope, nonce: crypto.randomUUID(), flows: read.flows});
    await relay('/report', token, payload);
    await chrome.storage.local.set({relayToken: token});
    return {status: `24-hour report accepted by Gmail for ${new URL(tenant).hostname} (${payload.flows.length} iFlows).`};
  } finally {reports.delete(tenant);}
}
async function updateControls() {
  const active = Object.values(state.runs).filter(run => activeRun(run));
  if (active.length) chrome.power.requestKeepAwake('system');
  else chrome.power.releaseKeepAwake();
  const problem = active.some(run => run.problem);
  await chrome.action.setBadgeText({text: problem ? '!' : active.length ? String(active.length) : ''});
  await chrome.action.setBadgeBackgroundColor({color: problem ? '#b3261e' : '#137333'});
  if (active.length || state.pendingStops.length) {
    if (!(await chrome.alarms.get(POLL_ALARM))) await chrome.alarms.create(POLL_ALARM, {periodInMinutes: 1});
  } else await chrome.alarms.clear(POLL_ALARM);
}
async function flushStops() {
  await Promise.all([...state.pendingStops].map(async item => {
    try {
      await relay('/monitor', item.token, {action: 'stop', tenant: item.tenant, run: item.run});
      state.pendingStops = state.pendingStops.filter(pending => pending !== item);
      await save();
    } catch { /* Persist and retry, including after Chrome/relay restart. */ }
  }));
}
async function stop(tenant, reason = 'Stopped') {
  const run = state.runs[tenant];
  if (!run?.running) return {status: reason};
  run.running = false;
  run.status = reason;
  state.pendingStops.push({tenant, run: run.startedAt, token: run.token});
  await save();
  await chrome.alarms.clear(endAlarm(tenant));
  await flushStops();
  await updateControls();
  return {status: reason};
}
async function start(token, sourceTabId) {
  const source = Number.isInteger(sourceTabId) ? await chrome.tabs.get(sourceTabId) : (await chrome.tabs.query({active: true, currentWindow: true}))[0];
  const tenant = monitorTenant(source?.url);
  if (!tenant) throw new Error('Open your IS Monitor Message Processing page in this Chrome profile first.');
  if (activeRun(state.runs[tenant])) throw new Error('This tenant is already running. Other tenants can be added from their monitor tabs.');
  const {filter, scope} = monitorSelection(source.url);
  if (state.runs[tenant]?.running) await stop(tenant, 'Nine-hour run finished');
  await relay('/health', token);
  const baseline = await read({tenant, tabId: source.id, scope}, Date.now() - 60 * 60 * 1000);
  const watchdogFilter = {...filter, status: 'FAILED', time: 'PASTHOUR'};
  const tab = await chrome.tabs.create({url: `${tenant}/shell/monitoring/Messages/${encodeURIComponent(JSON.stringify(watchdogFilter))}`, active: false});
  const startedAt = Date.now();
  const run = {
    running: true, token, tenant, scope, tabId: tab.id, startedAt, endsAt: startedAt + DURATION,
    seen: baseline.map(message => message.id), sent: 0, lastCheck: startedAt,
    status: 'Watching', problem: null, problemEpisode: null
  };
  state.runs[tenant] = run;
  await save();
  try {
    await heartbeat(run, 'start');
    await chrome.alarms.create(endAlarm(tenant), {when: run.endsAt});
    await updateControls();
  } catch (error) {
    await stop(tenant, 'Could not start');
    throw error;
  }
  await chrome.storage.local.set({relayToken: token});
  return {status: 'Watching', tenant};
}
async function tick(run) {
  if (!activeRun(run)) {if (run.running) await stop(run.tenant, 'Nine-hour run finished'); return;}
  try {
    const messages = await read(run, run.startedAt - 5 * 60 * 1000);
    run.lastCheck = Date.now();
    for (let fresh = unseenMessages(messages, run.seen), offset = 0; offset < fresh.length; offset += 50) {
      if (!activeRun(run)) {await stop(run.tenant, 'Nine-hour run finished'); return;}
      const batch = fresh.slice(offset, offset + 50);
      await relay('/alert', run.token, {kind: 'failures', run: run.startedAt, tenant: run.tenant, messages: batch});
      run.seen.push(...batch.map(message => message.id));
      run.sent += batch.length;
      await save();
    }
    if (!activeRun(run)) {await stop(run.tenant, 'Nine-hour run finished'); return;}
    try {
      const refreshed = await chrome.scripting.executeScript({target: {tabId: run.tabId}, world: 'MAIN', func: refreshMessageTable, args: [run.tenant]});
      run.tableRefresh = refreshed[0]?.result === true;
      if (run.tableRefresh) run.lastRefresh = Date.now();
    } catch {run.tableRefresh = false;}
    await heartbeat(run, 'heartbeat', 'healthy');
    run.problem = null;
    run.problemEpisode = null;
    run.status = 'Watching';
    await save();
  } catch (error) {
    const problem = String(error.message || error).slice(0, 400);
    const first = !run.problemEpisode;
    run.problem = problem;
    run.status = 'Needs attention';
    run.problemEpisode ||= {id: Date.now(), sent: false};
    await save();
    if (first) await chrome.notifications.create(`is-watchdog-problem:${run.tenant}`, {
      type: 'basic', iconUrl: 'icon.png', title: `IS monitoring: ${new URL(run.tenant).hostname}`, message: problem
    }).catch(() => {});
    if (!run.problemEpisode.sent) {
      try {
        await relay('/alert', run.token, {kind: 'problem', run: run.startedAt, tenant: run.tenant, episode: run.problemEpisode.id, problem});
        run.problemEpisode.sent = true;
        await save();
      } catch { /* Retry each minute without marking a failed delivery as sent. */ }
    }
    // Problem alerts handle failed SAP checks; the heartbeat detects a silent worker/Chrome stoppage.
    await heartbeat(run).catch(() => {});
  }
}
async function tickAll() {
  const results = await Promise.allSettled([flushStops(), ...Object.values(state.runs).filter(run => run.running).map(tick)]);
  for (const result of results) if (result.status === 'rejected') console.error('Tenant check could not finish:', result.reason?.message);
  await updateControls();
}
function publicState() {
  const runs = Object.values(state.runs).map(({token, seen, ...run}) => ({...run, running: activeRun(run),
    status: run.running && !activeRun(run) ? 'Nine-hour run finished' : run.status}));
  return {runs, activeCount: runs.filter(run => activeRun(run)).length};
}
chrome.alarms.onAlarm.addListener(alarm => {
  serialize(async () => {
    if (alarm.name === POLL_ALARM || alarm.name === END_ALARM) return tickAll();
    if (alarm.name.startsWith(`${END_ALARM}:`)) {
      const tenant = alarm.name.slice(END_ALARM.length + 1);
      // A queued alarm from an older run must not end a newly started run for the same tenant.
      if (state.runs[tenant]?.running && !activeRun(state.runs[tenant])) return stop(tenant, 'Nine-hour run finished');
    }
  }).catch(console.error);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  if (message.type === 'report') {
    // Wait for initialization, then read independently: a large report must not delay polls or Stop.
    queue.then(() => report(message.token, message.sourceTabId))
      .then(value => respond({ok: true, value}), error => respond({ok: false, error: error.message}));
    return true;
  }
  serialize(async () => {
    if (message.type === 'status') return publicState();
    if (message.type === 'start') return start(message.token, message.sourceTabId);
    if (message.type === 'stop') return stop(message.tenant);
    if (message.type === 'open') {
      const run = state.runs[message.tenant];
      if (!activeRun(run)) throw new Error('Start monitoring this tenant first.');
      await chrome.tabs.update(run.tabId, {active: true});
      return {status: 'Watchdog tab opened'};
    }
    if (message.type === 'test') {
      const token = message.token || (await chrome.storage.local.get('relayToken')).relayToken;
      await relay('/alert', token, {kind: 'test', nonce: crypto.randomUUID()});
      await chrome.storage.local.set({relayToken: token});
      return {status: 'Test email accepted by Gmail'};
    }
    throw new Error('Unknown action');
  }).then(value => respond({ok: true, value}), error => respond({ok: false, error: error.message}));
  return true;
});

serialize(async () => {
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  state = monitoringState((await chrome.storage.local.get('state')).state);
  await save();
  await chrome.alarms.clear(END_ALARM); // Retire the single-run alarm after migration.
  for (const run of Object.values(state.runs)) {
    if (activeRun(run)) await chrome.alarms.create(endAlarm(run.tenant), {when: run.endsAt});
    else if (run.running) await stop(run.tenant, 'Nine-hour run finished');
  }
  await updateControls();
}).catch(console.error);
