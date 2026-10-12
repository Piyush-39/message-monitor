import test from 'node:test';
import assert from 'node:assert/strict';
import { TENANT, TRIAL_TENANT, OTHER_TENANTS } from './fixtures.mjs';
import { DURATION, POLL_ALARM, END_ALARM } from '../extension/core.js';

let clock = 1791610000000;
Date.now = () => clock;
let store = {};
let sap = [];
let sapBroken = false;
let emailBroken = false;
let accessGranted = true;
let refreshAvailable = true;
let refreshThrows = false;
const tableClicks = [];
const delivered = [];
const tabs = new Map([[1, {id: 1, url: `${TENANT}/shell/monitoring/Messages/` }]]);
const alarms = new Map();
const notices = [];
let released = 0;
let onMessage;
let onAlarm;
globalThis.location = new URL(TENANT);
globalThis.document = {querySelector(selector) {
  assert.equal(selector, '[role="toolbar"][aria-labelledby~="PanelMessagesTitle"]');
  if (!refreshAvailable) return null;
  return {querySelectorAll() {return [{
    id: 'table-refresh',
    querySelector() {return {getAttribute() {return '\ue010';}};},
    getAttribute() {return null;}, getClientRects() {return [{}];},
    click() {throw new Error('DOM click must not be used for UI5 refresh');}
  }];}};
}};
globalThis.sap = {ui: {getCore() {return {byId(id) {
  assert.equal(id, 'table-refresh');
  return {
    getMetadata() {return {getName() {return 'sap.m.Button';}};},
    getIcon() {return 'sap-icon://refresh';}, getEnabled() {return true;}, hasListeners() {return true;},
    firePress() {if (refreshThrows) throw new Error('UI unavailable'); tableClicks.push(location.origin);}
  };
}};}}};
globalThis.chrome = {
  storage: {local: {
    async get(key) {return {[key]: structuredClone(store[key])};},
    async set(values) {Object.assign(store, structuredClone(values));}, async setAccessLevel() {}
  }},
  tabs: {
    async query() {return [tabs.get(1)];},
    async get(id) {if (!tabs.has(id)) throw new Error('No tab'); return tabs.get(id);},
    async update(id, options) {const tab = await this.get(id); Object.assign(tab, options); return tab;},
    async create(options) {const id = tabs.size + 1; const tab = {id, ...options}; tabs.set(id, tab); return tab;}
  },
  permissions: {async contains({origins}) {assert.equal(origins.length, 1); return accessGranted;}},
  scripting: {async executeScript({func, args, target}) {
    const old = globalThis.location;
    globalThis.location = new URL(tabs.get(target.tabId).url);
    try {return [{result: await func(...args)}];} finally {globalThis.location = old;}
  }},
  alarms: {
    async create(name, options) {alarms.set(name, options);},
    async get(name) {return alarms.get(name);}, async clear(name) {return alarms.delete(name);},
    onAlarm: {addListener(listener) {onAlarm = listener;}}
  },
  action: {async setBadgeText() {}, async setBadgeBackgroundColor() {}},
  power: {requestKeepAwake(level) {assert.equal(level, 'system');}, releaseKeepAwake() {released++;}},
  notifications: {async create(id, notice) {notices.push(notice);}},
  runtime: {id: 'test-extension', onMessage: {addListener(listener) {onMessage = listener;}}}
};
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('http://127.0.0.1:43171')) {
    if (options.body) {
      const alert = JSON.parse(options.body);
      if (emailBroken) return new Response(JSON.stringify({error: 'Email unavailable'}), {status: 502});
      delivered.push(alert);
    }
    return Response.json({ok: true});
  }
  if (sapBroken) return new Response('Login', {headers: {'content-type': 'text/html'}});
  return Response.json({d: {results: sap}});
};
await import('../extension/background.js');
function request(type, token = 'test-relay-token') {
  return new Promise(resolve => onMessage({type, token}, {id: chrome.runtime.id}, resolve));
}
async function poll() {onAlarm({name: POLL_ALARM}); return request('status');}
function message(id) {return {MessageGuid: id, Status: 'FAILED', IntegrationFlowName: 'flow', LogEnd: '/Date(1791610000000)/'};}
async function reset() {
  await request('stop');
  store = {}; sap = []; sapBroken = false; emailBroken = false;
  delivered.length = 0; notices.length = 0; accessGranted = true;
  refreshAvailable = true; refreshThrows = false; tableClicks.length = 0;
  clock += DURATION + 1;
  tabs.set(1, {id: 1, url: `${TENANT}/shell/monitoring/Messages/`});
}
test('start establishes a baseline, schedules nine hours, emails only new failures and stops', async () => {
  await reset();
  sap = [message('old')];
  assert.equal((await request('start')).ok, true);
  assert.equal(delivered.length, 0);
  assert.equal(tableClicks.length, 0);
  assert.equal(alarms.get(POLL_ALARM).periodInMinutes, 1);
  assert.equal(alarms.get(END_ALARM).when, clock + DURATION);
  sap = [message('old'), message('new'), message('new')];
  clock += 60000;
  const checked = await poll();
  assert.equal(checked.value.sent, 1);
  assert.equal(checked.value.lastRefresh, clock);
  assert.equal(checked.value.tableRefresh, true);
  assert.deepEqual(tableClicks, [TENANT]);
  assert.equal(checked.value.token, undefined);
  assert.deepEqual(delivered[0].messages.map(value => value.id), ['new']);
  await poll();
  assert.equal(delivered.length, 1);
  assert.equal((await request('start')).ok, false);
  clock = store.state.endsAt;
  const expired = await poll();
  assert.equal(expired.value.running, false);
  assert.equal(alarms.has(POLL_ALARM), false);
  assert.equal(alarms.has(END_ALARM), false);
  assert.ok(released > 0);
});
test('one problem email per session outage, then catch up after sign-in', async () => {
  await reset();
  await request('start');
  sapBroken = true;
  clock += 60000;
  await poll(); await poll();
  assert.equal(delivered.filter(value => value.kind === 'problem').length, 1);
  assert.equal(notices.length, 1);
  assert.equal(store.state.status, 'Needs attention');
  sapBroken = false;
  sap = [message('missed')];
  const recovered = await poll();
  assert.equal(recovered.value.status, 'Watching');
  assert.equal(recovered.value.sent, 1);
  assert.equal(recovered.value.problem, null);
});
test('failed email is not marked delivered and is retried after relay recovery', async () => {
  await reset();
  await request('start');
  sap = [message('retry-me')];
  emailBroken = true;
  await poll();
  assert.equal(store.state.seen.includes('retry-me'), false);
  emailBroken = false;
  await poll();
  assert.equal(store.state.seen.includes('retry-me'), true);
  assert.equal(store.state.sent, 1);
  await poll();
  assert.equal(delivered.filter(value => value.kind === 'failures').length, 1);
});
test('test email and manual stop are handled through popup actions', async () => {
  await reset();
  assert.equal((await request('test')).ok, true);
  assert.equal(delivered[0].kind, 'test');
  await request('start');
  await request('stop');
  await poll();
  assert.equal(store.state.running, false);
  assert.equal(delivered.length, 1);
});
test('start on a trial tenant captures that origin for its tab, reader, and email', async () => {
  await reset();
  tabs.set(1, {id: 1, url: `${TRIAL_TENANT}/shell/monitoring/Messages/%7B%22status%22%3A%22ALL%22%7D`});
  assert.equal((await request('start')).ok, true);
  assert.equal(store.state.tenant, TRIAL_TENANT);
  const created = tabs.get(store.state.tabId);
  assert.ok(created.url.startsWith(TRIAL_TENANT));
  assert.equal(JSON.parse(decodeURIComponent(created.url.split('/Messages/')[1])).edge, undefined);
  sap = [message('trial-failure')];
  await poll();
  assert.equal(delivered[0].tenant, TRIAL_TENANT);
  assert.ok(delivered[0].messages[0].url.startsWith(TRIAL_TENANT));
  assert.equal(store.state.sent, 1);
});

test('start and failure alerts work for previously unknown regional and custom tenants', async () => {
  for (const tenant of OTHER_TENANTS) {
    await reset();
    tabs.set(1, {id: 1, url: `${tenant}/shell/monitoring/Messages/%7B%22edge%22%3A%22runtime-a%22%7D`});
    assert.equal((await request('start')).ok, true);
    assert.equal(store.state.tenant, tenant);
    const tab = tabs.get(store.state.tabId);
    assert.equal(JSON.parse(decodeURIComponent(tab.url.split('/Messages/')[1])).edge, 'runtime-a');
    sap = [message('generic-failure')];
    await poll();
    assert.equal(delivered[0].tenant, tenant);
    assert.ok(delivered[0].messages[0].url.startsWith(tenant));
    tabs.set(store.state.tabId, {...tab, url: `${TRIAL_TENANT}/shell/monitoring/Messages/`});
    await poll();
    assert.equal(store.state.status, 'Needs attention');
    assert.equal(delivered.filter(value => value.kind === 'failures').length, 1);
  }
});
test('missing/revoked tenant access prevents start and pauses an existing run', async () => {
  await reset();
  accessGranted = false;
  const denied = await request('start');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /Tenant access missing/);
  assert.equal(store.state?.running, undefined);
  accessGranted = true;
  await request('start');
  accessGranted = false;
  await poll();
  assert.equal(store.state.status, 'Needs attention');
  assert.equal(store.state.sent, 0);
  assert.equal(delivered[0].kind, 'problem');
});
test('missing or broken table refresh does not prevent fresh API checks or failure emails', async () => {
  for (const broken of ['missing', 'throw']) {
    await reset();
    await request('start');
    refreshAvailable = broken !== 'missing';
    refreshThrows = broken === 'throw';
    sap = [message(`fresh-${broken}`)];
    await poll();
    assert.equal(store.state.status, 'Watching');
    assert.equal(store.state.tableRefresh, false);
    assert.equal(store.state.sent, 1);
    assert.equal(delivered[0].kind, 'failures');
    assert.equal(store.state.lastCheck, clock);
  }
});
test('Open watchdog tab selects the actual monitored tab, and is unavailable after Stop', async () => {
  await reset();
  await request('start');
  assert.equal((await request('open')).ok, true);
  assert.equal(tabs.get(store.state.tabId).active, true);
  await request('stop');
  assert.equal((await request('open')).ok, false);
});
