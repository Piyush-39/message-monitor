import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {TENANT, TRIAL_TENANT} from './fixtures.mjs';
import {EMAIL_STATUSES} from '../extension/core.js';

let generation = 0;
const flatten = node => [node, ...node.children.flatMap(flatten)];
const text = node => [node.textContent, ...node.children.map(text)].join('\n');
async function popupHarness({url = `${TENANT}/shell/monitoring/Messages/`, savedToken = 'local-test-key', state = {runs: [], activeCount: 0, relay: {connected: true}}} = {}) {
  function element(tag, id) {
    return {tag, id, disabled: false, hidden: false, value: '', textContent: '', children: [], attributes: {},
      append(...nodes) {this.children.push(...nodes);}, replaceChildren(...nodes) {this.children = nodes;},
      setAttribute(name, value) {this.attributes[name] = value;},
      addEventListener(event, handler) {this[event] = handler;}
    };
  }
  const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  const elements = Object.fromEntries([...html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)].map(([, tag, id]) => [id, element(tag, id)]));
  elements.token.type = 'password';
  const previous = {document: globalThis.document, chrome: globalThis.chrome};
  globalThis.document = {
    querySelector(selector) {return elements[selector.slice(1)];}, createElement: tag => element(tag),
    querySelectorAll() {return [...Object.values(elements), ...flatten(elements.runs)].filter(node => node.tag === 'button');}
  };
  const calls = [];
  let granted = true, changed;
  globalThis.chrome = {
    tabs: {async query() {return [{id: 42, url}];}},
    permissions: {async request(value) {calls.push({permission: value}); return granted;}},
    storage: {local: {async get() {return {relayToken: savedToken};}}, onChanged: {addListener(handler) {changed = handler;}}},
    runtime: {async sendMessage(message) {
      calls.push({message});
      if (message.type === 'start') state.runs.push({tenant: TENANT, running: true, status: 'Watching', endsAt: null, sent: 0, emailStatuses: message.emailStatuses});
      if (message.type === 'updateStatuses') state.runs.find(run => run.tenant === message.tenant).emailStatuses = message.emailStatuses;
      if (message.type === 'stop') state.runs.find(run => run.tenant === message.tenant).running = false;
      if (message.type === 'connect') {savedToken = message.token; state.relay = {connected: true};}
      state.activeCount = state.runs.filter(run => run.running).length;
      if (message.type === 'status') return {ok: true, value: state};
      return {ok: true, value: {status: message.type === 'test' ? 'Test queued' : 'Saved'}};
    }}
  };
  const load = () => import(`../extension/popup.js?test=${++generation}`);
  await load();
  const inputs = () => flatten(elements['status-options']).filter(node => node.tag === 'input');
  return {elements, calls, state, inputs, load,
    choose(statuses) {inputs().forEach(input => {input.checked = statuses.includes(input.value);}); inputs()[0].change();},
    grant(value) {granted = value;}, changed,
    close() {Object.assign(globalThis, previous);}
  };
}

test('popup starts a second tenant, persists selections and targets independent Open/Stop controls', async () => {
  const initial = {tenant: TRIAL_TENANT, running: true, status: 'Watching', endsAt: null, sent: 3,
    scope: {artifactIds: ['flow-a', 'flow-b'], packageId: 'package-a'}, emailStatuses: ['ESCALATED']};
  const h = await popupHarness({state: {runs: [initial], activeCount: 1, relay: {connected: true}}});
  try {
    const {elements: e, calls, state} = h;
    assert.deepEqual(h.inputs().filter(input => input.checked).map(input => input.value), EMAIL_STATUSES);
    assert.equal(e.start.disabled, false);
    h.choose([]); calls.length = 0;
    assert.equal(e.start.disabled, true);
    await e.start.click();
    assert.match(e.status.textContent, /Select at least one/);
    assert.equal(calls.some(call => call.permission || call.message?.type === 'start'), false);
    h.choose(['FAILED', 'RETRY']); h.grant(false); calls.length = 0;
    await e.start.click();
    assert.deepEqual(calls[0], {permission: {origins: [`${TENANT}/*`]}});
    assert.equal(calls.some(call => call.message?.type === 'start'), false);
    assert.match(e.status.textContent, /access was declined/);
    h.grant(true); calls.length = 0;
    await e.start.click();
    assert.deepEqual(calls[1].message, {type: 'start', token: 'local-test-key', sourceTabId: 42, emailStatuses: ['FAILED', 'RETRY']});
    assert.equal(e.start.hidden, true);
    assert.equal(e['status-editor'].hidden, true);
    assert.equal(e['status-summary'].hidden, false);
    assert.equal(e.runs.children.length, 2);
    assert.equal(e['active-count'].textContent, '2 active');
    const firstCard = e.runs.children[0];
    assert.match(firstCard.className, /tenant-color-\d/);
    assert.match(e.runs.children[1].className, /current-tenant/);
    assert.ok(text(firstCard).includes(new URL(TRIAL_TENANT).hostname));
    assert.match(text(firstCard), /Monitoring: 2 selected iFlows\nPackage: package-a/);
    assert.match(text(firstCard), /Alert statuses: Escalated/);
    assert.doesNotMatch(text(firstCard), /flow-a|flow-b|Ends:/);
    assert.match(text(firstCard), /No time limit/);
    const details = flatten(firstCard).find(node => node.textContent === 'Details ▾');
    await details.click();
    assert.equal(details.attributes['aria-expanded'], 'true');
    await e['edit-statuses'].click();
    assert.equal(e['status-editor'].hidden, false);
    h.choose(['PROCESSING']); calls.length = 0;
    await e.start.click();
    assert.deepEqual(calls[0].message, {type: 'updateStatuses', token: 'local-test-key', tenant: TENANT, emailStatuses: ['PROCESSING']});
    assert.equal(calls.some(call => call.permission), false);
    assert.equal(e['status-editor'].hidden, true);
    assert.match(text(e.runs.children[1]), /Alert statuses: Processing/);
    assert.deepEqual(initial.emailStatuses, ['ESCALATED']);
    assert.equal(flatten(e.runs.children[0]).find(node => node.textContent === 'Details ▴').attributes['aria-expanded'], 'true');
    e['status-options'].children = [];
    await h.load();
    assert.deepEqual(h.inputs().filter(input => input.checked).map(input => input.value), ['PROCESSING']);
    initial.scope = {artifactIds: ['only-flow', 'only-flow'], packageId: null};
    state.delivery = {provider: 'discord', pending: 3, delivered: 8, errors: {discord: 'Discord rate limit; waiting to retry.'}};
    await e.test.click();
    assert.equal(e.runs.children[0].className, firstCard.className);
    assert.match(e['delivery-status'].textContent, /Discord · 3 queued/);
    assert.match(e['delivery-status'].textContent, /Discord rate limit/);
    assert.match(text(e.runs.children[0]), /Monitoring: 1 selected iFlow\n/);
    assert.doesNotMatch(text(e.runs.children[0]), /only-flow/);
    initial.scope = {artifactIds: [], packageId: 'package-a'};
    await e.test.click();
    assert.match(text(e.runs.children[0]), /Monitoring: All iFlows in the selected package/);
    const open = flatten(e.runs.children[0]).find(node => node.textContent === 'Open watchdog tab ↗');
    calls.length = 0; await open.click();
    assert.equal(calls[0].message.tenant, TRIAL_TENANT);
    const stop = flatten(e.runs.children[0]).find(node => node.textContent === 'Stop');
    calls.length = 0; await stop.click();
    assert.equal(calls[0].message.tenant, TRIAL_TENANT);
    assert.equal(state.runs.find(run => run.tenant === TENANT).running, true);
    assert.equal(state.activeCount, 1);
    const currentStop = flatten(e.runs.children[1]).find(node => node.textContent === 'Stop');
    assert.equal(currentStop.disabled, false);
    await currentStop.click();
    assert.equal(state.activeCount, 0);
    assert.equal(e.start.hidden, false);
  } finally {h.close();}
});

test('popup clearly shows missing tenant and relay setup, and key visibility stays local', async () => {
  const h = await popupHarness({url: 'https://example.com/', savedToken: '', state: {runs: [], activeCount: 0, relay: {connected: false, error: 'Add your notification relay key in Relay settings.'}}});
  try {
    const e = h.elements;
    assert.equal(e['tenant-name'].textContent, 'No tenant detected');
    assert.equal(e.start.disabled, true);
    assert.equal(e['relay-settings'].hidden, false);
    assert.equal(e['monitoring-view'].hidden, true);
    assert.equal(e['relay-tab'].attributes['aria-pressed'], 'true');
    assert.equal(e.test.disabled, true);
    e.token.value = 'a-new-key'; e.token.input();
    assert.equal(e['check-relay'].disabled, false);
    await e['check-relay'].click();
    assert.ok(h.calls.some(call => call.message?.type === 'connect' && call.message.token === 'a-new-key'));
    assert.equal(e['relay-label'].textContent, 'Notification relay connected');
    assert.equal(e.start.disabled, true); // A valid relay does not make a non-monitor tab eligible.
    assert.equal(e['relay-settings'].hidden, false); // Connecting keeps settings and feedback visible.
    assert.equal(e['relay-notice'].hidden, false);
    assert.equal(e['relay-tab'].disabled, false);
    await e['monitoring-tab'].click();
    assert.equal(e['relay-settings'].hidden, true);
    assert.equal(e['monitoring-view'].hidden, false);
    assert.equal(e['monitoring-tab'].attributes['aria-pressed'], 'true');
    await e['relay-tab'].click();
    assert.equal(e['relay-settings'].hidden, false);
    assert.equal(e['popup-content'].scrollTop, 0);
    const count = h.calls.length;
    await e['show-token'].click();
    assert.equal(e.token.type, 'text');
    assert.equal(e['show-token'].attributes['aria-pressed'], 'true');
    await e['show-token'].click();
    assert.equal(e.token.type, 'password');
    assert.equal(h.calls.length, count);
  } finally {h.close();}
});

test('a tenant problem is distinct from relay health and does not block another tenant', async () => {
  const problem = 'SAP redirected the monitoring request. Sign in again in the watchdog tab.';
  const h = await popupHarness({state: {runs: [{tenant: TRIAL_TENANT, running: true, sent: 2, problem}], activeCount: 1, relay: {connected: true}}});
  try {
    assert.equal(h.elements.start.disabled, false);
    assert.match(text(h.elements.runs), /Needs attention/);
    assert.ok(text(h.elements.runs).includes(problem));
    assert.match(h.elements.attention.textContent, /1 tenant needs attention/);
    assert.equal(h.elements['relay-label'].textContent, 'Notification relay connected');
    await h.elements['select-all'].click();
    assert.equal(h.elements.start.disabled, true);
    await h.elements['select-all'].click();
    assert.equal(h.elements.start.disabled, false);
    assert.equal(h.inputs().filter(input => input.checked).length, 7);
  } finally {h.close();}
});

test('multiple tenants still use optional site access without expanded install permissions', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
  assert.deepEqual(manifest.permissions, ['activeTab', 'alarms', 'storage', 'scripting', 'notifications', 'power']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
});
