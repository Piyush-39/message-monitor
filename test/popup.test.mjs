import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OTHER_TENANTS } from './fixtures.mjs';

test('popup grants only the selected tenant before starting, and handles denied access', async () => {
  const elements = Object.fromEntries(['status', 'token', 'start', 'stop', 'open', 'test'].map(id => [id, {
    id, disabled: false, value: '', textContent: '',
    addEventListener(event, action) {this.click = action;}
  }]));
  globalThis.document = {
    querySelector(selector) {return elements[selector.slice(1)];},
    querySelectorAll() {return [elements.start, elements.stop, elements.open, elements.test];}
  };
  const calls = [];
  const tenant = OTHER_TENANTS[2];
  let granted = false;
  let state = {};
  globalThis.chrome = {
    tabs: {async query() {return [{id: 42, url: `${tenant}/shell/monitoring/Messages/`}];}},
    permissions: {async request(value) {calls.push({permission: value}); return granted;}},
    storage: {local: {async get() {return {relayToken: 'local-test-key'};}, async set() {}}},
    runtime: {async sendMessage(message) {
      calls.push({message});
      if (message.type === 'start') state = {running: true, tenant, status: 'Watching', endsAt: Date.now() + 3600000, sent: 0};
      return {ok: true, value: state};
    }}
  };
  await import('../extension/popup.js');
  calls.length = 0;
  await elements.start.click();
  assert.deepEqual(calls[0], {permission: {origins: [`${tenant}/*`]}});
  assert.equal(calls.some(call => call.message?.type === 'start'), false);
  assert.match(elements.status.textContent, /access was declined/);
  granted = true;
  calls.length = 0;
  await elements.start.click();
  assert.deepEqual(calls[0], {permission: {origins: [`${tenant}/*`]}});
  assert.deepEqual(calls[1].message, {type: 'start', token: 'local-test-key', sourceTabId: 42});
  assert.match(elements.status.textContent, /Tenant: integration.company.example/);
  assert.equal(elements.start.disabled, true);
});

test('manifest declares tenant access as optional and has no fixed SAP hosts', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
});
