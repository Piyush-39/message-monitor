import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMonitoringWatch, validateMonitor, HEARTBEAT_TIMEOUT} from '../relay/monitor.mjs';
import {createRelay, composeEmail, validateAlert, alertKey} from '../relay/server.mjs';
import {discordMessage} from '../relay/discord.mjs';
import {teamsMessage} from '../relay/teams.mjs';
import {TENANT, TRIAL_TENANT} from './fixtures.mjs';
import {backgroundHarness, message, token} from './background-harness.mjs';
const LEGACY_DURATION = 9 * 3600000;

async function fixture(action) {
  const folder = await mkdtemp(join(tmpdir(), 'is-monitor-'));
  let clock = 1791800000000;
  let smtpBroken = false;
  const sent = [], all = [];
  const stateFile = join(folder, 'monitor.json');
  const options = {stateFile, now: () => clock, sendAlert: async alert => {
    if (smtpBroken) throw new Error('SMTP unavailable');
    all.push(alert);
    if (alert.kind === 'stopped') sent.push(alert);
  }};
  const monitor = await createMonitoringWatch(options);
  const run = clock;
  const update = (tenant, action = 'heartbeat', startedAt = run) => ({action, tenant, run: startedAt,
    endsAt: null, lastCheck: clock, status: 'healthy'});
  try {await action({monitor, update, sent, all, stateFile,
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
  f.advance(HEARTBEAT_TIMEOUT - 2);
  await f.monitor.receive(f.update(TRIAL_TENANT));
  f.advance(2);
  await f.monitor.check();
  assert.equal(f.sent.length, 2);
  assert.notEqual(f.sent[0].episode, f.sent[1].episode);
}));
test('manual Stop is silent, stale Stop cannot cancel a new run, and runs have no expiry', () => fixture(async f => {
  const old = f.update(TENANT, 'start');
  await f.monitor.receive(old);
  f.advance(1);
  const next = f.update(TENANT, 'start', old.run + 1);
  await f.monitor.receive(next);
  await f.monitor.receive({...old, action: 'stop'});
  await f.monitor.check();
  assert.equal(Object.keys(JSON.parse(await readFile(f.stateFile, 'utf8'))).length, 1);
  f.advance(3 * 24 * 3600000);
  await f.monitor.receive({...f.update(TENANT, 'heartbeat', next.run)});
  f.advance(60000);
  await f.monitor.check();
  assert.equal(f.sent.length, 1); // The three-day heartbeat gap is detected on reconnect.
  assert.ok(f.all.some(alert => alert.kind === 'resumed'));
  assert.equal(Object.keys(JSON.parse(await readFile(f.stateFile, 'utf8'))).length, 1);
  await f.monitor.receive({...next, action: 'stop'});
  await f.monitor.receive(f.update(TRIAL_TENANT, 'start', next.run));
  await f.monitor.receive({action: 'stop', tenant: TRIAL_TENANT, run: next.run});
  f.advance(HEARTBEAT_TIMEOUT); await f.monitor.check();
  assert.equal(f.sent.length, 1); // Manual stops add no interruption notice.
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
  f.advance(1);
  await f.monitor.receive(f.update(TENANT)); // A fresh SAP check confirms recovery after restart.
  f.advance(HEARTBEAT_TIMEOUT);
  const restarted = await f.restart(); await restarted.check();
  assert.equal(f.sent.length, 3);
  assert.match(f.sent[2].problem, /heartbeat/);
}));
test('unlimited runs still report a missed heartbeat after days and a relay restart', () => fixture(async f => {
  await f.monitor.receive(f.update(TENANT, 'start'));
  f.advance(3 * 24 * 3600000);
  const restarted = await f.restart(); await restarted.check();
  assert.equal(f.sent.length, 1);
  assert.equal(Object.keys(JSON.parse(await readFile(f.stateFile, 'utf8'))).length, 1);
  await restarted.receive(f.update(TENANT));
  f.advance(HEARTBEAT_TIMEOUT); await restarted.check();
  assert.equal(f.sent.length, 2);
}));
test('monitor updates require canonical HTTPS tenants and valid unlimited or legacy windows', () => {
  const run = 1791800000000;
  const good = {action: 'start', tenant: TENANT, run, endsAt: null, lastCheck: run, status: 'healthy'};
  assert.equal(validateMonitor(good), good);
  assert.doesNotThrow(() => validateMonitor({...good, lastCheck: run + 30 * 86400000}));
  assert.doesNotThrow(() => validateMonitor({...good, endsAt: run + LEGACY_DURATION}));
  assert.throws(() => validateMonitor({...good, endsAt: run + LEGACY_DURATION, lastCheck: run + LEGACY_DURATION + 1}));
  for (const changed of [{tenant: 'http://example.com'}, {tenant: 'https://user:pass@example.com'}, {action: 'delete'},
    {endsAt: run - 1}, {endsAt: undefined}, {endsAt: 'forever'}, {endsAt: -1}, {lastCheck: run - 1}, {lastCheck: Infinity}, {status: 'made-up'},
    {phase: {}}, {phase: 'x'.repeat(101)}, {problem: 42}, {problem: 'x'.repeat(401)}]) assert.throws(() => validateMonitor({...good, ...changed}));
  assert.doesNotThrow(() => validateMonitor({action: 'stop', tenant: TENANT, run}));
});

test('interruption notices preserve the last concrete problem, activity and IST timestamps across restart', () => fixture(async f => {
  const problem = 'SAP denied monitoring access (HTTP 403). Check your SAP monitoring permissions.';
  const update = {...f.update(TENANT, 'start'), status: 'problem', problem, phase: 'Reading SAP messages'};
  await f.monitor.receive(update);
  f.advance(HEARTBEAT_TIMEOUT);
  const restarted = await f.restart();
  await restarted.check();
  const notice = f.sent[0].problem;
  assert.match(notice, /no extension heartbeat for 3 minutes/);
  assert.match(notice, /Last heartbeat: .* IST\. Last successful SAP check: .* IST/);
  assert.match(notice, /Last activity: Reading SAP messages/);
  assert.ok(notice.includes(problem));
  assert.match(notice, /exact cause is unknown/);
  assert.match(notice, /session expiry is not confirmed/);
}));

test('HTTP heartbeats are acknowledged and persisted while SMTP delivery is blocked', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'is-heartbeat-'));
  let release, entered;
  const sending = new Promise(resolve => {entered = resolve;});
  const blocked = new Promise(resolve => {release = resolve;});
  let server, alertRequest;
  const now = Date.now();
  try {
    server = await createRelay({token, user: 'sender@gmail.com', recipient: 'recipient@gmail.com', stateFile: join(folder, 'state.json'), transport: {
      async sendMail() {entered(); await blocked; return {accepted: ['recipient@gmail.com'], rejected: []};}
    }});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(1500)});
    alertRequest = post('/alert', {kind: 'test', nonce: 'blocked-mail'});
    await sending;
    const heartbeat = await post('/monitor', {action: 'start', tenant: TENANT, run: now, endsAt: null,
      lastCheck: now, status: 'healthy', phase: 'Handing message alerts to notification relay'});
    assert.equal(heartbeat.status, 200);
    const leases = JSON.parse(await readFile(join(folder, 'state.json.monitoring'), 'utf8'));
    assert.equal(leases[`${TENANT}:${now}`].lastCheck, now);
  } finally {
    release();
    if (alertRequest) await alertRequest;
    if (server) {await server.checkMonitoring(); await new Promise(resolve => server.close(resolve));}
    await rm(folder, {recursive: true, force: true});
  }
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
    await server.checkMonitoring();
    assert.equal(mails.filter(mail => /monitoring started/.test(mail.subject)).length, 2);
    mails.length = 0;
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
    assert.equal(mails.length, 8);
    assert.ok(mails.every(mail => mail.to === 'recipient@gmail.com'));
    assert.ok(mails.some(mail => mail.subject.includes(new URL(TENANT).hostname)));
    assert.ok(mails.some(mail => mail.subject.includes(new URL(TRIAL_TENANT).hostname)));
    assert.ok(mails.every(mail => (mail.text.match(/Message ID: /g) || []).length === 1 && !/excluded-flow|excluded-package|old-processing|Status: COMPLETED/.test(mail.text)));
    assert.equal(new Set(mails.map(mail => mail.subject)).size, 8);
    const tenantMails = mails.filter(mail => mail.subject.includes(new URL(TENANT).hostname));
    assert.equal(tenantMails.length, 7);
    const tenantMail = tenantMails.find(mail => mail.text.includes('Message ID: same-id\n'));
    assert.match(tenantMail.subject, /^\[FAILED\] flow — IS Watchdog — /);
    assert.ok(tenantMail.html.includes('>FAILED</span>'));
    assert.ok(tenantMail.html.includes('>flow</h1>'));
    assert.match(tenantMail.text, /Error: Receiver HTTP 500: Order service unavailable\nCaused by: connection refused/);
    assert.ok(tenantMails.some(mail => /Error: Error details unavailable\./.test(mail.text)));
    assert.ok(tenantMails.some(mail => /Error: No error information available\./.test(mail.text)));
    assert.doesNotMatch(tenantMail.text, /Trial tenant receiver|Error service down/);
    assert.match(mails.find(mail => mail.subject.includes(new URL(TRIAL_TENANT).hostname)).text, /Error: Trial tenant receiver authentication failed/);
    assert.equal(h.errorReads.length, 7);
    assert.ok(h.errorReads.every(read => !['old-processing', 'excluded-flow', 'excluded-package', 'completed', 'discarded'].includes(read.id)));
    for (const status of ['FAILED', 'RETRY', 'PROCESSING', 'ESCALATED', 'CANCELLED', 'DISCARDED', 'ABANDONED']) assert.ok(tenantMails.some(mail => mail.text.includes(`Status: ${status}\n`)));
    assert.equal(h.store.state.runs[TENANT].sent, 7);
    h.sap.set(TENANT, [scoped('processing', 'FAILED'), scoped('completed', 'COMPLETED')]);
    await h.reload(); await h.poll();
    assert.equal(mails.length, 8); // Status transitions/restarts do not re-email an observed ID.
    assert.equal(h.errorReads.length, 7); // Previously seen IDs are not enriched again either.
    assert.equal((await h.request('updateStatuses', TENANT, {emailStatuses: ['RETRY']})).ok, true);
    h.sap.set(TENANT, [scoped('selected-retry', 'RETRY'), scoped('unchecked-failed', 'FAILED'), {...scoped('unchecked-package', 'RETRY'), IntegrationArtifact: {Id: 'selected-flow', PackageId: 'other-package'}}]);
    await h.reload(); await h.poll(); await h.poll();
    assert.equal(mails.length, 9);
    assert.match(mails[8].text, /Status: RETRY\n/);
    assert.match(mails[8].text, /Message ID: selected-retry/);
    assert.doesNotMatch(mails[8].text, /unchecked-failed|unchecked-package/);
    h.time += HEARTBEAT_TIMEOUT;
    await server.checkMonitoring(); await server.checkMonitoring();
    assert.equal(mails.length, 11);
    assert.ok(mails.slice(9).every(mail => /monitoring stopped/.test(mail.subject)));
    await h.request('stop', TENANT); await h.request('stop', TRIAL_TENANT);
    const invalid = await nativeFetch(`${base}/monitor`, {method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({action: 'start', tenant: 'http://bad.example'})});
    assert.equal(invalid.status, 400);
    const forbidden = await nativeFetch(`${base}/monitor`, {method: 'POST', headers: {Authorization: 'Bearer wrong', 'Content-Type': 'application/json'}, body: '{}'});
    assert.equal(forbidden.status, 401);
    await server.notifyShutdown();
    assert.equal(mails.length, 11); // Expected Stop disarms shutdown notices too.
  } finally {
    if (h) h.close();
    if (server) {await server.checkMonitoring(); await new Promise(resolve => server.close(resolve));}
    await rm(folder, {recursive: true, force: true});
  }
});

test('a persisted legacy lease can upgrade to unlimited without losing pending outage notices', () => fixture(async f => {
  const old = {...f.update(TENANT, 'start'), endsAt: f.update(TENANT).run + LEGACY_DURATION};
  await f.monitor.receive(old);
  f.advance(HEARTBEAT_TIMEOUT); f.setBroken(true);
  await f.monitor.check();
  const restarted = await f.restart();
  await restarted.receive(f.update(TENANT));
  f.advance(LEGACY_DURATION + 1);
  await restarted.receive(f.update(TENANT));
  f.setBroken(false); await restarted.check();
  assert.equal(f.sent.length, 2); // Both distinct outages survive recovery before delivery.
  const lease = Object.values(JSON.parse(await readFile(f.stateFile, 'utf8')))[0];
  assert.equal(lease.endsAt, null);
  await restarted.shutdown();
  // Recovery rearms interruption reporting for a later relay shutdown.
  assert.equal(f.sent.length, 3);
}));
test('finite leases from older extensions still expire silently after a recent heartbeat', () => fixture(async f => {
  const old = {...f.update(TENANT, 'start'), endsAt: f.update(TENANT).run + 120000};
  await f.monitor.receive(old);
  f.advance(60000);
  await f.monitor.receive({...old, action: 'heartbeat', lastCheck: old.endsAt - 60000});
  f.advance(60000); await f.monitor.check();
  assert.equal(f.sent.length, 0);
  assert.deepEqual(JSON.parse(await readFile(f.stateFile, 'utf8')), {});
}));

test('manual starts notify once per tenant and run, including a new start after Stop', () => fixture(async f => {
  const first = f.update(TENANT, 'start');
  await f.monitor.receive(first); await f.monitor.receive(first);
  await f.monitor.receive(f.update(TRIAL_TENANT, 'start'));
  await f.monitor.check();
  assert.deepEqual(f.all.map(alert => [alert.kind, alert.tenant]), [['started', TENANT], ['started', TRIAL_TENANT]]);
  assert.match(f.all[0].problem, /started by you/);
  assert.match(f.all[0].problem, /Time: .* IST/);
  const restarted = await f.restart();
  await restarted.receive(first); await restarted.check();
  assert.equal(f.all.length, 2);
  await restarted.receive({...first, action: 'stop'});
  f.advance(1);
  await restarted.receive(f.update(TENANT, 'start', first.run + 1));
  await restarted.check();
  assert.deepEqual(f.all.map(alert => alert.kind), ['started', 'started', 'started']);
}));

test('recovery needs a newer successful SAP check and emits once per interruption', () => fixture(async f => {
  const first = f.update(TENANT, 'start');
  await f.monitor.receive(first); await f.monitor.check();
  await f.monitor.receive({...first, action: 'heartbeat', status: 'problem', problem: 'SAP session expired'});
  f.advance(60000);
  await f.monitor.receive({...first, action: 'heartbeat'}); // Worker alive, SAP has not checked again.
  await f.monitor.check();
  assert.deepEqual(f.all.map(alert => alert.kind), ['started']);
  await f.monitor.receive(f.update(TENANT)); await f.monitor.check();
  assert.deepEqual(f.all.map(alert => alert.kind), ['started', 'resumed']);
  assert.match(f.all[1].problem, /SAP session expired/);
  const restarted = await f.restart();
  await restarted.receive(f.update(TENANT)); await restarted.check();
  assert.equal(f.all.length, 2);
  await restarted.receive({...f.update(TENANT), status: 'problem', problem: 'Relay connection interrupted'});
  f.advance(60000);
  await restarted.receive(f.update(TENANT)); await restarted.check();
  assert.equal(f.all[2].kind, 'resumed');
  assert.notEqual(f.all[1].episode, f.all[2].episode);
  assert.match(f.all[2].problem, /Relay connection interrupted/);
}));

test('sleep gaps and relay restarts preserve ordered start, interruption and recovery alerts through delivery failures', () => fixture(async f => {
  f.setBroken(true);
  await f.monitor.receive(f.update(TENANT, 'start'));
  await f.monitor.check();
  f.advance(HEARTBEAT_TIMEOUT);
  const restarted = await f.restart();
  await restarted.receive(f.update(TENANT)); // No timer ran during sleep.
  await restarted.check();
  assert.equal(f.all.length, 0);
  const again = await f.restart();
  f.setBroken(false); await again.check(); await again.check();
  assert.deepEqual(f.all.map(alert => alert.kind), ['started', 'stopped', 'resumed']);
  assert.equal(f.all[1].episode, f.all[2].episode);
  assert.match(f.all[2].problem, /no extension heartbeat/);
}));

test('shutdown recovery waits for fresh SAP progress and registration of legacy runs sends no false start', () => fixture(async f => {
  const initial = f.update(TENANT);
  await f.monitor.receive(initial); await f.monitor.check();
  assert.equal(f.all.length, 0);
  await f.monitor.shutdown();
  const restarted = await f.restart();
  await restarted.receive(initial); await restarted.check();
  assert.deepEqual(f.all.map(alert => alert.kind), ['stopped']);
  f.advance(60000);
  await restarted.receive(f.update(TENANT)); await restarted.check();
  assert.deepEqual(f.all.map(alert => alert.kind), ['stopped', 'resumed']);
  assert.match(f.all[1].problem, /relay is stopping/);
}));

test('old outage records migrate without duplicating sent notices or losing a pending recovery', () => fixture(async f => {
  const initial = f.update(TENANT);
  await writeFile(f.stateFile, JSON.stringify({[`${TENANT}:${initial.run}`]: {...initial, lastContact: initial.run,
    notice: {episode: initial.run, sent: true, problem: 'Computer was offline'}}}));
  const upgraded = await f.restart();
  f.advance(60000);
  await upgraded.receive(f.update(TENANT)); await upgraded.check();
  assert.deepEqual(f.all.map(alert => alert.kind), ['resumed']);
  assert.equal(f.all[0].episode, initial.run);
}));

test('a stale heartbeat cannot reintroduce a resolved problem or regress SAP progress', () => fixture(async f => {
  const old = {...f.update(TENANT), status: 'problem', problem: 'Old problem'};
  await f.monitor.receive(old);
  f.advance(60000);
  const fresh = f.update(TENANT);
  await f.monitor.receive(fresh); await f.monitor.check();
  await f.monitor.receive(old); await f.monitor.check();
  assert.deepEqual(f.all.map(alert => alert.kind), ['resumed']);
  const [lease] = Object.values(JSON.parse(await readFile(f.stateFile, 'utf8')));
  assert.equal(lease.lastCheck, fresh.lastCheck);
  assert.equal(lease.status, 'healthy');
}));


test('start and recovery alerts validate and render clearly in email, Discord and Teams', () => {
  for (const kind of ['started', 'resumed']) {
    const alert = {kind, tenant: TENANT, run: 123, episode: 456,
      problem: 'Monitoring event. Time: 22/10/2026, 22:00:00 IST. @everyone'};
    assert.equal(validateAlert(alert), alert);
    assert.notEqual(alertKey(alert), alertKey({...alert, episode: 457}));
    const email = composeEmail(alert);
    assert.match(email.subject, new RegExp(`monitoring ${kind}`));
    assert.ok(email.text.includes(new URL(TENANT).hostname));
    const discord = discordMessage(alert);
    assert.match(discord.embeds[0].title, new RegExp(`monitoring ${kind}`));
    assert.equal(discord.embeds[0].color, 0x15803d);
    assert.equal(discord.embeds[0].url, `${TENANT}/shell/monitoring`);
    assert.deepEqual(discord.allowed_mentions, {parse: []});
    const teams = teamsMessage(alert).attachments[0].content;
    assert.match(teams.body[0].text, new RegExp(`monitoring ${kind}`));
    assert.equal(teams.body[0].color, 'Good');
    assert.ok(JSON.stringify(teams).includes('22/10/2026'));
    assert.equal(teams.actions[0].url, `${TENANT}/shell/monitoring`);
    assert.throws(() => validateAlert({...alert, episode: 'invalid'}));
  }
});
