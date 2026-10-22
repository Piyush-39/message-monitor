import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNonCompletedMessages } from '../extension/poll.js';
import { unseenMessages, activeRun, monitorTenant, monitorSelection, isTenantOrigin } from '../extension/core.js';
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
  }, () => readNonCompletedMessages(Date.now(), TENANT, scope));
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
  }, () => readNonCompletedMessages(Date.now(), TENANT, {packageId: 'package-a'}));
  assert.deepEqual(records.map(record => record.id), ['in-package']);
  for (const scope of [{artifactIds: ['flow-a']}, {packageId: 'package-a'}]) {
    await assert.rejects(withSAP(async () => json({d: {results: [item('missing-metadata')]}}), () => readNonCompletedMessages(Date.now(), TENANT, scope)), /without its (artifact|package) ID/);
  }
});
test('reads authenticated non-Completed messages and follows browser-route pagination', async () => {
  const urls = [];
  const records = await withSAP(async (url, options) => {
    urls.push(new URL(url));
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    if (urls.length === 1) return json({d: {results: [item('one'), item('complete', 'COMPLETED')], __next: `${TENANT}/api/v1/MessageProcessingLogs?$skiptoken=two`}});
    return json({d: {results: [item('two')]}});
  }, () => readNonCompletedMessages(1791610000000, TENANT));
  assert.deepEqual(records.map(record => record.id), ['one', 'two']);
  assert.equal(records[0].time, '2026-10-10T07:49:45.000Z');
  assert.equal(urls[1].pathname, '/odata/api/v1/MessageProcessingLogs');
  assert.match(urls[0].searchParams.get('$filter'), /^Status ne 'COMPLETED' and \(LogStart ge datetime'.*' or LogEnd ge datetime'.*'\)/);
  assert.match(records[0].url, /shell\/monitoring\/Messages\//);
});
test('includes every non-Completed status across pages, including messages without an end time', async () => {
  const statuses = ['FAILED', 'RETRY', 'PROCESSING', 'ESCALATED', 'CANCELLED', 'DISCARDED', 'ABANDONED'];
  let page = 0;
  const records = await withSAP(async url => {
    if (++page === 1) {
      const filter = new URL(url).searchParams.get('$filter');
      assert.equal(filter, "Status ne 'COMPLETED' and (LogStart ge datetime'2026-10-10T05:26:40' or LogEnd ge datetime'2026-10-10T05:26:40')");
      assert.equal(new URL(url).searchParams.get('$orderby'), 'LogStart desc');
      return json({d: {results: [...statuses.slice(0, 3).map(status => ({...item(status, status), LogEnd: null, LogStart: '/Date(1791618585000)/'})), item('completed', 'COMPLETED')], __next: '/api/v1/MessageProcessingLogs?$skiptoken=two'}});
    }
    return json({d: {results: [...statuses.slice(3).map(status => item(status, status)), item('completed-page-two', 'COMPLETED')]}});
  }, () => readNonCompletedMessages(1791610000000, TENANT));
  assert.deepEqual(records.map(record => record.status), statuses);
  assert.equal(records[2].time, '2026-10-10T07:49:45.000Z');
});
test('empty results are healthy but login HTML, access errors and malformed data are not', async () => {
  assert.deepEqual(await withSAP(async () => json({d: {results: []}}), () => readNonCompletedMessages(Date.now(), TENANT)), []);
  for (const response of [
    new Response('login', {headers: {'content-type': 'text/html'}}),
    new Response('', {status: 401}), new Response('', {status: 403}),
    new Response('', {status: 500}), json({d: {}}), json({d: {results: [item('')]}})
  ]) await assert.rejects(withSAP(async () => response, () => readNonCompletedMessages(Date.now(), TENANT)));
});

test('script envelopes identify authentication redirects without following them or exposing response bodies', async () => {
  for (const response of [new Response(null, {status: 302}), {type: 'opaqueredirect', status: 0}]) {
    const result = await withSAP(async (url, options) => {
      assert.equal(options.redirect, 'manual');
      return response;
    }, () => readNonCompletedMessages(Date.now(), TENANT, {}, undefined, true));
    assert.equal(result.ok, false);
    assert.match(result.error, /SAP redirected the monitoring request/);
  }
  const malformed = await withSAP(async () => new Response('private-response', {headers: {'content-type': 'application/json'}}),
    () => readNonCompletedMessages(Date.now(), TENANT, {}, undefined, true));
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /invalid JSON/);
  assert.doesNotMatch(malformed.error, /private-response/);
});
test('selected statuses constrain SAP queries and every response page together with artifact filters', async () => {
  const selected = (id, status = 'FAILED', artifact = 'flow-a') => ({...item(id, status), IntegrationArtifact: {Id: artifact}});
  let pages = 0;
  const records = await withSAP(async url => {
    if (++pages === 1) {
      const filter = new URL(url).searchParams.get('$filter');
      assert.match(filter, /^\(Status eq 'FAILED' or Status eq 'RETRY'\) and \(LogStart/);
      assert.match(filter, /and \(IntegrationArtifact\/Id eq 'flow-a'\)$/);
      return json({d: {results: [selected('failed'), selected('processing', 'PROCESSING')], __next: '/api/v1/MessageProcessingLogs?$skiptoken=two'}});
    }
    return json({d: {results: [selected('retry', 'RETRY'), selected('other-flow', 'FAILED', 'other'), selected('completed', 'COMPLETED')]}});
  }, () => readNonCompletedMessages(Date.now(), TENANT, {artifactIds: ['flow-a']}, ['FAILED', 'RETRY']));
  assert.deepEqual(records.map(record => record.id), ['failed', 'retry']);
  for (const statuses of [[], null, ['COMPLETED'], ['ALL'], ["FAILED' or true"], 'FAILED']) {
    await assert.rejects(withSAP(async () => {throw new Error('Should not fetch');}, () => readNonCompletedMessages(Date.now(), TENANT, {}, statuses)), /Invalid email status selection/);
  }
});
test('rejects pagination loops and links outside the tenant', async () => {
  for (const next of ['https://example.com/api/v1/MessageProcessingLogs', `${TENANT}/api/v1/Attachments`]) {
    await assert.rejects(withSAP(async () => json({d: {results: [], __next: next}}), () => readNonCompletedMessages(Date.now(), TENANT)), /pagination URL/);
  }
  await assert.rejects(withSAP(async url => json({d: {results: [], __next: url}}), () => readNonCompletedMessages(Date.now(), TENANT)), /did not finish/);
});
test('deduplicates IDs while preserving distinct failures in the same flow/time', () => {
  const messages = [item('old'), item('new'), item('new'), item('other')].map(value => ({id: value.MessageGuid}));
  assert.deepEqual(unseenMessages(messages, ['old']).map(value => value.id), ['new', 'other']);
  assert.equal(activeRun({running: true, endsAt: 100}, 99), true);
  assert.equal(activeRun({running: true, endsAt: 100}, 100), true);
  assert.equal(activeRun({running: true, endsAt: null}, 30 * 86400000), true);
  assert.equal(activeRun({running: false, endsAt: null}), false);
});
test('recognizes any HTTPS tenant monitor URL and rejects invalid pages/schemes/credentials', () => {
  for (const tenant of [TENANT, TRIAL_TENANT, ...OTHER_TENANTS]) assert.equal(monitorTenant(`${tenant}/shell/monitoring/Messages/%7B%7D`), tenant);
  for (const url of [undefined, 'not a url', 'http://tenant.example/shell/monitoring/Messages/', 'https://user:pass@tenant.example/shell/monitoring/Messages/', `${TENANT}/shell/design`, `${TENANT}/shell/monitoring/MessagesFake/`]) assert.equal(monitorTenant(url), null);
});
test('the same reader works on any tenant origin and rejects a tenant switch', async () => {
  await withSAP(async () => json({d: {results: [item('trial-message')]}}), async () => {
    for (const tenant of [TRIAL_TENANT, ...OTHER_TENANTS]) {
      globalThis.location = new URL(tenant);
      const messages = await readNonCompletedMessages(Date.now(), tenant);
      assert.ok(messages[0].url.startsWith(tenant));
      await assert.rejects(readNonCompletedMessages(Date.now(), TENANT), /left the tenant/);
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
  await relayFixture(async ({request, sent, base, config}) => {
    const health = await request(null);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {ok: true});
    assert.equal((await fetch(`${base}/report`, {
      method: 'POST', headers: {Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json'}, body: '{}'
    })).status, 404);
    assert.equal(sent.length, 0);
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
test('relay emails actual statuses, rejects Completed and malformed statuses, and deduplicates IDs across status changes', async () => {
  const alert = {...failure(), kind: 'messages'};
  const statuses = ['FAILED', 'RETRY', 'PROCESSING', 'ESCALATED', 'CANCELLED', 'DISCARDED', 'ABANDONED'];
  alert.messages = statuses.map(status => ({...failure([status]).messages[0], status}));
  await relayFixture(async ({request, sent}) => {
    for (const status of ['COMPLETED', 'ALL', undefined, null, '', 'RETRY\nInjected', 42]) {
      assert.equal((await request({...alert, messages: [{...alert.messages[0], status}]})).status, 400);
    }
    assert.equal(sent.length, 0);
    assert.equal((await request(alert)).status, 200);
    assert.equal(sent.length, 7);
    assert.ok(sent.every(mail => /^\[[A-Z]+\] Test flow — IS Watchdog — /.test(mail.subject) && mail.html.includes('<h1')));
    for (const status of statuses) assert.ok(sent.some(mail => mail.text.includes(`Status: ${status}\n`)));
    const changed = {...alert, messages: [{...alert.messages[2], status: 'FAILED'}, {...failure(['new-id']).messages[0], status: 'RETRY'}]};
    assert.equal((await request(changed)).status, 200);
    assert.equal(sent.length, 8);
    assert.doesNotMatch(sent[7].text, /Message ID: PROCESSING/);
    assert.match(sent[7].text, /Status: RETRY\n/);
    assert.equal((await request({...failure(['new-id'])})).status, 200);
    assert.equal(sent.length, 8); // Legacy and updated senders share per-message receipts.
  });
});
test('relay validates error excerpts and accepts a full batch of 2000-character Unicode errors', async () => {
  await relayFixture(async ({request, sent}) => {
    for (const errorText of [null, 42, {}, 'x'.repeat(2001)]) {
      const alert = failure();
      alert.messages[0].errorText = errorText;
      assert.equal((await request(alert)).status, 400);
    }
    assert.equal(sent.length, 0);
    const alert = {...failure(Array.from({length: 50}, (_, index) => `message-${index}`)), kind: 'messages'};
    alert.messages = alert.messages.map(message => ({...message, status: 'FAILED', errorText: '😀'.repeat(1000)}));
    assert.ok(Buffer.byteLength(JSON.stringify(alert)) > 100000);
    assert.equal((await request(alert)).status, 200);
    assert.equal(sent.length, 50);
    assert.ok(sent.every(mail => (mail.text.match(/Error: /g) || []).length === 1));
    assert.ok(sent.every(mail => mail.text.includes('😀'.repeat(1000))));
    assert.equal(new Set(sent.map(mail => mail.subject)).size, 50);
    assert.equal((await request(alert)).status, 200);
    assert.equal(sent.length, 50);
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

test('mixed legacy batches become isolated emails and persist partial success across a relay restart', async () => {
  const mails = [];
  let fail = true;
  const transport = {async sendMail(mail) {
    if (fail && mail.text.includes('Message ID: discarded\n')) throw new Error('Temporary SMTP failure');
    mails.push(mail);
    return {accepted: ['recipient@gmail.com'], rejected: []};
  }};
  await relayFixture(async ({request, config}) => {
    const alert = {...failure(['redirect', 'discarded', 'unrelated', 'same-error', 'same-error']), kind: 'messages'};
    alert.messages = alert.messages.map(message => ({...message,
      status: message.id === 'discarded' ? 'DISCARDED' : 'FAILED',
      errorText: message.id === 'redirect' ? 'HTTP operation failed with statusCode: 302' :
        message.id === 'discarded' ? 'No error information available.' : 'Receiver connection refused'}));
    assert.equal((await request(alert)).status, 502);
    assert.equal(mails.length, 1);
    assert.match(mails[0].text, /Message ID: redirect\n/);
    fail = false;
    const restarted = await createRelay(config);
    await new Promise(resolve => restarted.listen(0, '127.0.0.1', resolve));
    try {
      const resend = () => fetch(`http://127.0.0.1:${restarted.address().port}/alert`, {
        method: 'POST', headers: {Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(alert)
      });
      assert.equal((await resend()).status, 200);
      assert.equal((await resend()).status, 200);
      assert.equal(mails.length, 4);
      assert.equal(new Set(mails.map(mail => mail.subject)).size, 4);
      assert.ok(mails.every(mail => (mail.text.match(/Message ID: /g) || []).length === 1));
      const filtered = mails.filter(mail => mail.text.includes('with statusCode: 302'));
      const actionable = mails.filter(mail => !mail.text.includes('with statusCode: 302'));
      assert.equal(filtered.length, 1);
      assert.equal(actionable.length, 3);
      assert.match(actionable[0].text, /Status: DISCARDED/);
      assert.ok(actionable.some(mail => mail.text.includes('Message ID: unrelated\n')));
      assert.ok(actionable.every(mail => !mail.text.includes('Message ID: redirect\n')));
    } finally {await new Promise(resolve => restarted.close(resolve));}
  }, transport);
});

test('email composition refuses mixed messages rather than creating an unsafe email', () => {
  assert.throws(() => composeEmail(failure(['a', 'b'])), /one SAP message per email/);
});


test('alert format leads with status and iFlow, escapes HTML and preserves filter text and message identity', () => {
  const alert = {...failure(['message-123']), kind: 'messages'};
  alert.messages[0] = {...alert.messages[0], status: 'FAILED', flow: 'Orders <sync> & "receive"\r\nBcc: injected',
    errorText: 'HTTP operation failed with statusCode: 302\n<script>alert("test")</script> & details',
    url: `${TENANT}/shell/monitoring/Messages/message-123?first=1&second=2`};
  const mail = composeEmail(alert);
  assert.ok(mail.subject.startsWith('[FAILED] Orders <sync> & "receive" Bcc: injected — IS Watchdog — '));
  assert.ok(mail.subject.endsWith(' — message-123'));
  assert.doesNotMatch(mail.subject, /[\r\n]/);
  assert.ok(mail.text.startsWith('Status: FAILED\niFlow: Orders'));
  assert.ok(mail.text.includes(alert.messages[0].errorText));
  assert.match(mail.html, /<h1[^>]*>Orders &lt;sync&gt; &amp; &quot;receive&quot;/);
  assert.match(mail.html, /font-weight:bold;">FAILED<\/span>/);
  assert.ok(mail.html.includes('with statusCode: 302'));
  assert.ok(mail.html.includes('&lt;script&gt;alert(&quot;test&quot;)&lt;/script&gt; &amp; details'));
  assert.ok(mail.html.includes('?first=1&amp;second=2"'));
  assert.doesNotMatch(mail.html, /<script>|<sync>/);
  const next = composeEmail({...alert, messages: [{...alert.messages[0], id: 'message-456'}]});
  assert.notEqual(next.subject, mail.subject);
  const legacy = composeEmail(failure());
  assert.ok(legacy.subject.startsWith('[FAILED] Test flow'));
  assert.ok(legacy.html.includes('Error details unavailable.'));
});
