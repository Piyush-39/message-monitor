import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFailedMessages } from '../extension/poll.js';
import { unseenMessages, activeRun, DURATION, monitorTenant, monitorSelection, isTenantOrigin } from '../extension/core.js';
import { TENANT, TRIAL_TENANT, OTHER_TENANTS } from './fixtures.mjs';
import { createRelay, composeEmail } from '../relay/server.mjs';

function item(id, status = 'FAILED') {
  return {MessageGuid: id, Status: status, IntegrationFlowName: 'Test flow', LogEnd: '/Date(1791618585000)/'};
}
async function withSAP(fetcher, action) {
  const previous = {fetch: globalThis.fetch, location: globalThis.location};
  globalThis.location = new URL(TENANT);
  globalThis.fetch = fetcher;
  try { return await action(); }
  finally { globalThis.fetch = previous.fetch; globalThis.location = previous.location; }
}
function json(value) { return new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}}); }
test('captures selected technical artifact IDs and package from the applied page filters', () => {
  const filter = {artifactIds: ['flow-a', 'flow-b', 'flow-a'], packageId: 'package-a', status: 'ALL', time: 'PASTDAY'};
  const selection = monitorSelection(`${TENANT}/shell/monitoring/Messages/${encodeURIComponent(JSON.stringify(filter))}`);
  assert.deepEqual(selection, {filter, scope: {artifactIds: ['flow-a', 'flow-b'], packageId: 'package-a'}});
  for (const filter of [{}, {artifactIds: 'ALL', packageId: 'ALL'}, {artifactIds: []}]) {
    assert.deepEqual(monitorSelection(`${TENANT}/shell/monitoring/Messages/${encodeURIComponent(JSON.stringify(filter))}`).scope, {artifactIds: [], packageId: null});
  }
  assert.deepEqual(monitorSelection(`${TENANT}/shell/monitoring/Messages/`).scope, {artifactIds: [], packageId: null});
});
test('unreadable selected filters fail instead of starting unrestricted monitoring', () => {
  for (const filter of [null, [], {artifactIds: 'flow-a'}, {artifactIds: [null]}, {packageId: 42}]) {
    assert.throws(() => monitorSelection(`${TENANT}/shell/monitoring/Messages/${encodeURIComponent(JSON.stringify(filter))}`));
  }
  assert.throws(() => monitorSelection(`${TENANT}/shell/monitoring/Messages/%7B`), /Cannot read/);
});
test('uses exact artifact IDs with escaped OData literals and excludes other flows on every page', async () => {
  const scope = {artifactIds: ["flow'a", 'flow-b'], packageId: "package'a"};
  const scoped = (id, artifact, pkg = scope.packageId) => ({...item(id), IntegrationArtifact: {Id: artifact, PackageId: pkg, Name: 'Identical display name'}});
  let pages = 0;
  const records = await withSAP(async url => {
    if (++pages === 1) {
      assert.match(new URL(url).searchParams.get('$filter'), /and \(IntegrationArtifact\/Id eq 'flow''a' or IntegrationArtifact\/Id eq 'flow-b'\) and IntegrationArtifact\/PackageId eq 'package''a'$/);
      return json({d: {results: [scoped('selected-a', "flow'a"), scoped('unselected', 'flow-c')], __next: '/api/v1/MessageProcessingLogs?$skiptoken=two'}});
    }
    return json({d: {results: [scoped('selected-b', 'flow-b'), scoped('wrong-package', 'flow-b', 'other'), scoped('unselected-page-two', 'flow-c')]}});
  }, () => readFailedMessages(Date.now(), TENANT, scope));
  assert.deepEqual(records.map(record => record.id), ['selected-a', 'selected-b']);
  assert.equal(pages, 2);
});
test('package-only monitoring restricts results and missing scope metadata fails the check', async () => {
  const scoped = (id, pkg) => ({...item(id), IntegrationArtifact: {Id: 'flow-a', PackageId: pkg}});
  const records = await withSAP(async url => {
    const filter = new URL(url).searchParams.get('$filter');
    assert.match(filter, /IntegrationArtifact\/PackageId eq 'package-a'/);
    assert.doesNotMatch(filter, /IntegrationArtifact\/Id/);
    return json({d: {results: [scoped('in-package', 'package-a'), scoped('out-of-package', 'package-b')]}});
  }, () => readFailedMessages(Date.now(), TENANT, {packageId: 'package-a'}));
  assert.deepEqual(records.map(record => record.id), ['in-package']);
  for (const scope of [{artifactIds: ['flow-a']}, {packageId: 'package-a'}]) {
    await assert.rejects(withSAP(async () => json({d: {results: [item('missing-metadata')]}}), () => readFailedMessages(Date.now(), TENANT, scope)), /without its (artifact|package) ID/);
  }
});
test('reads authenticated FAILED messages and follows browser-route pagination', async () => {
  const urls = [];
  const records = await withSAP(async (url, options) => {
    urls.push(new URL(url));
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    if (urls.length === 1) return json({d: {results: [item('one'), item('complete', 'COMPLETED')], __next: `${TENANT}/api/v1/MessageProcessingLogs?$skiptoken=two`}});
    return json({d: {results: [item('two')]}});
  }, () => readFailedMessages(1791610000000, TENANT));
  assert.deepEqual(records.map(record => record.id), ['one', 'two']);
  assert.equal(records[0].time, '2026-10-10T07:49:45.000Z');
  assert.equal(urls[1].pathname, '/odata/api/v1/MessageProcessingLogs');
  assert.match(urls[0].searchParams.get('$filter'), /^Status eq 'FAILED' and LogEnd ge datetime'/);
  assert.match(records[0].url, /shell\/monitoring\/Messages\//);
});
test('empty results are healthy but login HTML, access errors and malformed data are not', async () => {
  assert.deepEqual(await withSAP(async () => json({d: {results: []}}), () => readFailedMessages(Date.now(), TENANT)), []);
  for (const response of [
    new Response('login', {headers: {'content-type': 'text/html'}}),
    new Response('', {status: 401}), new Response('', {status: 403}),
    new Response('', {status: 500}), json({d: {}}), json({d: {results: [item('')]}})
  ]) await assert.rejects(withSAP(async () => response, () => readFailedMessages(Date.now(), TENANT)));
});
test('rejects pagination loops and links outside the tenant', async () => {
  for (const next of ['https://example.com/api/v1/MessageProcessingLogs', `${TENANT}/api/v1/Attachments`]) {
    await assert.rejects(withSAP(async () => json({d: {results: [], __next: next}}), () => readFailedMessages(Date.now(), TENANT)), /pagination URL/);
  }
  await assert.rejects(withSAP(async url => json({d: {results: [], __next: url}}), () => readFailedMessages(Date.now(), TENANT)), /did not finish/);
});
test('deduplicates IDs while preserving distinct failures in the same flow/time', () => {
  const messages = [item('old'), item('new'), item('new'), item('other')].map(value => ({id: value.MessageGuid}));
  assert.deepEqual(unseenMessages(messages, ['old']).map(value => value.id), ['new', 'other']);
  assert.equal(DURATION, 9 * 3600000);
  assert.equal(activeRun({running: true, endsAt: 100}, 99), true);
  assert.equal(activeRun({running: true, endsAt: 100}, 100), false);
});
test('recognizes any HTTPS tenant monitor URL and rejects invalid pages/schemes/credentials', () => {
  for (const tenant of [TENANT, TRIAL_TENANT, ...OTHER_TENANTS]) assert.equal(monitorTenant(`${tenant}/shell/monitoring/Messages/%7B%7D`), tenant);
  for (const url of [undefined, 'not a url', 'http://tenant.example/shell/monitoring/Messages/', 'https://user:pass@tenant.example/shell/monitoring/Messages/', `${TENANT}/shell/design`, `${TENANT}/shell/monitoring/MessagesFake/`]) assert.equal(monitorTenant(url), null);
});
test('the same reader works on any tenant origin and rejects a tenant switch', async () => {
  await withSAP(async () => json({d: {results: [item('trial-message')]}}), async () => {
    for (const tenant of [TRIAL_TENANT, ...OTHER_TENANTS]) {
      globalThis.location = new URL(tenant);
      const messages = await readFailedMessages(Date.now(), tenant);
      assert.ok(messages[0].url.startsWith(tenant));
      await assert.rejects(readFailedMessages(Date.now(), TENANT), /left the tenant/);
    }
  });
});

async function relayFixture(action, transport) {
  const folder = await mkdtemp(join(tmpdir(), 'is-watchdog-'));
  const sent = [];
  const stateFile = join(folder, 'receipts.json');
  const token = 'a'.repeat(64);
  const mailer = transport || {async sendMail(mail) {sent.push(mail); return {accepted: ['recipient@gmail.com'], rejected: []};}};
  const config = {token, user: 'sender@gmail.com', recipient: 'recipient@gmail.com', transport: mailer, stateFile};
  const server = await createRelay(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (body, options = {}) => fetch(`${base}${body ? '/alert' : '/health'}`, {
    method: body ? 'POST' : 'GET', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers},
    ...(body ? {body: JSON.stringify(body)} : {})
  });
  try { await action({request, sent, config, base}); }
  finally { await new Promise(resolve => server.close(resolve)); await rm(folder, {recursive: true, force: true}); }
}
function failure(ids = ['a']) {
  return {kind: 'failures', tenant: TENANT, run: 1791610000000,
    messages: ids.map(id => ({id, flow: 'Test flow', time: '2026-10-10T08:00:00.000Z', url: `${TENANT}/shell/monitoring/Messages/${id}`}))};
}
test('local relay authenticates requests and fixes the recipient', async () => {
  await relayFixture(async ({request, sent}) => {
    assert.equal((await request(null)).status, 200);
    assert.equal((await request(null, {headers: {Authorization: 'Bearer wrong'}})).status, 401);
    assert.equal((await request(failure(), {headers: {Origin: 'https://example.com'}})).status, 403);
    assert.equal((await request(failure())).status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'recipient@gmail.com');
    assert.equal(sent[0].from, 'sender@gmail.com');
    assert.match(sent[0].text, /Status: FAILED/);
    assert.doesNotMatch(sent[0].text, /password|payload/i);
    assert.equal((await request({...failure(), tenant: 'https://example.com'})).status, 400);
  });
});
test('retries SMTP errors and suppresses duplicate/regrouped sends including persisted receipts', async () => {
  let attempts = 0;
  const mails = [];
  await relayFixture(async ({request, config}) => {
    assert.equal((await request(failure())).status, 502);
    assert.equal((await request(failure())).status, 200);
    assert.equal((await request(failure())).status, 200);
    assert.equal((await request(failure(['a', 'b']))).status, 200);
    assert.equal(mails.length, 2);
    assert.doesNotMatch(mails[1].text, /Message ID: a\n/);
    assert.match(mails[1].text, /Message ID: b/);
    const restarted = await createRelay(config);
    await new Promise(resolve => restarted.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${restarted.address().port}/alert`, {
        method: 'POST', headers: {Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(failure(['a', 'b']))
      });
      assert.equal(response.status, 200);
      assert.equal(mails.length, 2);
    } finally { await new Promise(resolve => restarted.close(resolve)); }
  }, {async sendMail(mail) {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('fake SMTP failure'), {code: 'ETEST'});
    mails.push(mail);
    return {accepted: ['recipient@gmail.com'], rejected: []};
  }});
});
test('test and monitoring-problem emails do not pretend a check succeeded', () => {
  assert.match(composeEmail({kind: 'problem', tenant: TENANT, problem: 'Session expired'}).text, /cannot currently confirm/);
  assert.match(composeEmail({kind: 'test'}).subject, /test email/);
});
test('trial-tenant alerts are accepted, links match the tenant, and receipts are isolated by tenant', async () => {
  await relayFixture(async ({request, sent}) => {
    const original = failure(['same-id']);
    const trial = {...original, tenant: TRIAL_TENANT, messages: original.messages.map(message => ({...message, url: message.url.replace(TENANT, TRIAL_TENANT)}))};
    assert.equal((await request(original)).status, 200);
    assert.equal((await request(trial)).status, 200);
    assert.equal(sent.length, 2);
    assert.ok(sent[1].text.includes(TRIAL_TENANT));
    assert.equal((await request({...trial, messages: original.messages})).status, 400);
  });
});

test('relay supports regional and custom origins while rejecting malformed tenant origins', async () => {
  for (const origin of [...OTHER_TENANTS, TENANT]) assert.equal(isTenantOrigin(origin), true);
  const invalid = ['http://tenant.example', 'https://user:pass@tenant.example', 'https://tenant.example/path', 'https://tenant.example/?x=1', 'https://tenant.example#x', 'https://tenant.example/', 'not a url'];
  for (const origin of invalid) assert.equal(isTenantOrigin(origin), false);
  await relayFixture(async ({request, sent}) => {
    for (const tenant of OTHER_TENANTS) {
      const alert = {...failure(['same-id']), tenant};
      alert.messages = alert.messages.map(message => ({...message, url: `${tenant}/shell/monitoring/Messages/${message.id}`}));
      assert.equal((await request(alert)).status, 200);
      assert.equal((await request(alert)).status, 200);
    }
    assert.equal(sent.length, OTHER_TENANTS.length);
    for (const tenant of invalid) assert.equal((await request({...failure(), tenant})).status, 400);
    const badLink = {...failure(), messages: failure().messages.map(message => ({...message, url: message.url.replace('https://', 'https://user:pass@')}))};
    assert.equal((await request(badLink)).status, 400);
  });
});
