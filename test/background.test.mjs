import test from 'node:test';
import assert from 'node:assert/strict';
import {TENANT, TRIAL_TENANT, OTHER_TENANTS} from './fixtures.mjs';
import {POLL_ALARM, HEARTBEAT_ALARM, END_ALARM, endAlarm, EMAIL_STATUSES} from '../extension/core.js';
import {backgroundHarness, message} from './background-harness.mjs';
const legacyStart = Date.now();
const LEGACY_DURATION = 9 * 3600000;

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
  assert.deepEqual(h.delivered.filter(alert => alert.tenant === TENANT).flatMap(alert => alert.messages.map(item => item.id)), ['failed', 'retry']);
  assert.deepEqual(h.delivered.find(alert => alert.tenant === TRIAL_TENANT).messages.map(item => item.id), ['escalated']);
  const changed = await h.request('updateStatuses', TENANT, {emailStatuses: ['PROCESSING']});
  assert.equal(changed.ok, true);
  await h.reload(); await h.poll();
  assert.deepEqual(h.delivered.at(-1).messages.map(item => item.id), ['processing']);
  const updated = h.store.state.runs[TENANT];
  for (const key of ['startedAt', 'endsAt', 'tabId']) assert.equal(updated[key], original[key]);
  assert.deepEqual(updated.scope, original.scope);
  assert.deepEqual(updated.emailStatuses, ['PROCESSING']);
  assert.deepEqual(h.store.state.runs[TRIAL_TENANT].emailStatuses, ['ESCALATED']);
  assert.ok(h.reads.some(read => new URL(read.url).searchParams.get('$filter').includes("(Status eq 'PROCESSING')")));
  h.sap.set(TENANT, [scoped('retry', 'PROCESSING')]); // Already emailed under Retry.
  await h.poll();
  assert.equal(h.delivered.length, 4);
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
  for (const tenant of [TENANT, TRIAL_TENANT]) {
    assert.equal(h.alarms.has(endAlarm(tenant)), false);
    assert.equal(h.store.state.runs[tenant].endsAt, null);
  }
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
test('tenants continue beyond nine hours and Stop affects only the selected tenant', () => fixture(async h => {
  await h.start();
  h.time += 60000;
  await h.start(TRIAL_TENANT);
  h.time += 3 * 24 * 3600000;
  h.sap.set(TENANT, [message('after-three-days')]);
  await h.poll(endAlarm(TENANT)); // Old queued expiry alarms are ignored.
  await h.poll();
  assert.equal(h.store.state.runs[TENANT].running, true);
  assert.equal(h.store.state.runs[TRIAL_TENANT].running, true);
  assert.equal(h.store.state.runs[TENANT].sent, 1);
  await h.reload();
  assert.equal((await h.request('status')).value.activeCount, 2);
  await h.request('stop', TENANT);
  assert.equal(h.store.state.runs[TRIAL_TENANT].running, true);
  assert.equal(h.alarms.has(POLL_ALARM), true);
  assert.equal(h.awake, true);
  await h.request('stop', TRIAL_TENANT);
  assert.equal(h.awake, false);
  assert.equal(h.alarms.has(POLL_ALARM), false);
  assert.equal(h.monitoring.filter(item => item.action === 'stop').length, 2);
  assert.ok(h.monitoring.filter(item => item.action !== 'stop').every(item => item.endsAt === null));
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
test('a tab lost between listing and error lookup still emails the detected message with a fallback', () => fixture(async h => {
  await h.start();
  h.sap.set(TENANT, () => {
    h.tabs.delete(h.store.state.runs[TENANT].tabId);
    return [message('detected-before-close')];
  });
  await h.poll();
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].messages[0].id, 'detected-before-close');
  assert.match(h.delivered[0].messages[0].errorText, /^Error details unavailable\./);
  assert.deepEqual(h.store.state.runs[TENANT].seen, ['detected-before-close']);
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
test('migrates a legacy run to unlimited monitoring and restores polling after worker restart', () => fixture(async h => {
  assert.equal(h.store.state.version, 2);
  assert.equal(h.store.state.runs[TENANT].sent, 7);
  assert.deepEqual(h.store.state.runs[TENANT].seen, ['already-sent']);
  assert.deepEqual((await h.request('status')).value.runs[0].emailStatuses, EMAIL_STATUSES);
  assert.equal(h.alarms.has(END_ALARM), false);
  await h.start(TRIAL_TENANT);
  h.alarms.clear();
  await h.reload();
  assert.equal(h.alarms.has(endAlarm(TENANT)), false);
  assert.equal(h.alarms.has(endAlarm(TRIAL_TENANT)), false);
  assert.equal(h.alarms.has(POLL_ALARM), true);
  assert.equal(h.store.state.runs[TENANT].sent, 7);
  assert.equal(h.store.state.runs[TENANT].endsAt, null);
  assert.ok(h.monitoring.some(item => item.tenant === TENANT && item.endsAt === null));
}, {saved: {running: true, token: 'a'.repeat(64), tabId: 1, startedAt: legacyStart, endsAt: legacyStart + LEGACY_DURATION,
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

test('individual alerts persist progress and retry only unsent messages after a delivery failure and worker restart', async () => {
  const accepted = [];
  let fail = true;
  await fixture(async h => {
    await h.start();
    h.sap.set(TENANT, [message('redirect'), message('unrelated'), message('later')]);
    h.sapErrors.set(`${TENANT}:redirect`, 'HTTP operation failed with statusCode: 302');
    h.sapErrors.set(`${TENANT}:unrelated`, 'Receiver connection refused');
    await h.poll();
    assert.deepEqual(accepted.map(alert => alert.messages[0].id), ['redirect']);
    assert.deepEqual(h.store.state.runs[TENANT].seen, ['redirect']);
    assert.equal(h.store.state.runs[TENANT].sent, 1);
    assert.equal(h.store.state.runs[TENANT].lastCheckAlerts, 1);
    fail = false;
    await h.reload(); await h.poll(); await h.poll();
    assert.deepEqual(accepted.map(alert => alert.messages[0].id), ['redirect', 'unrelated', 'later']);
    assert.ok(accepted.every(alert => alert.messages.length === 1));
    assert.equal(h.store.state.runs[TENANT].sent, 3);
    assert.equal(h.store.state.runs[TENANT].status, 'Watching');
    assert.doesNotMatch(accepted[1].messages[0].errorText, /statusCode: 302/);
  }, {relayFetch: async (url, options) => {
    const alert = options.body && JSON.parse(options.body);
    if (alert?.kind === 'messages') {
      if (fail && alert.messages.some(message => message.id === 'unrelated')) return Response.json({error: 'Temporary SMTP failure'}, {status: 502});
      accepted.push(alert);
    }
    return Response.json({ok: true});
  }});
});

test('specific SAP failures survive Chrome MAIN-world execution and changed causes notify again', () => fixture(async h => {
  await h.start();
  for (const [status, expected] of [[401, /rejected the session \(HTTP 401\)/], [403, /denied monitoring access \(HTTP 403\)/], [503, /HTTP 503/]]) {
    h.sap.set(TENANT, () => new Response('', {status}));
    await h.poll(); await h.poll();
    assert.match(h.store.state.runs[TENANT].problem, expected);
    assert.match(h.delivered.at(-1).problem, expected);
    assert.match(h.monitoring.at(-1).problem, expected);
    assert.equal(h.monitoring.at(-1).status, 'problem');
  }
  assert.equal(h.delivered.filter(alert => alert.kind === 'problem').length, 3);
  h.sap.set(TENANT, () => {throw new TypeError('Failed to fetch');});
  await h.poll();
  assert.match(h.delivered.at(-1).problem, /before an HTTP response/);
  assert.match(h.delivered.at(-1).problem, /expiry is not confirmed/);
  h.sap.set(TENANT, () => {throw new DOMException('Timed out', 'TimeoutError');});
  await h.poll();
  assert.match(h.delivered.at(-1).problem, /SAP request timed out/);
  h.sap.set(TENANT, []);
  await h.poll();
  assert.equal(h.store.state.runs[TENANT].problem, null);
}));

test('watchdog tabs resist Memory Saver while active, restore on Stop, and report discarded or closed tabs clearly', () => fixture(async h => {
  await h.start();
  const run = h.store.state.runs[TENANT];
  const tab = h.tabs.get(run.tabId);
  assert.equal(tab.autoDiscardable, false);
  assert.equal(h.alarms.get(HEARTBEAT_ALARM).periodInMinutes, 1);
  await h.reload();
  assert.equal(tab.autoDiscardable, false);
  tab.discarded = true;
  await h.poll();
  assert.match(h.delivered.at(-1).problem, /unloaded.*save memory/);
  tab.discarded = false;
  h.tabs.delete(run.tabId);
  await h.poll();
  assert.match(h.delivered.at(-1).problem, /tab was closed/);
  h.tabs.set(run.tabId, tab);
  await h.request('stop', TENANT);
  assert.equal(tab.autoDiscardable, true);
  assert.equal(h.alarms.has(HEARTBEAT_ALARM), false);
  assert.equal(h.store.state.runs[TENANT].status, 'Stopped by you');
}));

test('the independent heartbeat continues while message delivery blocks and the table refresh happens first', async () => {
  let release, waiting;
  const entered = new Promise(resolve => {waiting = resolve;});
  const blocked = new Promise(resolve => {release = resolve;});
  let checking;
  await fixture(async h => {
    try {
      await h.start();
      h.sap.set(TENANT, [message('slow-delivery')]);
      checking = h.poll();
      await entered;
      assert.equal(h.store.state.runs[TENANT].lastCheck, h.time);
      assert.deepEqual(h.tableClicks, [TENANT]);
      h.time += 180000;
      h.fireAlarm(HEARTBEAT_ALARM);
      for (let i = 0; i < 30 && !h.monitoring.some(item => item.phase === 'Handing message alerts to notification relay'); i++) await new Promise(resolve => setImmediate(resolve));
      const beat = h.monitoring.at(-1);
      assert.equal(beat.action, 'heartbeat');
      assert.equal(beat.phase, 'Handing message alerts to notification relay');
      assert.equal(beat.lastCheck, h.time - 180000);
      assert.equal(beat.status, 'problem');
      assert.match(beat.problem, /extension is responding/);
    } finally {release(); await checking;}
  }, {relayFetch: async (url, options) => {
    if (JSON.parse(options.body || '{}').kind === 'messages') {waiting(); await blocked;}
    return Response.json({ok: true});
  }});
});

test('status stays responsive during a stalled SAP check and failed checks never advance its timestamp', {timeout: 5000}, () => fixture(async h => {
  await h.start();
  const lastCheck = h.store.state.runs[TENANT].lastCheck;
  h.time += 30 * 60000;
  let release, entered;
  const started = new Promise(resolve => {entered = resolve;});
  const blocked = new Promise(resolve => {release = resolve;});
  h.sap.set(TENANT, async () => {entered(); await blocked; return new Response('', {status: 503});});
  const checking = h.poll();
  try {
    await started;
    const status = await h.request('status');
    assert.equal(status.value.runs[0].lastCheck, lastCheck);
    assert.equal(status.value.runs[0].phase, 'Reading SAP messages');
  } finally {release(); await checking;}
  assert.equal(h.store.state.runs[TENANT].lastCheck, lastCheck);
  await h.reload();
  assert.equal((await h.request('status')).value.runs[0].lastCheck, lastCheck);
  assert.ok(h.monitoring.every(update => update.lastCheck === lastCheck));
  h.sap.set(TENANT, []);
  await h.poll();
  assert.equal(h.store.state.runs[TENANT].lastCheck, h.time);
}));

test('Stop waits for an in-flight independent heartbeat so it cannot rearm monitoring after cancellation', async () => {
  let release, entered, block = true;
  const started = new Promise(resolve => {entered = resolve;});
  const waiting = new Promise(resolve => {release = resolve;});
  const received = [];
  let stopping;
  await fixture(async h => {
    try {
      await h.start();
      h.fireAlarm(HEARTBEAT_ALARM);
      await started;
      stopping = h.request('stop', TENANT);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(received.includes('stop'), false);
      block = false; release();
      await stopping;
      assert.deepEqual(received, ['start', 'heartbeat', 'stop']);
    } finally {release(); if (stopping) await stopping;}
  }, {relayFetch: async (url, options) => {
    const body = JSON.parse(options.body || '{}');
    if (new URL(url).pathname === '/monitor') {
      if (body.action === 'heartbeat' && block) {entered(); await waiting;}
      received.push(body.action);
    }
    return Response.json({ok: true});
  }});
});

test('slow handoffs yield to the next SAP check and retry every unsent ID without duplicates', async () => {
  let h;
  const accepted = [];
  await fixture(async value => {
    h = value;
    await h.start();
    h.sap.set(TENANT, Array.from({length: 5}, (_, i) => message(`slow-${i}`)));
    await h.poll();
    assert.equal(h.store.state.runs[TENANT].sent, 3);
    assert.equal(h.store.state.runs[TENANT].pendingAlerts, 2);
    const firstCheck = h.store.state.runs[TENANT].lastCheck;
    await h.poll();
    assert.ok(h.store.state.runs[TENANT].lastCheck > firstCheck);
    assert.equal(h.store.state.runs[TENANT].sent, 5);
    assert.equal(h.store.state.runs[TENANT].pendingAlerts, 0);
    assert.deepEqual(accepted, ['slow-0', 'slow-1', 'slow-2', 'slow-3', 'slow-4']);
  }, {relayFetch: async (url, options) => {
    const alert = JSON.parse(options.body || '{}');
    if (alert.kind === 'messages') {accepted.push(alert.messages[0].id); h.time += 16000;}
    return Response.json({ok: true});
  }});
});

test('existing version-2 runs lose deadlines without reviving stopped runs or losing selections', () => fixture(async h => {
  await h.start(); await h.start(TRIAL_TENANT);
  await h.request('updateStatuses', TENANT, {emailStatuses: ['RETRY']});
  await h.request('stop', TRIAL_TENANT);
  const original = structuredClone(h.store.state.runs[TENANT]);
  h.store.state.runs[TENANT].endsAt = h.time + LEGACY_DURATION;
  h.alarms.set(endAlarm(TENANT), {when: h.time + LEGACY_DURATION});
  h.time += LEGACY_DURATION + 1;
  await h.reload();
  const run = h.store.state.runs[TENANT];
  assert.equal(run.running, true);
  assert.equal(run.endsAt, null);
  for (const key of ['startedAt', 'tabId', 'seen', 'sent', 'scope', 'emailStatuses']) assert.deepEqual(run[key], original[key]);
  assert.equal(h.store.state.runs[TRIAL_TENANT].running, false);
  assert.equal(h.alarms.has(endAlarm(TENANT)), false);
  assert.equal(h.monitoring.at(-1).endsAt, null);
}));
test('Connect validates and saves the relay key without sending a notification', () => fixture(async h => {
  assert.equal((await h.request('connect')).ok, true);
  assert.equal(h.store.relayToken, 'a'.repeat(64));
  assert.equal(h.delivered.length, 0);
  assert.equal((await h.request('status')).value.relay.connected, true);
}));
test('a rejected relay key is not saved and its error is shown in relay health', () => fixture(async h => {
  const result = await h.request('connect');
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid relay key/);
  assert.equal(h.store.relayToken, undefined);
  const status = (await h.request('status')).value;
  assert.equal(status.relay.connected, false);
  assert.match(status.relay.error, /Invalid relay key/);
}, {relayFetch: async () => Response.json({error: 'Invalid relay key'}, {status: 401})}));


test('last-check alert counts are tenant-scoped, persist across reload and reset on a successful empty check', () => fixture(async h => {
  await h.start(); await h.start(TRIAL_TENANT);
  assert.equal(h.store.state.runs[TENANT].lastCheckAlerts, 0);
  h.sap.set(TENANT, [message('one'), message('two')]);
  h.sap.set(TRIAL_TENANT, [message('trial')]);
  await h.poll();
  assert.equal(h.store.state.runs[TENANT].lastCheckAlerts, 2);
  assert.equal(h.store.state.runs[TRIAL_TENANT].lastCheckAlerts, 1);
  await h.reload();
  assert.equal((await h.request('status')).value.runs.find(run => run.tenant === TENANT).lastCheckAlerts, 2);
  h.broken.add(TENANT);
  await h.poll();
  assert.equal(h.store.state.runs[TENANT].lastCheckAlerts, 2); // Failed SAP reads preserve the last check.
  assert.equal(h.store.state.runs[TRIAL_TENANT].lastCheckAlerts, 0);
  h.broken.delete(TENANT);
  await h.poll();
  assert.equal(h.store.state.runs[TENANT].lastCheckAlerts, 0);
  assert.equal(h.store.state.runs[TENANT].sent, 2);
}));


test('reset cancels all relay leases, restores tabs and clears saved data, alarms and power request', () => fixture(async h => {
  await h.start(); await h.start(TRIAL_TENANT);
  h.sap.set(TENANT, [message('before-reset')]); await h.poll();
  const tabs = Object.values(h.store.state.runs).map(run => run.tabId);
  h.store.extraSetting = 'remove-me';
  assert.equal((await h.request('reset')).ok, true);
  assert.deepEqual(h.store, {});
  assert.equal(h.alarms.size, 0);
  assert.equal(h.awake, false);
  assert.ok(tabs.every(id => h.tabs.get(id).autoDiscardable));
  assert.equal(h.monitoring.filter(update => update.action === 'stop').length, 2);
  assert.equal((await h.request('status')).value.runs.length, 0);
  await h.reload();
  assert.equal(h.store.relayToken, undefined);
  assert.deepEqual(h.store.state.runs, {});
  assert.equal(h.alarms.size, 0);
}));

test('reset retains cancellation data when the relay is offline and completes after reconnection', () => fixture(async h => {
  await h.start();
  h.monitorBroken = true;
  const reset = await h.request('reset');
  assert.equal(reset.ok, false);
  assert.match(reset.error, /could not confirm cancellation/);
  assert.equal(h.store.state.runs[TENANT].running, false);
  assert.equal(h.store.state.pendingStops.length, 1);
  assert.ok(h.store.relayToken);
  await h.reload(); h.monitorBroken = false;
  assert.equal((await h.request('reset')).ok, true);
  assert.deepEqual(h.store, {});
  assert.equal(h.alarms.size, 0);
}));
