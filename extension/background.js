import { monitorTenant, monitorSelection, isTenantOrigin, monitoringState, emailStatuses, POLL_ALARM, HEARTBEAT_ALARM, END_ALARM, endAlarm, unseenMessages, activeRun } from './core.js';
import { readNonCompletedMessages, readMessageErrors, refreshMessageTable } from './poll.js';

const RELAY = 'http://127.0.0.1:43171';
let state;
let queue = Promise.resolve();
let writes = Promise.resolve();
const heartbeatTasks = new Map();
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
      ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(path === '/health' ? 3000 : 20000)
    });
  } catch { throw new Error('Notification relay unavailable. Keep npm start running.'); }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Notification relay returned HTTP ${response.status}. Restart the updated relay if needed.`);
  }
  return response.json();
}
function heartbeat(run, action = 'heartbeat', status = run.problem ? 'problem' : 'healthy') {
  return relay('/monitor', run.token, {
    action, tenant: run.tenant, run: run.startedAt, endsAt: run.endsAt,
    lastCheck: run.lastCheck, status, phase: run.phase || 'Waiting for next check', problem: status === 'problem' ? run.problem : null
  });
}
async function read(run, since) {
  const {tenant, tabId} = run;
  if (!isTenantOrigin(tenant)) throw new Error('Invalid tenant. Stop and start monitoring again.');
  if (!(await chrome.permissions.contains({origins: [`${tenant}/*`]}))) throw new Error('Tenant access missing. Stop and click Start on this tenant to allow access.');
  let tab;
  try {tab = await chrome.tabs.get(tabId);}
  catch {throw new Error('The watchdog tab was closed or is no longer available. Open Message Monitoring and Stop/Start this tenant to create a new watchdog tab.');}
  if (monitorTenant(tab.url) !== tenant) throw new Error('The watchdog tab left Message Monitoring or was redirected to sign-in. Return that tab to this tenant’s Message Monitoring page after signing in; checks retry every minute.');
  if (tab.discarded) throw new Error('Chrome unloaded the watchdog tab to save memory. Open that tab to load Message Monitoring again; checks retry every minute.');
  let result;
  try {result = await chrome.scripting.executeScript({target: {tabId}, world: 'MAIN', func: readNonCompletedMessages, args: [since, tenant, run.scope || {}, emailStatuses(run.emailStatuses), true]});}
  catch {throw new Error('Chrome could not run the SAP check in the watchdog tab. It may be reloading or inaccessible. Open that Message Monitoring tab; checks retry every minute.');}
  const response = result[0]?.result;
  if (response?.ok === false) throw new Error(response.error);
  if (!response?.ok || !Array.isArray(response.messages)) throw new Error('The watchdog tab did not return a SAP check result. It may have reloaded during the check. Checks retry every minute.');
  return response.messages;
}
async function withErrorDetails(run, messages) {
  let errors;
  try {
    const result = await chrome.scripting.executeScript({target: {tabId: run.tabId}, world: 'MAIN', func: readMessageErrors,
      args: [messages.map(({id, status}) => ({id, status})), run.tenant]});
    const values = result[0]?.result;
    if (Array.isArray(values) && values.length === messages.length && values.every(value => typeof value === 'string' && value.length <= 2000)) errors = values;
  } catch { /* A missing detail response must not block the message email. */ }
  return messages.map((message, index) => ({...message,
    errorText: errors?.[index] || 'Error details unavailable. Open the message in IS for details.'}));
}
async function updateControls() {
  const active = Object.values(state.runs).filter(run => activeRun(run));
  if (active.length) chrome.power.requestKeepAwake('system');
  else chrome.power.releaseKeepAwake();
  const problem = active.some(run => run.problem);
  if (active.length) {
    if (!(await chrome.alarms.get(HEARTBEAT_ALARM))) await chrome.alarms.create(HEARTBEAT_ALARM, {periodInMinutes: 1});
  } else await chrome.alarms.clear(HEARTBEAT_ALARM);
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
async function stop(tenant, reason = 'Stopped by you') {
  const run = state.runs[tenant];
  if (!run?.running) return {status: reason};
  run.running = false;
  run.status = reason;
  run.phase = reason;
  state.pendingStops.push({tenant, run: run.startedAt, token: run.token});
  await save();
  await chrome.alarms.clear(endAlarm(tenant));
  // An already-sent heartbeat must finish before cancellation, or it could rearm the relay.
  await heartbeatTasks.get(tenant)?.catch(() => {});
  if (run.restoreAutoDiscardable) await chrome.tabs.update(run.tabId, {autoDiscardable: true}).catch(() => {});
  await flushStops();
  await updateControls();
  return {status: reason};
}
async function start(token, sourceTabId, selectedStatuses) {
  const statuses = emailStatuses(selectedStatuses);
  const source = Number.isInteger(sourceTabId) ? await chrome.tabs.get(sourceTabId) : (await chrome.tabs.query({active: true, currentWindow: true}))[0];
  const tenant = monitorTenant(source?.url);
  if (!tenant) throw new Error('Open your IS Monitor Message Processing page in this Chrome profile first.');
  if (activeRun(state.runs[tenant])) throw new Error('This tenant is already running. Other tenants can be added from their monitor tabs.');
  const {filter, scope} = monitorSelection(source.url);
  await relay('/health', token);
  const baseline = await read({tenant, tabId: source.id, scope, emailStatuses: statuses}, Date.now() - 60 * 60 * 1000);
  const watchdogFilter = {...filter, status: 'ALL', time: 'PASTHOUR'};
  const tab = await chrome.tabs.create({url: `${tenant}/shell/monitoring/Messages/${encodeURIComponent(JSON.stringify(watchdogFilter))}`, active: false});
  const restoreAutoDiscardable = tab.autoDiscardable !== false;
  await chrome.tabs.update(tab.id, {autoDiscardable: false});
  const startedAt = Date.now();
  const run = {
    running: true, token, tenant, scope, emailStatuses: statuses, tabId: tab.id, startedAt, endsAt: null,
    seen: baseline.map(message => message.id), sent: 0, lastCheck: startedAt,
    status: 'Watching', phase: 'Waiting for next check', problem: null, problemEpisode: null, restoreAutoDiscardable
  };
  state.runs[tenant] = run;
  await save();
  try {
    await heartbeat(run, 'start');
    await updateControls();
  } catch (error) {
    run.problem = String(error.message || error).slice(0, 400);
    await stop(tenant, 'Could not start');
    throw error;
  }
  await chrome.storage.local.set({relayToken: token});
  return {status: 'Watching', tenant};
}
async function tick(run) {
  if (!activeRun(run)) return;
  try {
    const deadline = Date.now() + 45000;
    run.phase = 'Reading SAP messages';
    const messages = await read(run, run.startedAt - 5 * 60 * 1000);
    run.lastCheck = Date.now();
    // Keep UI/session activity ahead of potentially slow notification delivery.
    try {
      const refreshed = await chrome.scripting.executeScript({target: {tabId: run.tabId}, world: 'MAIN', func: refreshMessageTable, args: [run.tenant]});
      run.tableRefresh = refreshed[0]?.result === true;
      if (run.tableRefresh) run.lastRefresh = Date.now();
    } catch {run.tableRefresh = false;}
    const fresh = unseenMessages(messages, run.seen);
    run.pendingAlerts = fresh.length;
    delivery: for (let offset = 0; offset < fresh.length; offset += 50) {
      if (Date.now() >= deadline) break;
      if (!activeRun(run)) return;
      run.phase = 'Reading SAP error details';
      const batch = await withErrorDetails(run, fresh.slice(offset, offset + 50));
      if (!activeRun(run)) return;
      // Gmail filters the entire email, so unrelated SAP messages must never share one.
      for (const message of batch) {
        if (Date.now() >= deadline) break delivery;
        if (!activeRun(run)) return;
        run.phase = 'Handing message alerts to notification relay';
        await relay('/alert', run.token, {kind: 'messages', run: run.startedAt, tenant: run.tenant, messages: [message]});
        run.seen.push(message.id);
        run.sent++;
        run.pendingAlerts--;
        await save();
      }
    }
    if (!activeRun(run)) return;
    run.phase = 'Waiting for next check';
    await heartbeat(run, 'heartbeat', 'healthy');
    run.problem = null;
    run.problemEpisode = null;
    run.status = 'Watching';
    await save();
  } catch (error) {await reportProblem(run, error);}
}
async function reportProblem(run, error) {
  const problem = String(error.message || error).slice(0, 400);
  const first = !run.problemEpisode || run.problem !== problem;
  run.problem = problem;
  run.status = 'Needs attention';
  if (first) run.problemEpisode = {id: Math.max(Date.now(), (run.problemEpisode?.id || 0) + 1), sent: false};
  const episode = run.problemEpisode;
  await save();
  // Record the known cause before attempting potentially slow alert delivery.
  await heartbeat(run).catch(() => {});
  if (first) await chrome.notifications.create(`is-watchdog-problem:${run.tenant}`, {
    type: 'basic', iconUrl: 'icon.png', title: `IS monitoring: ${new URL(run.tenant).hostname}`, message: problem
  }).catch(() => {});
  if (!episode.sent) {
    try {
      await relay('/alert', run.token, {kind: 'problem', run: run.startedAt, tenant: run.tenant, episode: episode.id, problem});
      episode.sent = true;
      await save();
    } catch { /* Retry each minute without marking a failed delivery as sent. */ }
  }
}
async function tickAll() {
  const results = await Promise.allSettled([flushStops(), ...Object.values(state.runs).filter(run => run.running).map(tick)]);
  for (const result of results) if (result.status === 'rejected') console.error('Tenant check could not finish:', result.reason?.message);
  await updateControls();
}
function publicState() {
  const runs = Object.values(state.runs).map(({token, seen, ...run}) => ({...run, running: activeRun(run),
    emailStatuses: emailStatuses(run.emailStatuses),
    status: run.status}));
  return {runs, activeCount: runs.filter(run => activeRun(run)).length};
}
chrome.alarms.onAlarm.addListener(alarm => {
  // Do not queue heartbeat behind SAP reads, error lookups or notification handoffs.
  if (alarm.name === HEARTBEAT_ALARM) {
    if (state) for (const run of Object.values(state.runs).filter(run => activeRun(run))) {
      if (heartbeatTasks.has(run.tenant)) continue;
      const task = (async () => {
        // A responsive worker does not prove SAP polling is still making progress.
        if (Date.now() - run.lastCheck >= 180000 && !run.problem) {
          await reportProblem(run, new Error(`No SAP check has succeeded for at least three minutes, although the extension is responding. Last activity: ${run.phase || 'not recorded'}. Open the watchdog Message Monitoring tab and check the relay. Session expiry is not confirmed.`));
        } else if (run.problemEpisode && !run.problemEpisode.sent) await reportProblem(run, new Error(run.problem));
        else await heartbeat(run);
      })().catch(() => {}).finally(() => heartbeatTasks.delete(run.tenant));
      heartbeatTasks.set(run.tenant, task);
    }
    return;
  }
  serialize(async () => {
    if (alarm.name === POLL_ALARM) return tickAll();
    // Ignore end alarms already queued by an earlier extension version.
  }).catch(console.error);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  serialize(async () => {
    if (message.type === 'status') {
      const summary = publicState();
      summary.relay = {connected: false, error: 'Add your notification relay key in Relay settings.'};
      const token = message.token || (await chrome.storage.local.get('relayToken')).relayToken || Object.values(state.runs)[0]?.token;
      if (token) {
        try {
          const health = await relay('/health', token);
          summary.relay = {connected: true};
          if (health.delivery?.provider === 'discord') summary.delivery = health.delivery;
        } catch (error) {
          summary.relay = {connected: false, error: error.message};
          summary.delivery = {error: error.message};
        }
      }
      return summary;
    }
    if (message.type === 'start') return start(message.token, message.sourceTabId, message.emailStatuses);
    if (message.type === 'connect') {
      await relay('/health', message.token);
      await chrome.storage.local.set({relayToken: message.token});
      return {status: 'Notification relay connected. Key saved.'};
    }
    if (message.type === 'updateStatuses') {
      const run = state.runs[message.tenant];
      if (!activeRun(run)) throw new Error('Start monitoring this tenant first.');
      run.emailStatuses = emailStatuses(message.emailStatuses);
      await save();
      return {status: 'Notification statuses saved. They apply from the next check.'};
    }
    if (message.type === 'stop') return stop(message.tenant);
    if (message.type === 'open') {
      const run = state.runs[message.tenant];
      if (!activeRun(run)) throw new Error('Start monitoring this tenant first.');
      await chrome.tabs.update(run.tabId, {active: true});
      return {status: 'Watchdog tab opened'};
    }
    if (message.type === 'test') {
      const token = message.token || (await chrome.storage.local.get('relayToken')).relayToken;
      const delivery = await relay('/alert', token, {kind: 'test', nonce: crypto.randomUUID()});
      await chrome.storage.local.set({relayToken: token});
      return {status: delivery.provider === 'discord' ? 'Test notification queued for Discord. Check your alerts channel and relay delivery status.' : 'Test notification accepted by Gmail'};
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
    await chrome.alarms.clear(endAlarm(run.tenant));
    if (activeRun(run)) {
      try {
        const tab = await chrome.tabs.get(run.tabId);
        if (monitorTenant(tab.url) === run.tenant) {
          run.restoreAutoDiscardable ??= tab.autoDiscardable !== false;
          await chrome.tabs.update(run.tabId, {autoDiscardable: false});
        }
      } catch { /* The next poll reports the missing tab with its recovery steps. */ }
      // Migrate relay deadlines without holding up the popup or other tenants.
      const task = heartbeat(run).catch(() => {}).finally(() => heartbeatTasks.delete(run.tenant));
      heartbeatTasks.set(run.tenant, task);
    }
  }
  await save();
  await updateControls();
}).catch(console.error);
