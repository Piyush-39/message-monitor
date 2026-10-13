import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readMessageReport} from '../extension/report.js';
import {validateReport} from '../extension/report-contract.js';
import {composeReport} from '../relay/report.mjs';
import {createRelay} from '../relay/server.mjs';
import {backgroundHarness, token} from './background-harness.mjs';
import {TENANT, TRIAL_TENANT} from './fixtures.mjs';

const to = 1791800000000;
const from = to - 86400000;
const record = (id, status = 'COMPLETED', flow = 'flow-a', time = from) => ({MessageGuid: id, Status: status,
  LogStart: `/Date(${time})/`, LogEnd: null, IntegrationArtifact: {Id: flow, Name: 'Same display name'}, IntegrationFlowName: 'Same display name'});
const payload = () => ({tenant: TENANT, from, to, nonce: 'report-request-1', flows: [
  {id: 'flow-a', name: 'Flow A', completed: 2, retry: 1, failed: 3}
]});
function readerResult(fetcher, origin = TENANT, clock = Date, scope = {}) {
  return runInNewContext(`(${readMessageReport.toString()})(...args)`, {
    args: [from, to, TENANT, scope], location: new URL(`${origin}/shell/monitoring/Messages/`), URL, Date: clock, AbortSignal, fetch: fetcher
  });
}
async function reader(...args) {
  const result = await readerResult(...args);
  if (!result.ok) throw new Error(result.error);
  return result.flows;
}

test('serialized report counts all statuses by technical ID, deduplicates pages, and enforces start-time boundaries', async () => {
  const urls = [];
  const rows = await reader(async (url, options) => {
    urls.push(new URL(url));
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, undefined); // Read-only GET.
    if (urls.length === 1) return Response.json({d: {results: [
      record('c'), record('r', 'RETRY'), record('f', 'FAILED'), record('before', 'FAILED', 'flow-a', from - 1),
      record('at-end', 'FAILED', 'flow-a', to), record('other-status', 'PROCESSING', 'flow-c')
    ], __next: '/api/v1/MessageProcessingLogs?$skiptoken=two'}});
    return Response.json({d: {results: [record('c'), record('second-completed'), record('other-flow', 'FAILED', 'flow-b')]}});
  });
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    {id: 'flow-a', name: 'Same display name', completed: 2, retry: 1, failed: 1},
    {id: 'flow-b', name: 'Same display name', completed: 0, retry: 0, failed: 1},
    {id: 'flow-c', name: 'Same display name', completed: 0, retry: 0, failed: 0}
  ]);
  assert.equal(urls[1].pathname, '/odata/api/v1/MessageProcessingLogs');
  const filter = urls[0].searchParams.get('$filter');
  assert.equal(urls[0].searchParams.get('$orderby'), 'LogStart desc');
  assert.equal(urls[0].searchParams.get('$top'), '50');
  assert.equal(urls[0].searchParams.has('$select'), false);
  assert.equal(filter, `LogStart ge datetime'${new Date(from).toISOString().slice(0, 19)}' and LogStart lt datetime'${new Date(to).toISOString().slice(0, 19)}'`);
  assert.doesNotMatch(filter, /Status|IntegrationArtifact|LogEnd/);
});

test('report reads every 50-record offset without continuation links, including more than ten selected flows and zero-log flows', async () => {
  const artifactIds = Array.from({length: 26}, (_, index) => `flow-${index}`);
  const records = Array.from({length: 150}, (_, index) => record(`message-${index}`, ['COMPLETED', 'RETRY', 'FAILED'][index % 3], `flow-${index % 25}`));
  const offsets = [];
  const rows = await reader(async url => {
    const offset = Number(new URL(url).searchParams.get('$skip') || 0);
    offsets.push(offset);
    return Response.json({d: {results: records.slice(offset, offset + 50)}});
  }, TENANT, Date, {artifactIds});
  assert.deepEqual(offsets, [0, 50, 100, 150]);
  assert.equal(rows.length, 26);
  assert.deepEqual(JSON.parse(JSON.stringify(rows.find(row => row.id === 'flow-25'))), {id: 'flow-25', name: 'flow-25', completed: 0, retry: 0, failed: 0});
  for (const field of ['completed', 'retry', 'failed']) assert.equal(rows.reduce((sum, row) => sum + row[field], 0), 50);
});

test('report preserves escaped artifact/package filters on every page and excludes unrelated rows', async () => {
  const scope = {artifactIds: ["flow'a", 'flow-b', 'flow-empty', "flow'a"], packageId: "package'one"};
  const inPackage = item => ({...item, IntegrationArtifact: {...item.IntegrationArtifact, PackageId: scope.packageId}});
  const urls = [];
  const rows = await reader(async url => {
    urls.push(new URL(url));
    return Response.json({d: {results: urls.length === 1
      ? Array.from({length: 50}, (_, index) => inPackage(record(`a-${index}`, 'RETRY', "flow'a")))
      : [inPackage(record('b', 'FAILED', 'flow-b')), inPackage(record('outside', 'COMPLETED', 'outside')),
        {...record('wrong-package', 'FAILED', 'flow-b'), IntegrationArtifact: {Id: 'flow-b', PackageId: 'other'}}]}});
  }, TENANT, Date, scope);
  assert.equal(urls.length, 2);
  assert.equal(urls[0].searchParams.get('$filter'), urls[1].searchParams.get('$filter'));
  assert.match(urls[0].searchParams.get('$filter'), /IntegrationArtifact\/Id eq 'flow''a'/);
  assert.match(urls[0].searchParams.get('$filter'), /IntegrationArtifact\/PackageId eq 'package''one'/);
  assert.doesNotMatch(urls[0].searchParams.get('$filter'), /Status|LogEnd/);
  assert.equal(rows.length, 3);
  assert.equal(rows.find(row => row.id === "flow'a").retry, 50);
  assert.equal(rows.find(row => row.id === 'flow-b').failed, 1);
  assert.equal(rows.find(row => row.id === 'flow-empty').completed, 0);
  await assert.rejects(reader(async () => Response.json({d: {results: [record('missing-package')]}}), TENANT, Date, {packageId: 'one'}), /without its package ID/);
  const packageRows = await reader(async () => Response.json({d: {results: [inPackage(record('one')), {...record('two'), IntegrationArtifact: {Id: 'flow-b', PackageId: 'other'}}]}}), TENANT, Date, {packageId: scope.packageId});
  assert.equal(packageRows.length, 1);
});

test('report continues after a 50-record chunk split across smaller server-driven pages', async () => {
  const records = Array.from({length: 63}, (_, index) => record(`message-${index}`, 'COMPLETED', `flow-${index}`));
  const offsets = [];
  const rows = await reader(async url => {
    const params = new URL(url).searchParams;
    const offset = Number(params.get('$skiptoken') || params.get('$skip') || 0);
    offsets.push(offset);
    const end = Math.min(offset + 10, Math.floor(offset / 50) * 50 + 50, records.length);
    return Response.json({d: {results: records.slice(offset, end),
      ...(end < records.length && end % 50 !== 0 ? {__next: `/api/v1/MessageProcessingLogs?$skiptoken=${end}`} : {})}});
  });
  assert.deepEqual(offsets, [0, 10, 20, 30, 40, 50, 60]);
  assert.equal(rows.length, 63);
  assert.equal(rows.reduce((sum, row) => sum + row.completed, 0), 63);
});

test('offset pagination fails without a partial report when SAP ignores skip or a later page fails', async () => {
  const records = Array.from({length: 50}, (_, index) => record(`message-${index}`));
  let calls = 0;
  await assert.rejects(reader(async () => {calls++; return Response.json({d: {results: records}});}), /made no progress; no partial report/);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(reader(async () => ++calls === 1 ? Response.json({d: {results: records}}) : new Response('', {status: 500})), /HTTP 500/);
});

test('report fails rather than emailing incomplete or untrusted SAP results', async () => {
  for (const response of [
    new Response('login', {headers: {'content-type': 'text/html'}}), new Response('', {status: 401}),
    new Response('', {status: 403}), new Response('', {status: 500}), Response.json({d: {}}),
    Response.json({d: {results: [{...record('one'), LogStart: null}]}}),
    Response.json({d: {results: [{...record('one'), IntegrationArtifact: null}]}}),
    Response.json({d: {results: [{...record('one'), MessageGuid: ''}]}}),
    Response.json({d: {results: [], __next: {url: 'invalid'}}})
  ]) await assert.rejects(reader(async () => response));
  for (const next of ['https://other.example/api/v1/MessageProcessingLogs', '/api/v1/Attachments',
    `https://user:pass@${new URL(TENANT).hostname}/api/v1/MessageProcessingLogs`]) {
    await assert.rejects(reader(async () => Response.json({d: {results: [], __next: next}})), /pagination URL/);
  }
  await assert.rejects(reader(async url => Response.json({d: {results: [], __next: url}})), /no partial report/);
  await assert.rejects(reader(async () => Response.json({d: {results: []}}), TRIAL_TENANT), /sign in again/);
  let now = to;
  class ExpiringDate extends Date {static now() {now += 60001; return now;}}
  await assert.rejects(reader(async () => Response.json({d: {results: []}}), TENANT, ExpiringDate), /read budget/);
  let pages = 0;
  await assert.rejects(reader(async () => Response.json({d: {results: [], __next: `/api/v1/MessageProcessingLogs?$skiptoken=${++pages}`}})), /read budget/);
  assert.equal(pages, 200);
  await assert.rejects(reader(async () => Response.json({d: {results: Array.from({length: 1001}, (_, index) => record(`message-${index}`, 'COMPLETED', `flow-${index}`))}})), /Too many iFlows/);
});

test('page reader returns serializable errors instead of rejected promises across the Chrome boundary', async () => {
  const cases = [
    {fetcher: async () => new Response('', {status: 401}), expected: /session expired or access denied/},
    {fetcher: async () => new Response('login', {headers: {'content-type': 'text/html'}}), expected: /login page/},
    {fetcher: async () => Response.json({error: {message: {value: 'Unsupported projection\nTry a full record'}}}, {status: 400}), expected: /HTTP 400\. Unsupported projection Try a full record/},
    {fetcher: async () => {throw Object.assign(new Error('network timeout'), {name: 'TimeoutError'});}, expected: /request timed out/},
    {fetcher: async () => Response.json({d: {results: [{...record('one'), IntegrationArtifact: null}]}}), expected: /without its iFlow ID/}
  ];
  for (const {fetcher, expected} of cases) {
    const result = JSON.parse(JSON.stringify(await readerResult(fetcher)));
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
    assert.equal('flows' in result, false);
    assert.equal('stack' in result, false);
  }
});

test('browser-session report avoids projection and composite sorting and accepts OData or ISO start times', async () => {
  const rows = await reader(async url => {
    const params = new URL(url).searchParams;
    if (params.has('$select') || params.get('$orderby').includes(',') || Number(params.get('$top')) > 50) {
      return Response.json({error: {message: {value: 'Unsupported browser-session query'}}}, {status: 400});
    }
    return Response.json({d: {results: [
      {...record('iso-start'), LogStart: new Date(from).toISOString()},
      {...record('offset-start', 'RETRY'), LogStart: new Date(from).toISOString().replace('Z', '+00:00')},
      record('odata-start', 'FAILED')
    ]}});
  });
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{id: 'flow-a', name: 'Same display name', completed: 1, retry: 1, failed: 1}]);
  await assert.rejects(reader(async () => Response.json({d: {results: [{...record('bad-start'), LogStart: 'not-a-date'}]}})), /valid processing start time/);
});

test('popup response preserves SAP errors when executeScript resolves without exposing thrown page exceptions', async () => {
  const h = await backgroundHarness();
  try {
    await h.start(TRIAL_TENANT);
    const before = structuredClone(h.store.state);
    h.sap.set(TENANT, () => Response.json({error: {message: {value: 'Invalid OData query option'}}}, {status: 400}));
    const failed = await h.request('report', null, {sourceTabId: 1});
    assert.equal(failed.ok, false);
    assert.match(failed.error, /HTTP 400\. Invalid OData query option/);
    assert.doesNotMatch(failed.error, /^SAP report failed;/);
    assert.equal(h.delivered.length, 0);
    assert.deepEqual(h.store.state, before);
    h.sap.set(TENANT, [record('fixed', 'RETRY', 'flow-a', h.time - 1000)]);
    assert.equal((await h.request('report', null, {sourceTabId: 1})).ok, true);
    assert.equal(h.delivered.length, 1);
    assert.equal(h.delivered[0].flows[0].retry, 1);
  } finally {h.close();}
});

test('report contract rejects malformed windows, duplicate rows, negative/unsafe counts and oversized reports', () => {
  assert.equal(validateReport(payload()).flows.length, 1);
  for (const change of [{tenant: 'http://bad.example'}, {nonce: ''}, {from: -1}, {to: to + 1}, {from: 9000000000000000 - 86400000, to: 9000000000000000},
    {flows: [payload().flows[0], payload().flows[0]]}, {flows: Array(1001).fill(payload().flows[0])}]) {
    assert.throws(() => validateReport({...payload(), ...change}));
  }
  for (const change of [{id: ''}, {name: null}, {completed: -1}, {retry: 1.5}, {failed: Number.MAX_SAFE_INTEGER + 1}]) {
    assert.throws(() => validateReport({...payload(), flows: [{...payload().flows[0], ...change}]}));
  }
  assert.throws(() => validateReport({...payload(), flows: [
    {...payload().flows[0], completed: Number.MAX_SAFE_INTEGER}, {...payload().flows[0], id: 'flow-b'}
  ]}));
  const selected = {...payload(), scope: {artifactIds: ['flow-a'], packageId: null}};
  assert.equal(validateReport(selected), selected);
  for (const scope of [null, {artifactIds: 'flow-a'}, {artifactIds: ['flow-b']}, {artifactIds: ['flow-a', 'flow-b']},
    {artifactIds: ['flow-a', 'flow-a']}, {artifactIds: ['flow-a'], packageId: 42}]) {
    assert.throws(() => validateReport({...payload(), scope}));
  }
});

test('email includes clear UTC scope, totals, HTML escaping and a safe CSV attachment, including empty reports', () => {
  const report = payload();
  report.flows[0].name = '=HYPERLINK("bad")<script>';
  const mail = composeReport(report);
  assert.match(mail.text, /Totals — Completed: 2, Retry: 1, Failed: 3/);
  assert.match(mail.text, /Retry counts messages, not individual retry attempts/);
  assert.match(mail.html, /&lt;script&gt;/);
  assert.doesNotMatch(mail.html, /<script>/);
  assert.ok(mail.attachments[0].content.includes('"\'=HYPERLINK(""bad"")<script>"'));
  assert.match(mail.attachments[0].content, /flow-a",2,1,3/);
  const empty = composeReport({...report, flows: []});
  assert.match(empty.text, /No message processing logs found/);
  assert.match(empty.text, /Completed: 0, Retry: 0, Failed: 0/);
  const selected = composeReport({...report, scope: {artifactIds: ['flow-a'], packageId: '<script>package</script>'}});
  assert.match(selected.text, /1 selected iFlows, including those with no logs/);
  assert.match(selected.html, /Restricted to package: &lt;script&gt;package&lt;\/script&gt;/);
  assert.doesNotMatch(selected.html, /<script>/);
});

test('report succeeds without a monitoring run and does not create tabs, alarms, heartbeats or table refreshes', async () => {
  const h = await backgroundHarness();
  try {
    h.tabs.get(1).url += encodeURIComponent(JSON.stringify({artifactIds: ['flow-a', 'empty-flow'], status: 'FAILED', time: 'PASTHOUR'}));
    h.sap.set(TENANT, [record('one', 'RETRY', 'flow-a', h.time - 1000)]);
    const before = structuredClone(h.store.state);
    const result = await h.request('report', null, {sourceTabId: 1});
    assert.equal(result.ok, true);
    assert.match(result.value.status, /accepted by Gmail/);
    assert.deepEqual(h.store.state, before);
    assert.equal(h.tabs.size, 2);
    assert.equal(h.alarms.size, 0);
    assert.equal(h.monitoring.length, 0);
    assert.equal(h.tableClicks.length, 0);
    assert.equal(h.delivered.length, 1);
    assert.equal(h.delivered[0].flows.find(flow => flow.id === 'flow-a').retry, 1);
    assert.equal(h.delivered[0].flows.length, 2);
    assert.deepEqual(h.delivered[0].scope, {artifactIds: ['flow-a', 'empty-flow'], packageId: null});
    assert.equal(h.delivered[0].to - h.delivered[0].from, 86400000);
    h.denied.add(TENANT);
    assert.equal((await h.request('report', null, {sourceTabId: 1})).ok, false);
    assert.equal(h.delivered.length, 1);
  } finally {h.close();}
});

test('a slow report does not block monitoring polls or Stop for other tenants; concurrent reports are rejected', async () => {
  const h = await backgroundHarness();
  let release;
  try {
    await h.start(TRIAL_TENANT);
    const before = structuredClone(h.store.state);
    const alarms = structuredClone([...h.alarms]);
    let began;
    const reading = new Promise(resolve => {began = resolve;});
    h.sap.set(TENANT, () => new Promise(resolve => {release = resolve; began();}));
    const pending = h.request('report', null, {sourceTabId: 1});
    await reading;
    assert.deepEqual(h.store.state, before);
    assert.deepEqual([...h.alarms], alarms);
    const duplicate = await h.request('report', null, {sourceTabId: 1});
    assert.match(duplicate.error, /already being generated/);
    h.time += 1000;
    const polled = await h.poll();
    assert.equal(polled.value.activeCount, 1);
    assert.equal(h.monitoring.at(-1).action, 'heartbeat');
    assert.equal((await h.request('stop', TRIAL_TENANT)).ok, true);
    assert.equal(h.store.state.runs[TRIAL_TENANT].running, false);
    release([]);
    assert.equal((await pending).ok, true);
  } finally {release?.([]); h.close();}
});

test('SAP or SMTP report failures and older relays leave active monitoring untouched', async () => {
  const h = await backgroundHarness();
  try {
    await h.start(TRIAL_TENANT);
    const before = structuredClone(h.store.state);
    h.broken.add(TENANT);
    assert.equal((await h.request('report', null, {sourceTabId: 1})).ok, false);
    assert.equal(h.delivered.length, 0);
    h.broken.delete(TENANT); h.emailBroken = true;
    assert.equal((await h.request('report', null, {sourceTabId: 1})).ok, false);
    assert.deepEqual(h.store.state, before);
    h.emailBroken = false;
    assert.equal((await h.request('report', null, {sourceTabId: 1})).ok, true);
  } finally {h.close();}
  const old = await backgroundHarness({relayFetch: async () => Response.json({ok: true})});
  try {
    const result = await old.request('report', null, {sourceTabId: 1});
    assert.match(result.error, /Update and restart the relay on this device/);
    assert.equal(old.reads.length, 0);
  } finally {old.close();}
});

test('serialized extension report → authenticated HTTP relay → fixed mail recipient with retries and receipts', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'is-report-'));
  const nativeFetch = globalThis.fetch;
  const mails = [];
  let smtpBroken = false;
  let server, h;
  try {
    server = await createRelay({token, user: 'sender@gmail.com', recipient: 'recipient@gmail.com', stateFile: join(folder, 'receipts.json'),
      transport: {async sendMail(mail) {if (smtpBroken) throw new Error('fake SMTP failure'); mails.push(mail); return {accepted: ['recipient@gmail.com'], rejected: []};}}});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    h = await backgroundHarness({relayFetch: (url, options) => nativeFetch(`${base}${new URL(url).pathname}`, options)});
    const artifactIds = Array.from({length: 31}, (_, index) => `flow-${index}`);
    h.tabs.get(1).url += encodeURIComponent(JSON.stringify({artifactIds, packageId: 'selected-package', status: 'FAILED'}));
    const records = Array.from({length: 137}, (_, index) => ({...record(`message-${index}`, index % 2 ? 'RETRY' : 'COMPLETED', `flow-${index % 30}`, h.time - 1000),
      IntegrationArtifact: {Id: `flow-${index % 30}`, PackageId: 'selected-package', Name: 'Same display name'}}));
    records.push({...record('excluded', 'FAILED', 'excluded-flow', h.time - 1000), IntegrationArtifact: {Id: 'excluded-flow', PackageId: 'selected-package'}});
    h.sap.set(TENANT, url => {
      const offset = Number(new URL(url).searchParams.get('$skip') || 0);
      return Response.json({d: {results: records.slice(offset, offset + 50)}});
    });
    assert.equal((await h.request('report', null, {sourceTabId: 1})).ok, true);
    assert.equal(mails[0].to, 'recipient@gmail.com');
    assert.match(mails[0].text, /Completed: 69, Retry: 68, Failed: 0/);
    assert.match(mails[0].text, /31 selected iFlows/);
    assert.equal(mails[0].attachments[0].content.split('\r\n').length, 32);
    assert.match(mails[0].attachments[0].content, /"flow-30","flow-30",0,0,0/);
    assert.doesNotMatch(mails[0].text, /excluded-flow/);
    h.sap.set(TENANT, url => new URL(url).searchParams.has('$skip')
      ? new Response('', {status: 500}) : Response.json({d: {results: records.slice(0, 50)}}));
    assert.equal((await h.request('report', null, {sourceTabId: 1})).ok, false);
    assert.equal(mails.length, 1); // A later-page failure must never send a partial report.
    const readsBeforeInvalidFilter = h.reads.length;
    h.tabs.get(1).url = `${TENANT}/shell/monitoring/Messages/%broken`;
    const invalidFilter = await h.request('report', null, {sourceTabId: 1});
    assert.match(invalidFilter.error, /Apply the filters with Go/);
    assert.equal(h.reads.length, readsBeforeInvalidFilter);
    assert.equal(mails.length, 1);
    const request = (body, auth = token) => nativeFetch(`${base}/report`, {method: 'POST', headers: {Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    assert.equal((await request(payload(), 'wrong')).status, 401);
    assert.equal((await request({...payload(), to: 0})).status, 400);
    assert.equal((await request(payload())).status, 200);
    assert.equal((await request(payload())).status, 200);
    assert.equal(mails.length, 2);
    smtpBroken = true;
    const another = {...payload(), nonce: 'report-request-2'};
    assert.equal((await request(another)).status, 502);
    smtpBroken = false;
    assert.equal((await request(another)).status, 200);
    assert.equal((await request(another)).status, 200);
    assert.equal(mails.length, 3);
    assert.equal(h.monitoring.length, 0);
  } finally {
    h?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(folder, {recursive: true, force: true});
  }
});
