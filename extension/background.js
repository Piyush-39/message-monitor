import { LEGACY_TENANT, isTenantOrigin, monitorTenant, DURATION, POLL_ALARM, END_ALARM, unseenMessages, activeRun } from './core.js';
import { readFailedMessages, refreshMessageTable } from './poll.js';

const RELAY = 'http://127.0.0.1:43171';
let queue = Promise.resolve();
function serialize(operation) {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
}
async function load() { return (await chrome.storage.local.get('state')).state || {}; }
async function save(state) { await chrome.storage.local.set({ state }); }
async function badge(text, color) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}
async function localNotice(message) {
  await chrome.notifications.create('is-watchdog-problem', {
    type: 'basic', iconUrl: 'icon.png', title: 'IS monitoring needs attention', message
  });
}
async function relay(path, token, body) {
  if (!token) throw new Error('Paste the relay key from npm run setup first.');
  let response;
  try {
    response = await fetch(`${RELAY}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(body ? {'Content-Type': 'application/json'} : {}) },
      ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(20000)
    });
  } catch { throw new Error('Email relay unavailable. Keep npm start running.'); }
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Email relay returned HTTP ${response.status}.`);
  }
  return response.json();
}
async function read(tabId, since, tenant) {
  const tab = await chrome.tabs.get(tabId);
  if (!isTenantOrigin(tenant)) throw new Error('Invalid tenant. Stop and start monitoring again.');
  if (!(await chrome.permissions.contains({origins: [`${tenant}/*`]}))) throw new Error('Tenant access missing. Stop and click Start on the monitor page to allow access.');
  if (monitorTenant(tab.url) !== tenant) throw new Error('Watchdog tab closed or signed out. Sign in again.');
  const result = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', func: readFailedMessages, args: [since, tenant]
  });
  if (!Array.isArray(result[0]?.result)) throw new Error(result[0]?.error?.message || 'SAP check failed. Sign in again if the tab shows a login page.');
  return result[0].result;
}
async function stop(reason = 'Stopped') {
  const state = await load();
  state.running = false;
  state.status = reason;
  await save(state);
  await chrome.alarms.clear(POLL_ALARM);
  await chrome.alarms.clear(END_ALARM);
  chrome.power.releaseKeepAwake();
  await badge('', '#57606a');
  // Keep the tab open so failed-message links and login recovery remain accessible.
}
async function start(token, sourceTabId) {
  const previous = await load();
  if (activeRun(previous)) throw new Error('Already running. Stop before starting another run.');
  const source = Number.isInteger(sourceTabId) ? await chrome.tabs.get(sourceTabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const tenant = monitorTenant(source?.url);
  if (!tenant) throw new Error('Open your IS Monitor Message Processing page in this Chrome profile first.');
  await relay('/health', token);
  const startedAt = Date.now();
  // Baseline existing failures, so Start does not email old messages.
  const baseline = await read(source.id, startedAt - 60 * 60 * 1000, tenant);
  let filter = {};
  try { filter = JSON.parse(decodeURIComponent(new URL(source.url).pathname.split('/Messages/')[1])); } catch { /* A bare monitor URL is valid too. */ }
  // Preserve the active runtime when present; trial tenants may have no runtime selector.
  filter = {...(filter.edge ? {edge: filter.edge} : {}), status: 'FAILED', time: 'PASTHOUR'};
  const tab = await chrome.tabs.create({ url: `${tenant}/shell/monitoring/Messages/${encodeURIComponent(JSON.stringify(filter))}`, active: false });
  const state = {
    running: true, token, tenant, tabId: tab.id, startedAt, endsAt: startedAt + DURATION,
    seen: baseline.map(message => message.id), sent: 0, lastCheck: startedAt,
    status: 'Watching', problem: null, problemEpisode: null
  };
  await save(state);
  chrome.power.requestKeepAwake('system');
  await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
  await chrome.alarms.create(END_ALARM, { when: state.endsAt });
  await badge('ON', '#137333');
  return { status: 'Watching' };
}
async function tick() {
  const state = await load();
  if (!activeRun(state)) { if (state.running) await stop('Nine-hour run finished'); return; }
  try {
    // Read the entire run plus overlap. This also catches late logs and gaps after sleep/login.
    const tenant = state.tenant || LEGACY_TENANT;
    const messages = await read(state.tabId, state.startedAt - 5 * 60 * 1000, tenant);
    state.lastCheck = Date.now();
    const fresh = unseenMessages(messages, state.seen);
    for (let offset = 0; offset < fresh.length; offset += 50) {
      if (Date.now() >= state.endsAt) { await save(state); await stop('Nine-hour run finished'); return; }
      const batch = fresh.slice(offset, offset + 50);
      await relay('/alert', state.token, { kind: 'failures', run: state.startedAt, tenant, messages: batch });
      state.seen.push(...batch.map(message => message.id));
      state.sent += batch.length;
      await save(state); // Only mark sent after the relay has accepted delivery.
    }
    // The UI table has its own cache. Refresh it too, independently of email detection.
    try {
      const refreshed = await chrome.scripting.executeScript({
        target: {tabId: state.tabId}, world: 'MAIN', func: refreshMessageTable, args: [tenant]
      });
      state.tableRefresh = refreshed[0]?.result === true;
      if (state.tableRefresh) state.lastRefresh = Date.now();
    } catch { state.tableRefresh = false; }
    state.problem = null;
    state.problemEpisode = null;
    state.status = 'Watching';
    await save(state);
    await badge('ON', '#137333');
  } catch (error) {
    const problem = String(error.message || error).slice(0, 400);
    const first = !state.problemEpisode;
    state.problem = problem;
    state.status = 'Needs attention';
    state.problemEpisode ||= { id: Date.now(), sent: false };
    await save(state);
    await badge('!', '#b3261e');
    if (first) await localNotice(problem).catch(() => {});
    if (!state.problemEpisode.sent) {
      try {
        await relay('/alert', state.token, {
          kind: 'problem', run: state.startedAt, tenant: state.tenant || LEGACY_TENANT,
          episode: state.problemEpisode.id, problem
        });
        state.problemEpisode.sent = true;
        await save(state);
      } catch { /* Retry next minute; popup and local notification still show the problem. */ }
    }
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  serialize(() => alarm.name === POLL_ALARM ? tick() : alarm.name === END_ALARM ? stop('Nine-hour run finished') : undefined).catch(console.error);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  serialize(async () => {
    if (message.type === 'status') {
      const state = await load();
      const { token, seen, ...publicState } = state;
      return { ...publicState, configured: Boolean(token) };
    }
    if (message.type === 'start') return start(message.token, message.sourceTabId);
    if (message.type === 'stop') return stop();
    if (message.type === 'open') {
      const state = await load();
      if (!activeRun(state)) throw new Error('Start monitoring first.');
      await chrome.tabs.update(state.tabId, {active: true});
      return {status: 'Watchdog tab opened'};
    }
    if (message.type === 'test') {
      const token = message.token || (await load()).token;
      await relay('/alert', token, {kind: 'test', nonce: crypto.randomUUID()});
      await chrome.storage.local.set({ relayToken: token });
      return { status: 'Test email accepted by Gmail' };
    }
    throw new Error('Unknown action');
  }).then(value => respond({ok: true, value}), error => respond({ok: false, error: error.message}));
  return true;
});

// Recreate missing alarms after a Chrome restart or service-worker suspension.
serialize(async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const state = await load();
  if (!activeRun(state)) { if (state.running) await stop('Nine-hour run finished'); return; }
  chrome.power.requestKeepAwake('system');
  if (!(await chrome.alarms.get(POLL_ALARM))) await chrome.alarms.create(POLL_ALARM, {periodInMinutes: 1});
  if (!(await chrome.alarms.get(END_ALARM))) await chrome.alarms.create(END_ALARM, {when: state.endsAt});
}).catch(console.error);
