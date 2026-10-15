import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DURATION} from '../extension/core.js';
import {createMonitoringWatch, validateMonitor, HEARTBEAT_TIMEOUT} from '../relay/monitor.mjs';
import {createRelay} from '../relay/server.mjs';
import {TENANT, TRIAL_TENANT} from './fixtures.mjs';
import {backgroundHarness, message, token} from './background-harness.mjs';

async function fixture(action) {
  const folder = await mkdtemp(join(tmpdir(), 'is-monitor-'));
  let clock = 1791800000000;
  let smtpBroken = false;
  const sent = [];
  const stateFile = join(folder, 'monitor.json');
  const options = {stateFile, now: () => clock, sendAlert: async alert => {
    if (smtpBroken) throw new Error('SMTP unavailable');
    sent.push(alert);
  }};
  const monitor = await createMonitoringWatch(options);
  const run = clock;
  const update = (tenant, action = 'heartbeat', startedAt = run) => ({action, tenant, run: startedAt,
    endsAt: startedAt + DURATION, lastCheck: clock, status: 'healthy'});
  try {await action({monitor, update, sent, stateFile,
    advance(ms) {clock += ms;}, setBroken(value) {smtpBroken = value;}, restart: () => createMonitoringWatch(options)});}
  finally {await rm(folder, {recursive: true, force: true});}
}
test('missed heartbeat emails only the interrupted tenant, once per outage', () => fixture(async f => {
  await f.monitor.receive(f.update(TENANT, 'start'));
  await f.monitor.receive(f.update(TRIAL_TENANT, 'start'));
  f.advance(HEARTBEAT_TIMEOUT - 1);
  await f.monitor.receive(f.update(TRIAL_TENANT));
  await f.monitor.check();
  assert.equal(f.sent.length, 0);
  f.advance(1); await f.monitor.check(); await f.monitor.check();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].kind, 'stopped');
  assert.equal(f.sent[0].tenant, TENANT);
  await f.monitor.receive(f.update(TENANT));
  f.advance(HEARTBEAT_TIMEOUT);
  await f.monitor.receive(f.update(TRIAL_TENANT));
  await f.monitor.check();
  assert.equal(f.sent.length, 2);
  assert.notEqual(f.sent[0].episode, f.sent[1].episode);
}));
test('manual Stop and scheduled expiry are silent, and stale Stop cannot cancel a new run', () => fixture(async f => {
  const old = f.update(TENANT, 'start');
  await f.monitor.receive(old);
  f.advance(1);
  const next = f.update(TENANT, 'start', old.run + 1);
  await f.monitor.receive(next);
  await f.monitor.receive({...old, action: 'stop'});
  assert.equal(Object.keys(JSON.parse(await readFile(f.stateFile, 'utf8'))).length, 1);
  f.advance(DURATION - 60000);
  await f.monitor.receive({...next, action: 'heartbeat', lastCheck: next.endsAt - 60000});
  f.advance(60000);
  await f.monitor.check();
  assert.equal(f.sent.length, 0);
  assert.equal(Object.keys(JSON.parse(await readFile(f.stateFile, 'utf8'))).length, 0);
  await f.monitor.receive(f.update(TRIAL_TENANT, 'start', next.endsAt));
  await f.monitor.receive({action: 'stop', tenant: TRIAL_TENANT, run: next.endsAt});
  f.advance(HEARTBEAT_TIMEOUT); await f.monitor.check();
  assert.equal(f.sent.length, 0);
}));
test('SMTP failure and relay restart retain pending notices even if monitoring recovers', () => fixture(async f => {
  await f.monitor.receive(f.update(TENANT, 'start'));
  f.advance(HEARTBEAT_TIMEOUT); f.setBroken(true);
  await f.monitor.check();
  assert.equal(f.sent.length, 0);
  const restarted = await f.restart();
  await restarted.receive(f.update(TENANT));
  f.setBroken(false); await restarted.check(); await restarted.check();
  assert.equal(f.sent.length, 1);
  const again = await f.restart(); await again.check();
  assert.equal(f.sent.length, 1);
}));
test('relay shutdown warns active tenants and a hard-crash gap is detected after restart', () => fixture(async f => {
  await f.monitor.receive(f.update(TENANT, 'start'));
  await f.monitor.receive(f.update(TRIAL_TENANT, 'start'));
  await f.monitor.shutdown(); await f.monitor.shutdown();
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[0].problem, /relay is stopping/);
  await f.monitor.receive(f.update(TENANT)); // Monitoring recovers after a restart.
  f.advance(HEARTBEAT_TIMEOUT);
  const restarted = await f.restart(); await restarted.check();
  assert.equal(f.sent.length, 3);
  assert.match(f.sent[2].problem, /heartbeat/);
}));
test('a missed gap during a run is reported on restart even if its nine-hour window has ended', () => fixture(async f => {
  await f.monitor.receive(f.update(TENANT, 'start'));
  f.advance(DURATION + 1);
  const restarted = await f.restart(); await restarted.check();
  assert.equal(f.sent.length, 1);
  assert.equal(Object.keys(JSON.parse(await readFile(f.stateFile, 'utf8'))).length, 0);
}));
test('monitor updates require canonical HTTPS tenants and a valid nine-hour window', () => {
  const run = 1791800000000;
  const good = {action: 'start', tenant: TENANT, run, endsAt: run + DURATION, lastCheck: run, status: 'healthy'};
  assert.equal(validateMonitor(good), good);
  for (const changed of [{tenant: 'http://example.com'}, {tenant: 'https://user:pass@example.com'}, {action: 'delete'},
    {endsAt: run + 1}, {lastCheck: run - 1}, {lastCheck: run + DURATION + 1}, {status: 'made-up'}]) assert.throws(() => validateMonitor({...good, ...changed}));
  assert.doesNotThrow(() => validateMonitor({action: 'stop', tenant: TENANT, run}));
});

test('real extension scripts → authenticated HTTP relay → mail delivery and missing-poll alerts', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'is-end-to-end-'));
  const mails = [];
  const nativeFetch = globalThis.fetch;
  const config = {token, user: 'sender@gmail.com', recipient: 'recipient@gmail.com', stateFile: join(folder, 'receipts.json'),
    now: () => Date.now(), transport: {async sendMail(mail) {mails.push(mail); return {accepted: ['recipient@gmail.com'], rejected: []};}}};
  let server, h;
  try {
    server = await createRelay(config);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    h = await backgroundHarness({relayFetch: (url, options) => nativeFetch(`${base}${new URL(url).pathname}`, options)});
    h.tabs.get(1).url += encodeURIComponent(JSON.stringify({artifactIds: ['selected-flow'], packageId: 'selected-package'}));
    const scoped = (id, status = 'FAILED') => ({...message(id), Status: status, IntegrationArtifact: {Id: 'selected-flow', PackageId: 'selected-package'}});
    const baseline = scoped('old-processing', 'PROCESSING');
    h.sap.set(TENANT, [baseline]);
    h.sapErrors.set(`${TENANT}:same-id`, 'Receiver HTTP 500: Order service unavailable\nCaused by: connection refused');
    h.sapErrors.set(`${TRIAL_TENANT}:same-id`, 'Trial tenant receiver authentication failed');
    h.sapErrors.set(`${TENANT}:retry`, new Response('Error service down', {status: 500}));
    assert.equal((await h.start()).ok, true);
    assert.equal((await h.start(TRIAL_TENANT)).ok, true);
    assert.equal(h.errorReads.length, 0); // Baselines do not fetch exception details.
    h.sap.set(TENANT, [
      baseline,
      scoped('same-id'),
      ...['RETRY', 'PROCESSING', 'ESCALATED', 'CANCELLED', 'DISCARDED', 'ABANDONED', 'COMPLETED'].map(status => ({...scoped(status.toLowerCase(), status), LogEnd: null, LogStart: '/Date(1791610000000)/'})),
      {...message('excluded-flow'), IntegrationArtifact: {Id: 'other-flow', PackageId: 'selected-package'}},
      {...message('excluded-package'), IntegrationArtifact: {Id: 'selected-flow', PackageId: 'other-package'}}
    ]);
    h.sap.set(TRIAL_TENANT, [message('same-id')]);
    h.time += 60000;
    await h.poll(); await h.poll();
    assert.equal(mails.length, 2);
    assert.ok(mails.every(mail => mail.to === 'recipient@gmail.com'));
    assert.ok(mails.some(mail => mail.subject.includes(new URL(TENANT).hostname)));
    assert.ok(mails.some(mail => mail.subject.includes(new URL(TRIAL_TENANT).hostname)));
    assert.ok(mails.every(mail => /Message ID: same-id/.test(mail.text) && !/excluded-flow|excluded-package|old-processing|Status: COMPLETED/.test(mail.text)));
    const tenantMail = mails.find(mail => mail.subject.includes(new URL(TENANT).hostname));
    assert.match(tenantMail.subject, /7 new non-Completed messages/);
    assert.match(tenantMail.text, /Error: Receiver HTTP 500: Order service unavailable\nCaused by: connection refused/);
    assert.match(tenantMail.text, /Error: Error details unavailable\./);
    assert.match(tenantMail.text, /Error: No error information available\./);
    assert.doesNotMatch(tenantMail.text, /Trial tenant receiver|Error service down/);
    assert.match(mails.find(mail => mail !== tenantMail).text, /Error: Trial tenant receiver authentication failed/);
    assert.equal(h.errorReads.length, 7);
    assert.ok(h.errorReads.every(read => !['old-processing', 'excluded-flow', 'excluded-package', 'completed', 'discarded'].includes(read.id)));
    for (const status of ['FAILED', 'RETRY', 'PROCESSING', 'ESCALATED', 'CANCELLED', 'DISCARDED', 'ABANDONED']) assert.ok(tenantMail.text.includes(`Status: ${status}\n`));
    assert.equal(h.store.state.runs[TENANT].sent, 7);
    h.sap.set(TENANT, [scoped('processing', 'FAILED'), scoped('completed', 'COMPLETED')]);
    await h.reload(); await h.poll();
    assert.equal(mails.length, 2); // Status transitions/restarts do not re-email an observed ID.
    assert.equal(h.errorReads.length, 7); // Previously seen IDs are not enriched again either.
    assert.equal((await h.request('updateStatuses', TENANT, {emailStatuses: ['RETRY']})).ok, true);
    h.sap.set(TENANT, [scoped('selected-retry', 'RETRY'), scoped('unchecked-failed', 'FAILED'), {...scoped('unchecked-package', 'RETRY'), IntegrationArtifact: {Id: 'selected-flow', PackageId: 'other-package'}}]);
    await h.reload(); await h.poll(); await h.poll();
    assert.equal(mails.length, 3);
    assert.match(mails[2].text, /Status: RETRY\n/);
    assert.match(mails[2].text, /Message ID: selected-retry/);
    assert.doesNotMatch(mails[2].text, /unchecked-failed|unchecked-package/);
    h.time += HEARTBEAT_TIMEOUT;
    await server.checkMonitoring(); await server.checkMonitoring();
    assert.equal(mails.length, 5);
    assert.ok(mails.slice(3).every(mail => /monitoring stopped/.test(mail.subject)));
    await h.request('stop', TENANT); await h.request('stop', TRIAL_TENANT);
    const invalid = await nativeFetch(`${base}/monitor`, {method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({action: 'start', tenant: 'http://bad.example'})});
    assert.equal(invalid.status, 400);
    const forbidden = await nativeFetch(`${base}/monitor`, {method: 'POST', headers: {Authorization: 'Bearer wrong', 'Content-Type': 'application/json'}, body: '{}'});
    assert.equal(forbidden.status, 401);
    await server.notifyShutdown();
    assert.equal(mails.length, 5); // Expected Stop disarms shutdown notices too.
  } finally {
    if (h) h.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(folder, {recursive: true, force: true});
  }
});
