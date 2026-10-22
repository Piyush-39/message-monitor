import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, mkdir, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {teamsConfig, teamsWebhookURL, teamsMessage, createTeamsDelivery} from '../relay/teams.mjs';
import {saveTeamsConfig} from '../relay/setup-teams.mjs';
import {createRelay} from '../relay/server.mjs';
import {backgroundHarness, message, token} from './background-harness.mjs';
import {TENANT, TRIAL_TENANT} from './fixtures.mjs';
import {HEARTBEAT_TIMEOUT} from '../relay/monitor.mjs';

const workflow = '1'.repeat(32);
const signature = 'test-signature-not-a-real-secret';
const query = `?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${signature}`;
const webhook = `https://default${'2'.repeat(32)}.7e.environment.api.powerplatform.com:443/powerautomate/automations/direct/cu/15/workflows/${workflow}/triggers/manual/paths/invoke${query}`;
const config = {webhook: teamsWebhookURL(webhook)};
const alert = id => ({kind: 'messages', tenant: TENANT, run: 1791800000000,
  messages: [{id, flow: 'IF_Orders_Process', status: 'FAILED', time: '2026-10-20T20:45:00Z', errorText: 'Receiver connection refused', url: `${TENANT}/shell/monitoring/Messages/${id}`}]});
const card = payload => payload.attachments[0].content;

async function fixture(action, fetcher) {
  const folder = await mkdtemp(join(tmpdir(), 'is-teams-'));
  let clock = Date.now();
  const sent = [];
  const options = {...config, stateFile: join(folder, 'outbox.json'), autoDispatch: false, now: () => clock,
    fetcher: fetcher || (async (url, options) => {sent.push({url, options, body: JSON.parse(options.body)}); return new Response(null, {status: 202});})};
  const delivery = await createTeamsDelivery(options);
  try {await action({delivery, options, folder, sent, advance(ms) {clock += ms;}});}
  finally {delivery.stop(); await delivery.flush(); await rm(folder, {recursive: true, force: true});}
}

test('Teams accepts signed modern and Logic Apps workflow URLs and rejects unsafe or unrelated destinations without exposing secrets', () => {
  assert.deepEqual(teamsConfig({TEAMS_WEBHOOK_URL: webhook}), config);
  const old = `https://prod-01.westeurope.logic.azure.com/workflows/${workflow}/triggers/manual/paths/invoke${query}`;
  assert.equal(teamsWebhookURL(old), old);
  for (const value of [undefined, '', webhook.replace('https:', 'http:'), webhook.replace(':443', ':8080'),
    webhook.replace('.com:443', '.com.evil.example:443'), webhook.replace('https://', 'https://user:pass@'),
    `${webhook}#fragment`, `${webhook}&sig=duplicate`, `${webhook}&unexpected=true`, webhook.replace(`sig=${signature}`, 'sig='),
    webhook.replace('/manual/', '/unrelated/'), webhook.replace('/paths/invoke', '/paths/other'), `${webhook}\n`,
    `https://127.0.0.1/workflows/${workflow}/triggers/manual/paths/invoke${query}`]) {
    assert.throws(() => teamsWebhookURL(value), error => !error.message.includes(signature));
  }
});

test('Teams Adaptive Cards keep each message separate, show details and IST time, and fit the payload limit with worst-case escaped content', () => {
  const original = alert('one');
  const payload = teamsMessage(original);
  assert.equal(payload.type, 'message');
  assert.equal(payload.attachments.length, 1);
  assert.equal(payload.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  const content = card(payload);
  assert.equal(content.type, 'AdaptiveCard');
  assert.equal(content.version, '1.2');
  assert.match(content.body[0].text, /FAILED/);
  assert.match(JSON.stringify(content), /Receiver connection refused/);
  assert.equal(content.actions[0].url, original.messages[0].url);
  assert.equal(content.actions[0].type, 'Action.OpenUrl');
  assert.equal(content.body.find(item => item.type === 'FactSet').facts.find(item => item.title === 'Time').value, '21 Oct 2026, 02:15:00 IST');
  original.messages[0].flow = '_'.repeat(300);
  original.messages[0].errorText = '\\'.repeat(2000);
  assert.ok(Buffer.byteLength(JSON.stringify(teamsMessage(original))) < 28000);
  assert.ok(!('msteams' in content));
  assert.throws(() => teamsMessage({...original, messages: [...original.messages, ...original.messages]}), /one SAP message/);
  original.kind = 'failures'; delete original.messages[0].status; original.messages[0].time = '';
  assert.match(card(teamsMessage(original)).body[0].text, /FAILED/);
  assert.match(JSON.stringify(teamsMessage(original)), /Unavailable/);
});

test('Teams supports test, problem and stopped notifications with tenant monitoring links', () => {
  const testCard = card(teamsMessage({kind: 'test', nonce: 'test'}));
  assert.match(testCard.body[0].text, /test notification/);
  assert.ok(!testCard.actions);
  for (const kind of ['problem', 'stopped']) {
    const content = card(teamsMessage({kind, tenant: TENANT, run: 1, episode: 1, problem: 'SAP session expired'}));
    assert.match(JSON.stringify(content), /SAP session expired/);
    assert.equal(content.actions[0].url, `${TENANT}/shell/monitoring`);
  }
});

test('Teams outbox survives restart, deduplicates within each tenant, preserves signed query and keeps secrets out of persisted state', () => fixture(async f => {
  await f.delivery.enqueue(alert('same'));
  assert.equal((await f.delivery.enqueue(alert('same'))).duplicate, true);
  const other = alert('same'); other.tenant = TRIAL_TENANT;
  other.messages[0].url = `${TRIAL_TENANT}/shell/monitoring/Messages/same`;
  await f.delivery.enqueue(other);
  assert.equal(f.sent.length, 0);
  assert.equal((await stat(f.options.stateFile)).mode & 0o777, 0o600);
  const restarted = await createTeamsDelivery(f.options);
  await restarted.flush(); f.advance(1000); await restarted.flush();
  assert.equal(f.sent.length, 2);
  assert.equal(restarted.status().delivered, 2);
  assert.equal((await restarted.enqueue(alert('same'))).duplicate, true);
  assert.ok(f.sent.every(item => item.url === config.webhook && item.options.method === 'POST' && item.options.redirect === 'error'));
  assert.ok(f.sent.every(item => !item.options.headers.Authorization));
  const raw = await readFile(f.options.stateFile, 'utf8');
  assert.ok(!raw.includes(signature));
  assert.ok(!JSON.stringify(restarted.status()).includes(signature));
}));

test('Teams accepts empty 200, 202 and 204 workflow responses without requiring a Discord message ID', async () => {
  for (const status of [200, 202, 204]) {
    await fixture(async f => {
      await f.delivery.enqueue(alert('accepted'));
      await f.delivery.flush();
      assert.equal(f.delivery.status().pending, 0);
      assert.equal(f.delivery.status().delivered, 1);
    }, async () => new Response(null, {status}));
  }
});

test('Teams respects Retry-After seconds and HTTP dates before retrying the same alert', async () => {
  for (const dateHeader of [false, true]) {
    let calls = 0, delay;
    await fixture(async f => {
      delay = dateHeader ? new Date(f.options.now() + 5000).toUTCString() : '3';
      const expected = dateHeader ? Date.parse(delay) - f.options.now() : 3000;
      await f.delivery.enqueue(alert('rate-limited'));
      await f.delivery.flush();
      f.advance(expected - 1); await f.delivery.flush();
      assert.equal(calls, 1);
      assert.match(f.delivery.status().errors.teams, /rate limit/);
      f.advance(1); await f.delivery.flush();
      assert.equal(calls, 2);
      assert.equal(f.delivery.status().pending, 0);
    }, async () => ++calls === 1 ? new Response(null, {status: 429, headers: {'Retry-After': delay}}) : new Response(null, {status: 202}));
  }
});

test('Teams retries network/5xx failures across restart and redacts provider response bodies', async () => {
  let calls = 0;
  await fixture(async f => {
    await f.delivery.enqueue(alert('retry'));
    await f.delivery.flush();
    f.advance(2000); await f.delivery.flush();
    assert.equal(calls, 2);
    assert.ok(!JSON.stringify(f.delivery.status()).includes(signature));
    f.advance(4000);
    const restarted = await createTeamsDelivery(f.options);
    await restarted.flush();
    assert.equal(restarted.status().pending, 0);
  }, async () => {
    if (++calls === 1) throw new Error(config.webhook);
    return calls === 2 ? Response.json({error: signature}, {status: 503}) : new Response(null, {status: 202});
  });
});

test('Teams pauses rejected webhooks without losing alerts and resumes with a replacement', async () => {
  for (const status of [401, 403, 404, 410]) {
    let calls = 0;
    await fixture(async f => {
      await f.delivery.enqueue(alert('blocked'));
      await f.delivery.flush(); await f.delivery.flush();
      assert.equal(calls, 1);
      assert.equal(f.delivery.status().blocked, true);
      assert.equal(f.delivery.status().pending, 1);
      const fixed = await createTeamsDelivery({...f.options, webhook: config.webhook.replace(signature, 'replacement-signature')});
      await fixed.flush();
      assert.equal(fixed.status().pending, 0);
    }, async () => ++calls === 1 ? new Response(null, {status}) : new Response(null, {status: 202}));
  }
});

test('Teams retains malformed payloads for repair without repeatedly sending them', () => fixture(async f => {
  await f.delivery.enqueue(alert('bad-format'));
  await f.delivery.flush(); await f.delivery.flush();
  assert.equal(f.delivery.status().pending, 1);
  assert.equal(f.delivery.status().failed, 1);
  assert.match(f.delivery.status().errors.teams, /HTTP 400/);
}, async () => new Response(null, {status: 400})));

test('Teams setup preserves other providers and relay key, saves privately, and rejects invalid edits atomically', () => fixture(async f => {
  const envFile = join(f.folder, '.env');
  await writeFile(envFile, `# existing config\nSMTP_PASS=fake-password\nDISCORD_WEBHOOK_URL=other-provider\nexport NOTIFICATION_PROVIDER=discord\nTEAMS_WEBHOOK_URL=old\nTEAMS_WEBHOOK_URL=duplicate\nRELAY_TOKEN=${token}\n`);
  await saveTeamsConfig({config, token, envFile});
  const raw = await readFile(envFile, 'utf8');
  assert.match(raw, /SMTP_PASS=fake-password/);
  assert.match(raw, /DISCORD_WEBHOOK_URL=other-provider/);
  assert.match(raw, /NOTIFICATION_PROVIDER=teams/);
  assert.ok(raw.includes(`RELAY_TOKEN=${token}`));
  assert.equal((raw.match(/TEAMS_WEBHOOK_URL=/g) || []).length, 1);
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);
  await assert.rejects(saveTeamsConfig({config: {webhook: 'invalid'}, token, envFile}));
  await assert.rejects(saveTeamsConfig({config, token: 'invalid\nkey', envFile}));
  assert.equal(await readFile(envFile, 'utf8'), raw);
}));

test('Teams disk write failure prevents acknowledgment and pauses posts after an ambiguous confirmation', () => fixture(async f => {
  await mkdir(`${f.options.stateFile}.tmp`);
  await assert.rejects(f.delivery.enqueue(alert('not-saved')));
  assert.equal(f.delivery.status().pending, 0);
  await rm(`${f.options.stateFile}.tmp`, {recursive: true});
  await f.delivery.enqueue(alert('saved'));
  await mkdir(`${f.options.stateFile}.tmp`);
  await assert.rejects(f.delivery.flush(), /outbox could not be saved/);
  await f.delivery.flush();
  assert.equal(f.sent.length, 1);
  assert.match(f.delivery.status().fatalError, /disk access/);
}));

test('extension → authenticated relay → Teams outbox includes selected statuses, details, test notices and interruption alerts', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'is-teams-e2e-'));
  const nativeFetch = globalThis.fetch;
  const sent = [];
  let h, server, delivery;
  try {
    delivery = await createTeamsDelivery({...config, stateFile: join(folder, 'teams.json'), autoDispatch: false,
      now: () => Date.now(), fetcher: async (url, options) => {sent.push({url, body: JSON.parse(options.body)}); return new Response(null, {status: 202});}});
    server = await createRelay({token, delivery, stateFile: join(folder, 'receipts.json'), now: () => Date.now()});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const unauthorized = await nativeFetch(`${base}/health`);
    assert.equal(unauthorized.status, 401);
    h = await backgroundHarness({relayFetch: (url, options) => nativeFetch(`${base}${new URL(url).pathname}`, options)});
    await h.start();
    await server.checkMonitoring();
    await delivery.flush();
    assert.match(card(sent[0].body).body[0].text, /monitoring started/);
    h.time += 1000;
    sent.length = 0;
    h.sap.set(TENANT, [message('failed'), {...message('retry'), Status: 'RETRY'}, {...message('completed'), Status: 'COMPLETED'}]);
    h.sapErrors.set(`${TENANT}:failed`, 'Receiver connection refused');
    await h.poll(); await h.poll();
    assert.equal(delivery.status().pending, 2);
    assert.equal(h.store.state.runs[TENANT].sent, 2);
    const status = (await h.request('status')).value;
    assert.equal(status.delivery.provider, 'teams');
    assert.equal(status.delivery.pending, 2);
    assert.ok(!JSON.stringify(status).includes(signature));
    await delivery.flush(); h.time += 1000; await delivery.flush();
    assert.equal(sent.length, 2);
    assert.ok(sent.every(item => item.url === config.webhook));
    assert.match(JSON.stringify(sent[0].body), /Receiver connection refused/);
    assert.match(card(sent[1].body).body[0].text, /RETRY/);
    const testResult = await h.request('test');
    assert.match(testResult.value.status, /queued for Teams/);
    h.time += 1000; await delivery.flush();
    assert.match(card(sent[2].body).body[0].text, /test notification/);
    h.time += HEARTBEAT_TIMEOUT; await server.checkMonitoring(); await delivery.flush();
    assert.match(card(sent[3].body).body[0].text, /monitoring stopped/);
    assert.equal(delivery.status().pending, 0);
  } finally {
    delivery?.stop(); if (delivery) await delivery.flush();
    if (server) {await server.checkMonitoring(); await new Promise(resolve => server.close(resolve));}
    h?.close(); await rm(folder, {recursive: true, force: true});
  }
});
