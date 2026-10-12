import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshMessageTable } from '../extension/poll.js';
import { TRIAL_TENANT } from './fixtures.mjs';

test('refresh targets only the message toolbar and works with localized labels', () => {
  globalThis.location = new URL(`${TRIAL_TENANT}/shell/monitoring/Messages/`);
  let clicks = 0;
  let buttons = [];
  const button = (options = {}) => ({
    id: 'table-refresh',
    disabled: options.disabled || false,
    querySelector() {return {getAttribute() {return options.icon ?? '\ue010';}};},
    getAttribute(name) {return name === 'aria-label' ? (options.label ?? 'Inhalt neu laden') : name === 'aria-disabled' ? options.ariaDisabled : null;},
    getClientRects() {return options.hidden ? [] : [{}];},
    click() {throw new Error('DOM click does not trigger SAP UI5 press');}
  });
  globalThis.sap = {ui: {getCore() {return {byId(id) {
    assert.equal(id, 'table-refresh');
    return {getMetadata() {return {getName() {return 'sap.m.Button';}};},
      getIcon() {return 'sap-icon://refresh';}, getEnabled() {return true;}, hasListeners() {return true;}, firePress() {clicks++;}};
  }};}}};
  globalThis.document = {querySelector(selector) {
    assert.equal(selector, '[role="toolbar"][aria-labelledby~="PanelMessagesTitle"]');
    return {querySelectorAll() {return buttons;}};
  }};
  buttons = [button(), button({icon: '\ue00c', label: 'Table Settings'})];
  assert.equal(refreshMessageTable(TRIAL_TENANT), true);
  assert.equal(clicks, 1);
  for (const candidates of [[button({disabled: true})], [button({ariaDisabled: 'true'})], [button({hidden: true})], [button(), button()]]) {
    buttons = candidates;
    assert.equal(refreshMessageTable(TRIAL_TENANT), false);
  }
  assert.equal(clicks, 1);
  location = new URL(`${TRIAL_TENANT}/shell/design`);
  assert.equal(refreshMessageTable(TRIAL_TENANT), false);
  location = new URL('https://another.example/shell/monitoring/Messages/');
  assert.equal(refreshMessageTable(TRIAL_TENANT), false);
  assert.equal(clicks, 1);
});

test('missing UI5 refresh handler is reported as unavailable without clicking anything else', () => {
  globalThis.location = new URL(`${TRIAL_TENANT}/shell/monitoring/Messages/`);
  globalThis.sap = undefined;
  globalThis.document = {querySelector() {return {querySelectorAll() {return [{
    id: 'table-refresh', getAttribute() {return null;}, getClientRects() {return [{}];},
    querySelector() {return {getAttribute() {return '\ue010';}};},
    click() {throw new Error('Do not fall back to a non-working DOM click');}
  }];}};}};
  assert.equal(refreshMessageTable(TRIAL_TENANT), false);
});
