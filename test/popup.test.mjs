import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {TENANT, TRIAL_TENANT} from './fixtures.mjs';
import {EMAIL_STATUSES} from '../extension/core.js';

test('popup adds a second tenant with scoped permission and targets independent Open/Stop buttons', async () => {
  function element(tag, id) {
    return {tag, id, disabled: false, value: '', textContent: '', children: [],
      append(...nodes) {this.children.push(...nodes);}, replaceChildren() {this.children = [];},
      addEventListener(event, handler) {this.click = handler;}
    };
  }
  const elements = Object.fromEntries(['status', 'token', 'start', 'test', 'runs', 'email-statuses', 'status-options', 'delivery-status'].map(id => [id, element('div', id)]));
  function flatten(node) {return [node, ...node.children.flatMap(flatten)];}
  globalThis.document = {
    querySelector(selector) {return elements[selector.slice(1)];}, createElement: tag => element(tag),
    querySelectorAll() {return [elements.start, elements.test, ...flatten(elements.runs).filter(node => node.tag === 'button')];}
  };
  const calls = [];
  let granted = false;
  const initial = {tenant: TRIAL_TENANT, running: true, status: 'Watching', endsAt: Date.now() + 3600000, sent: 3,
    scope: {artifactIds: ['flow-a', 'flow-b'], packageId: 'package-a'}, emailStatuses: ['ESCALATED']};
  const state = {runs: [initial], activeCount: 1};
  globalThis.chrome = {
    tabs: {async query() {return [{id: 42, url: `${TENANT}/shell/monitoring/Messages/`}];}},
    permissions: {async request(value) {calls.push({permission: value}); return granted;}},
    storage: {local: {async get() {return {relayToken: 'local-test-key'};}}},
    runtime: {async sendMessage(message) {
      calls.push({message});
      if (message.type === 'start') state.runs.push({tenant: TENANT, running: true, status: 'Watching', endsAt: Date.now() + 3600000, sent: 0, emailStatuses: message.emailStatuses});
      if (message.type === 'updateStatuses') state.runs.find(run => run.tenant === message.tenant).emailStatuses = message.emailStatuses;
      if (message.type === 'stop') state.runs.find(run => run.tenant === message.tenant).running = false;
      state.activeCount = state.runs.filter(run => run.running).length;
      return {ok: true, value: state};
    }}
  };
  await import('../extension/popup.js');
  const inputs = () => flatten(elements['status-options']).filter(node => node.tag === 'input');
  const choose = statuses => inputs().forEach(input => {input.checked = statuses.includes(input.value);});
  assert.deepEqual(inputs().filter(input => input.checked).map(input => input.value), EMAIL_STATUSES);
  assert.equal(elements.start.disabled, false); // Another active tenant doesn't block Start.
  choose([]); calls.length = 0;
  await elements.start.click();
  assert.match(elements.status.textContent, /Select at least one/);
  assert.equal(calls.some(call => call.permission || call.message?.type === 'start'), false);
  choose(['FAILED', 'RETRY']);
  calls.length = 0;
  await elements.start.click();
  assert.deepEqual(calls[0], {permission: {origins: [`${TENANT}/*`]}});
  assert.equal(calls.some(call => call.message?.type === 'start'), false);
  assert.match(elements.status.textContent, /access was declined/);
  granted = true; calls.length = 0;
  await elements.start.click();
  assert.deepEqual(calls[1].message, {type: 'start', token: 'local-test-key', sourceTabId: 42, emailStatuses: ['FAILED', 'RETRY']});
  assert.equal(elements.start.disabled, false);
  assert.equal(elements.start.textContent, 'Save statuses');
  assert.equal(elements.runs.children.length, 2);
  const firstCard = elements.runs.children[0];
  assert.equal(firstCard.children[0].textContent, new URL(TRIAL_TENANT).hostname);
  assert.match(firstCard.children[1].textContent, /Monitoring: 2 iFlows\nPackage: package-a/);
  assert.match(firstCard.children[1].textContent, /Messages accepted by relay: 3\nAlert statuses: Escalated/);
  assert.match(elements.runs.children[1].children[1].textContent, /Alert statuses: Failed, Retry/);
  assert.doesNotMatch(firstCard.children[1].textContent, /flow-a|flow-b/);
  assert.match(elements.runs.children[1].children[1].textContent, /Monitoring: All iFlows/);
  choose(['PROCESSING']); calls.length = 0;
  await elements.start.click();
  assert.deepEqual(calls[0].message, {type: 'updateStatuses', token: 'local-test-key', tenant: TENANT, emailStatuses: ['PROCESSING']});
  assert.equal(calls.some(call => call.permission), false);
  assert.match(elements.runs.children[1].children[1].textContent, /Alert statuses: Processing/);
  assert.deepEqual(initial.emailStatuses, ['ESCALATED']);
  elements['status-options'].children = [];
  await import('../extension/popup.js?reopen');
  assert.deepEqual(inputs().filter(input => input.checked).map(input => input.value), ['PROCESSING']);
  initial.scope = {artifactIds: ['only-flow', 'only-flow'], packageId: null};
  state.delivery = {provider: 'discord', pending: 3, delivered: 8,
    errors: {discord: 'Discord rate limit; waiting to retry.'}};
  await elements.test.click();
  assert.match(elements['delivery-status'].textContent, /Discord: 3 queued\./);
  assert.match(elements['delivery-status'].textContent, /discord: Discord rate limit/);
  assert.match(elements.runs.children[0].children[1].textContent, /Monitoring: 1 iFlow$/);
  assert.doesNotMatch(elements.runs.children[0].children[1].textContent, /only-flow/);
  initial.scope = {artifactIds: [], packageId: 'package-a'};
  await elements.test.click();
  assert.match(elements.runs.children[0].children[1].textContent, /Monitoring: All iFlows in the selected package/);
  const open = flatten(firstCard).find(node => node.textContent === 'Open watchdog tab');
  calls.length = 0; await open.click();
  assert.equal(calls[0].message.tenant, TRIAL_TENANT);
  const stop = flatten(elements.runs.children[0]).find(node => node.textContent === 'Stop');
  calls.length = 0; await stop.click();
  assert.equal(calls[0].message.tenant, TRIAL_TENANT);
  assert.equal(state.runs.find(run => run.tenant === TENANT).running, true);
  assert.equal(state.activeCount, 1);
  const currentStop = flatten(elements.runs.children[1]).find(node => node.textContent === 'Stop');
  assert.equal(currentStop.disabled, false);
  await currentStop.click();
  assert.equal(state.activeCount, 0);
});

test('multiple tenants still use optional site access without expanded install permissions', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
  assert.deepEqual(manifest.permissions, ['activeTab', 'alarms', 'storage', 'scripting', 'notifications', 'power']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
});
