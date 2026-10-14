import test from 'node:test';
import assert from 'node:assert/strict';
import {TENANT, TRIAL_TENANT, OTHER_TENANTS} from './fixtures.mjs';
import {DURATION, POLL_ALARM, END_ALARM, endAlarm, EMAIL_STATUSES} from '../extension/core.js';
import {backgroundHarness, message} from './background-harness.mjs';
const legacyStart = Date.now();

async function fixture(action, options) {
  const h = await backgroundHarness(options);
  try {await action(h);} finally {h.close();}
}
test('status selections persist per tenant, filter baselines and polls, and can change without restarting', () => fixture(async h => {
  const scoped = (id, status, artifact = 'flow-a') => ({...message(id), Status: status, IntegrationArtifact: {Id: artifact, PackageId: 'package-a'}});
  h.tabs.get(1).url += encodeURIComponent(JSON.stringify({artifactIds: ['flow-a'], packageId: 'package-a'}));
  h.sap.set(TENANT, [scoped('old-failed', 'FAILED'), scoped('old-processing', 'PROCESSING')]);
  assert.equal((await h.request('start', null, {sourceTabId: 1, emailStatuses: ['FAILED', 'RETRY', 'FAILED']})).ok, true);
  assert.equal((await h.request('start', null, {sourceTabId: 2, emailStatuses: ['ESCALATED']})).ok, true);
  const original = structuredClone(h.store.state.runs[TENANT]);
  assert.deepEqual(original.emailStatuses, ['FAILED', 'RETRY']);
  assert.deepEqual(original.seen, ['old-failed']);
  h.sap.set(TENANT, [scoped('old-failed', 'FAILED'), scoped('failed', 'FAILED'), scoped('retry', 'RETRY'), scoped('processing', 'PROCESSING'), scoped('wrong-flow', 'FAILED', 'other-flow'), scoped('completed', 'COMPLETED')]);
  h.sap.set(TRIAL_TENANT, [{...message('escalated'), Status: 'ESCALATED'}, message('ignored')]);
  await h.reload(); await h.poll();
  assert.deepEqual(h.delivered.find(alert => alert.tenant === TENANT).messages.map(item => item.id), ['failed', 'retry']);
  assert.deepEqual(h.delivered.find(alert => alert.tenant === TRIAL_TENANT).messages.map(item => item.id), ['escalated']);
  const changed = await h.request('updateStatuses', TENANT, {emailStatuses: ['PROCESSING']});
  assert.equal(changed.ok, true);
  await h.reload(); await h.poll();
  assert.deepEqual(h.delivered[2].messages.map(item => item.id), ['processing']);
  const updated = h.store.state.runs[TENANT];
  for (const key of ['startedAt', 'endsAt', 'tabId']) assert.equal(updated[key], original[key]);
  assert.deepEqual(updated.scope, original.scope);
  assert.deepEqual(updated.emailStatuses, ['PROCESSING']);
  assert.deepEqual(h.store.state.runs[TRIAL_TENANT].emailStatuses, ['ESCALATED']);
  assert.ok(h.reads.some(read => new URL(read.url).searchParams.get('$filter').includes("(Status eq 'PROCESSING')")));
  h.sap.set(TENANT, [scoped('retry', 'PROCESSING')]); // Already emailed under Retry.
  await h.poll();
  assert.equal(h.delivered.length, 3);
}));
test('empty or invalid status selections do not start a run or change a saved selection', () => fixture(async h => {
  for (const emailStatuses of [[], null, ['COMPLETED'], ['ALL'], ['FAILED', 'bad'], "FAILED"]) {
    assert.equal((await h.request('start', null, {sourceTabId: 1, emailStatuses})).ok, false);
  }
  assert.equal(h.reads.length, 0);
  await h.start();
  const before = structuredClone(h.store.state.runs[TENANT]);
  for (const emailStatuses of [[], ['COMPLETED'], ['INVALID']]) {
    assert.equal((await h.request('updateStatuses', TENANT, {emailStatuses})).ok, false);
    assert.deepEqual(h.store.state.runs[TENANT], before);
  }
  assert.deepEqual(before.emailStatuses, EMAIL_STATUSES);
  assert.equal((await h.request('updateStatuses', TRIAL_TENANT, {emailStatuses: ['FAILED']})).ok, false);
}));
test('selected iFlows scope baselines, watchdog URLs and emails independently across tenants and restarts', () => fixture(async h => {
  const selected = (id, artifact, pkg) => ({...message(id), IntegrationArtifact: {Id: artifact, PackageId: pkg, Name: 'Same display name'}});
  for (const [tabId, tenant, artifact, pkg] of [[1, TENANT, 'flow-a', 'package-a'], [2, TRIAL_TENANT, 'flow-b', 'package-b']]) {
    h.tabs.get(tabId).url = `${tenant}/shell/monitoring/Messages/${encodeURIComponent(JSON.stringify({artifactIds: [artifact], packageId: pkg, time: 'PASTDAY', status: 'ALL', edge: 'runtime-a'}))}`;
    h.sap.set(tenant, [selected('old-selected', artifact, pkg), selected('old-other', 'other-flow', pkg)]);
    assert.equal((await h.start(tenant)).ok, true);
    const run = h.store.state.runs[tenant];
    assert.deepEqual(run.scope, {artifactIds: [artifact], packageId: pkg});
    assert.deepEqual(run.seen, ['old-selected']);
    const pageFilter = JSON.parse(decodeURIComponent(h.tabs.get(run.tabId).url.split('/Messages/')[1]));
    assert.deepEqual(pageFilter, {artifactIds: [artifact], packageId: pkg, time: 'PASTHOUR', status: 'ALL', edge: 'runtime-a'});
    // Later edits to the original page must not silently change this run's saved selection.
    h.tabs.get(tabId).url = `${tenant}/shell/monitoring/Messages/`;
    h.sap.set(tenant, [selected('old-selected', artifact, pkg), selected('new-selected', artifact, pkg), selected('new-other', 'other-flow', pkg), selected('wrong-package', artifact, 'other-package')]);
  }
  await h.reload(); await h.poll();
  assert.equal(h.delivered.length, 2);
  for (const alert of h.delivered) assert.deepEqual(alert.messages.map(message => message.id), ['new-selected']);
  for (const read of h.reads) {
    const scope = h.store.state.runs[read.tenant].scope;
    const filter = new URL(read.url).searchParams.get('$filter');
    assert.ok(filter.includes(`IntegrationArtifact/Id eq '${scope.artifactIds[0]}'`));
    assert.ok(filter.includes(`IntegrationArtifact/PackageId eq '${scope.packageId}'`));
  }
  await h.poll(); assert.equal(h.delivered.length, 2);
}));
test('invalid page selection prevents baseline reads and creation of an unrestricted run', () => fixture(async h => {
  h.tabs.get(1).url = `${TENANT}/shell/monitoring/Messages/%7B`;
  assert.equal((await h.start()).ok, false);
  assert.equal(h.reads.length, 0);
  assert.equal(Object.keys(h.store.state.runs).length, 0);
}));
test('two tenants have independent baselines, counters, links and delivery deduplication', () => fixture(async h => {
  h.sap.set(TENANT, [message('old-a')]);
  h.sap.set(TRIAL_TENANT, [message('old-b')]);
  assert.equal((await h.start()).ok, true);
  assert.equal((await h.start(TRIAL_TENANT)).ok, true);
  assert.equal((await h.start()).ok, false);
  assert.equal(h.alarms.get(POLL_ALARM).periodInMinutes, 1);
  for (const tenant of [TENANT, TRIAL_TENANT]) assert.equal(h.alarms.get(endAlarm(tenant)).when, h.time + DURATION);
  h.sap.set(TENANT, [message('old-a'), message('same-id'), message('same-id')]);
  h.sap.set(TRIAL_TENANT, [message('old-b'), message('same-id')]);
  h.time += 60000;
  const status = (await h.poll()).value;
  assert.equal(status.activeCount, 2);
  assert.deepEqual(status.runs.map(run => run.sent), [1, 1]);
  assert.ok(status.runs.every(run => !('token' in run) && !('seen' in run)));
  assert.deepEqual(h.delivered.map(alert => alert.tenant).sort(), [TENANT, TRIAL_TENANT].sort());
  for (const alert of h.delivered) assert.ok(alert.messages[0].url.startsWith(alert.tenant));
  assert.equal(h.tableClicks.length, 2);
  assert.equal(h.monitoring.filter(item => item.action === 'heartbeat').length, 2);
  await h.poll();
  assert.equal(h.delivered.length, 2);
}));
test('one tenant session outage does not interrupt another tenant, and recovery catches up', () => fixture(async h => {
  await h.start(); await h.start(TRIAL_TENANT);
  h.broken.add(TENANT);
  h.sap.set(TRIAL_TENANT, [message('good')]);
  await h.poll(); await h.poll();
  assert.equal(h.store.state.runs[TENANT].status, 'Needs attention');
  assert.equal(h.store.state.runs[TRIAL_TENANT].sent, 1);
  assert.equal(h.delivered.filter(alert => alert.kind === 'problem').length, 1);
  assert.equal(h.notices.length, 1);
  h.broken.clear(); h.sap.set(TENANT, [message('missed')]);
  await h.poll();
  assert.equal(h.store.state.runs[TENANT].status, 'Watching');
  assert.equal(h.store.state.runs[TENANT].sent, 1);
}));
test('a slow tenant does not hold up another tenant check', () => fixture(async h => {
  await h.start(); await h.start(TRIAL_TENANT);
  let release;
  h.sap.set(TENANT, () => new Promise(resolve => {release = resolve;}));
  h.sap.set(TRIAL_TENANT, [message('prompt')]);
  const checking = h.poll();
  for (let attempts = 0; attempts < 100 && !h.delivered.length; attempts++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.delivered[0]?.tenant, TRIAL_TENANT);
  release([message('late')]);
  await checking;
  assert.deepEqual(Object.values(h.store.state.runs).map(run => run.sent), [1, 1]);
}));
test('Stop and nine-hour expiry affect only the selected tenant', () => fixture(async h => {
  await h.start();
  h.time += 60000;
  await h.start(TRIAL_TENANT);
  const firstEnd = h.store.state.runs[TENANT].endsAt;
  h.time = firstEnd;
  await h.poll(endAlarm(TENANT));
  assert.equal(h.store.state.runs[TENANT].running, false);
  assert.equal(h.store.state.runs[TRIAL_TENANT].running, true);
  assert.equal(h.alarms.has(POLL_ALARM), true);
  assert.equal(h.awake, true);
  await h.request('stop', TRIAL_TENANT);
  assert.equal(h.awake, false);
  assert.equal(h.alarms.has(POLL_ALARM), false);
  assert.equal(h.delivered.length, 0);
  assert.equal(h.monitoring.filter(item => item.action === 'stop').length, 2);
}));
test('failed email deliveries retry, and missing UI refresh does not disable monitoring', () => fixture(async h => {
  await h.start(); h.sap.set(TENANT, [message('retry')]);
  h.emailBroken = true;
  await h.poll();
  assert.deepEqual(h.store.state.runs[TENANT].seen, []);
  h.emailBroken = false; h.refreshAvailable = false;
  await h.poll(); await h.poll();
  assert.equal(h.store.state.runs[TENANT].sent, 1);
  assert.equal(h.store.state.runs[TENANT].tableRefresh, false);
  assert.equal(h.store.state.runs[TENANT].status, 'Watching');
  assert.equal(h.delivered.filter(alert => alert.kind === 'messages').length, 1);
}));
test('missing permissions prevent start and revocation alerts only the affected tenant', () => fixture(async h => {
  h.denied.add(TENANT);
  assert.equal((await h.start()).ok, false);
  h.denied.clear(); await h.start(); await h.start(TRIAL_TENANT);
  h.denied.add(TENANT);
  await h.poll();
  assert.equal(h.store.state.runs[TENANT].status, 'Needs attention');
  assert.equal(h.store.state.runs[TRIAL_TENANT].status, 'Watching');
  assert.equal(h.delivered[0].kind, 'problem');
}));
test('Open targets each tenant watchdog tab and a closed tab generates a problem alert', () => fixture(async h => {
  await h.start(); await h.start(TRIAL_TENANT);
  await h.request('open', TRIAL_TENANT);
  assert.equal(h.tabs.get(h.store.state.runs[TRIAL_TENANT].tabId).active, true);
  h.tabs.delete(h.store.state.runs[TENANT].tabId);
  await h.poll();
  assert.equal(h.delivered[0].kind, 'problem');
  assert.equal(h.delivered[0].tenant, TENANT);
  assert.equal(h.store.state.runs[TRIAL_TENANT].status, 'Watching');
}));
test('migrates the legacy run and restores tenant alarms after worker restart', () => fixture(async h => {
  assert.equal(h.store.state.version, 2);
  assert.equal(h.store.state.runs[TENANT].sent, 7);
  assert.deepEqual(h.store.state.runs[TENANT].seen, ['already-sent']);
  assert.deepEqual((await h.request('status')).value.runs[0].emailStatuses, EMAIL_STATUSES);
  assert.equal(h.alarms.has(END_ALARM), false);
  await h.start(TRIAL_TENANT);
  h.alarms.clear();
  await h.reload();
  assert.equal(h.alarms.has(endAlarm(TENANT)), true);
  assert.equal(h.alarms.has(endAlarm(TRIAL_TENANT)), true);
  assert.equal(h.alarms.has(POLL_ALARM), true);
  assert.equal(h.store.state.runs[TENANT].sent, 7);
}, {saved: {running: true, token: 'a'.repeat(64), tabId: 1, startedAt: legacyStart, endsAt: legacyStart + DURATION,
  lastCheck: legacyStart, seen: ['already-sent'], sent: 7, status: 'Watching'}}));
test('an old queued end alarm cannot stop a restarted tenant', () => fixture(async h => {
  await h.start(); await h.request('stop', TENANT);
  h.time += 60000; await h.start();
  await h.poll(endAlarm(TENANT));
  assert.equal(h.store.state.runs[TENANT].running, true);
}));
test('offline Stop is persisted and retried without stopping another run', () => fixture(async h => {
  await h.start(); await h.start(TRIAL_TENANT);
  h.monitorBroken = true;
  await h.request('stop', TENANT);
  assert.equal(h.store.state.pendingStops.length, 1);
  await h.reload();
  h.monitorBroken = false;
  await h.poll();
  assert.equal(h.store.state.pendingStops.length, 0);
  assert.equal(h.store.state.runs[TRIAL_TENANT].running, true);
}));
test('heartbeat failure keeps one problem episode until the updated relay recovers', () => fixture(async h => {
  await h.start(); h.monitorBroken = true;
  await h.poll(); await h.poll();
  assert.equal(h.delivered.filter(alert => alert.kind === 'problem').length, 1);
  h.monitorBroken = false; await h.poll();
  assert.equal(h.store.state.runs[TENANT].status, 'Watching');
}));
test('runtime selector is preserved for custom tenants and test email uses the relay', () => fixture(async h => {
  const tenant = OTHER_TENANTS[2];
  h.tabs.set(10, {id: 10, url: `${tenant}/shell/monitoring/Messages/%7B%22edge%22%3A%22runtime-a%22%7D`});
  assert.equal((await h.start(tenant)).ok, true);
  const tab = h.tabs.get(h.store.state.runs[tenant].tabId);
  assert.equal(JSON.parse(decodeURIComponent(tab.url.split('/Messages/')[1])).edge, 'runtime-a');
  await h.request('test');
  assert.equal(h.delivered[0].kind, 'test');
}));
