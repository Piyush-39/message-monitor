import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discordConfig, webhookURL, verifyDiscordWebhook, discordMessage, createDiscordDelivery} from '../relay/discord.mjs';
import {saveDiscordConfig} from '../relay/setup-discord.mjs';
import {createRelay} from '../relay/server.mjs';
import {backgroundHarness, message, token} from './background-harness.mjs';
import {TENANT, TRIAL_TENANT} from './fixtures.mjs';
import {HEARTBEAT_TIMEOUT} from '../relay/monitor.mjs';

const webhook = `https://discord.com/api/webhooks/111111111111111111/${'a'.repeat(50)}`;
const config = {webhook};
const alert = (id, errorText = 'Receiver connection refused') => ({kind: 'messages', tenant: TENANT, run: 1791800000000,
  messages: [{id, flow: 'IF_Orders_Process', status: 'FAILED', time: '2026-10-20T00:00:00Z', errorText, url: `${TENANT}/shell/monitoring/Messages/${id}`}]});
async function fixture(action, fetcher) {
  const folder = await mkdtemp(join(tmpdir(), 'is-discord-'));
  let clock = Date.now();
  const sent = [];
  const options = {...config, stateFile: join(folder, 'outbox.json'), autoDispatch: false, now: () => clock,
    fetcher: fetcher || (async (url, options) => {sent.push({url, body: JSON.parse(options.body)}); return Response.json({id: String(sent.length)});})};
  const delivery = await createDiscordDelivery(options);
  try {await action({delivery, options, folder, sent, advance(ms) {clock += ms;}});}
  finally {delivery.stop(); await delivery.flush(); await rm(folder, {recursive: true, force: true});}
}

test('Discord config uses one safe destination and ignores removed archive settings', () => {
  assert.deepEqual(discordConfig({DISCORD_WEBHOOK_URL: webhook}), config);
  assert.deepEqual(discordConfig({DISCORD_WEBHOOK_URL: webhook, DISCORD_ARCHIVE_WEBHOOK_URL: 'obsolete', DISCORD_ARCHIVE_STATUS_CODES: '302,500'}), config);
  for (const value of [undefined, '', webhook.replace('https:', 'http:'), webhook.replace('discord.com', 'attacker.example'), `${webhook}?thread_id=123`, `${webhook}#fragment`, webhook.replace('discord.com', 'user:pass@discord.com')]) {
    assert.throws(() => webhookURL(value), error => !error.message.includes('a'.repeat(50)));
  }
});

test('all errors remain normal notifications regardless of their error text', () => {
  for (const text of ['HTTP failed with statusCode: 302', 'HTTP failed with statusCode: 500', 'HTTP STATUS CODE : 302', 'No error information available.', 'Error details unavailable.', 'statusCode: 302; caused by statusCode: 500', 'statusCode: 302\n[truncated]']) {
    const payload = discordMessage(alert('normal', text));
    assert.equal(payload.flags, 0);
    assert.ok(!payload.embeds[0].footer.text.includes('Archived'));
    assert.ok(!('target' in payload));
  }
  for (const kind of ['problem', 'stopped']) {
    assert.equal(discordMessage({kind, tenant: TENANT, run: 1, episode: 1, problem: 'Relay error with statusCode: 302'}).flags, 0);
  }
  assert.equal(discordMessage({kind: 'test', nonce: 'test'}).flags, 0);
});

test('Discord cards fit API limits, keep iFlow and status prominent, disable mentions and isolate each message', () => {
  const original = alert('one', '@everyone **alert** ' + '`'.repeat(1950));
  original.messages[0].flow = '_'.repeat(300);
  const payload = discordMessage(original);
  const embed = payload.embeds[0];
  assert.equal(payload.embeds.length, 1);
  assert.match(embed.title, /FAILED/);
  assert.ok(embed.title.length <= 256);
  assert.ok(embed.description.length <= 4096);
  assert.ok(embed.description.startsWith('**iFlow**'));
  assert.ok(embed.fields.every(field => field.value.length <= 1024));
  assert.deepEqual(payload.allowed_mentions, {parse: []});
  assert.equal(embed.url, original.messages[0].url);
  assert.throws(() => discordMessage({...original, messages: [...original.messages, ...original.messages]}), /one SAP message/);
});

test('Discord notification summaries preserve iFlow names without added Markdown or escape slashes', () => {
  const original = alert('preview');
  original.messages[0].status = 'PROCESSING';
  original.messages[0].flow = 'IF_12000_01_LP1_PEAK_SIEMEDTD_GSMS_CLOSE_ESCAL_Sync';
  const payload = discordMessage(original);
  assert.equal(payload.content, `[PROCESSING] ${original.messages[0].flow}`);
  assert.ok(!payload.content.includes('\\'));
  assert.ok(!payload.content.includes('**'));
  // The in-app card still escapes Markdown and all content remains mention-safe.
  assert.ok(payload.embeds[0].description.includes('IF\\_12000'));
  original.messages[0].flow = '@everyone ' + '_'.repeat(290);
  const mentions = discordMessage(original);
  assert.deepEqual(mentions.allowed_mentions, {parse: []});
  assert.ok(mentions.content.length <= 2000);
  original.messages[0].flow = '';
  assert.equal(discordMessage(original).content, '[PROCESSING] Unknown iFlow');
});

test('Discord message times use IST including date rollover and unavailable timestamps', () => {
  const original = alert('time');
  const displayedTime = time => {
    original.messages[0].time = time;
    return discordMessage(original).embeds[0].fields.find(field => field.name === 'Time').value;
  };
  assert.equal(displayedTime('2026-10-20T15:47:12.121Z'), '20 Oct 2026, 21:17:12 IST');
  assert.equal(displayedTime('2026-12-31T20:45:00Z'), '1 Jan 2027, 02:15:00 IST');
  assert.equal(displayedTime('2026-10-20T21:17:12+05:30'), '20 Oct 2026, 21:17:12 IST');
  assert.equal(displayedTime(''), 'Unavailable');
  assert.equal(displayedTime('Unavailable'), 'Unavailable');
});

test('queued alerts are saved before acknowledgment, survive restart, deduplicate retries and keep matching IDs tenant-scoped', () => fixture(async f => {
  assert.equal((await f.delivery.enqueue(alert('same'))).queued, true);
  assert.equal((await f.delivery.enqueue(alert('same'))).duplicate, true);
  assert.equal(f.sent.length, 0);
  assert.equal(Object.keys(JSON.parse(await readFile(f.options.stateFile)).pending).length, 1);
  const other = alert('same'); other.tenant = TRIAL_TENANT;
  other.messages[0].url = `${TRIAL_TENANT}/shell/monitoring/Messages/same`;
  await f.delivery.enqueue(other);
  const restarted = await createDiscordDelivery(f.options);
  await restarted.flush(); f.advance(100); await restarted.flush();
  assert.equal(f.sent.length, 2);
  assert.equal(restarted.status().pending, 0);
  assert.equal(restarted.status().delivered, 2);
  const again = await createDiscordDelivery(f.options);
  assert.equal((await again.enqueue(alert('same'))).duplicate, true);
  await again.flush(); assert.equal(f.sent.length, 2);
  const raw = await readFile(f.options.stateFile, 'utf8');
  assert.ok(!raw.includes(webhook) && !raw.includes('a'.repeat(50)));
}));

test('429 responses delay delivery and retry the same alert before continuing the queue', async () => {
  const calls = [];
  let limited = true;
  await fixture(async f => {
    await f.delivery.enqueue(alert('first'));
    await f.delivery.enqueue(alert('second', 'statusCode: 302'));
    await f.delivery.flush();
    assert.equal(calls.length, 1);
    assert.equal(f.delivery.status().pending, 2);
    f.advance(2499); await f.delivery.flush(); assert.equal(calls.length, 1);
    limited = false; f.advance(1); await f.delivery.flush();
    assert.equal(calls.length, 2);
    f.advance(100); await f.delivery.flush();
    assert.equal(calls.length, 3);
    assert.equal(f.delivery.status().pending, 0);
    assert.equal(calls[0].body.embeds[0].fields[1].value, calls[1].body.embeds[0].fields[1].value);
    assert.ok(calls.every(call => call.wait === 'true'));
  }, async (url, options) => {
    calls.push({body: JSON.parse(options.body), wait: new URL(url).searchParams.get('wait')});
    return limited ? Response.json({retry_after: 2.5}, {status: 429}) : Response.json({id: String(calls.length)});
  });
});

test('global 429s and successful exhausted buckets respect Discord-provided reset times', async () => {
  let calls = 0;
  await fixture(async f => {
    await f.delivery.enqueue(alert('one'));
    await f.delivery.enqueue(alert('two'));
    await f.delivery.enqueue(alert('three', 'statusCode: 302'));
    await f.delivery.flush(); assert.equal(calls, 1);
    f.advance(1999); await f.delivery.flush(); assert.equal(calls, 1);
    f.advance(1); await f.delivery.flush(); assert.equal(calls, 2);
    f.advance(3999); await f.delivery.flush(); assert.equal(calls, 2);
    f.advance(1); await f.delivery.flush(); assert.equal(calls, 3);
    f.advance(100); await f.delivery.flush(); assert.equal(calls, 4);
    assert.equal(f.delivery.status().pending, 0);
  }, async () => {
    calls++;
    if (calls === 1) return Response.json({retry_after: 2, global: true}, {status: 429});
    return Response.json({id: String(calls)}, {headers: calls === 2 ? {'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '4'} : {}});
  });
});

test('network failures and 5xx retain alerts and retry with backoff instead of losing them after the run', async () => {
  let calls = 0;
  await fixture(async f => {
    await f.delivery.enqueue(alert('retry'));
    await f.delivery.flush(); assert.equal(f.delivery.status().pending, 1);
    f.advance(2000); await f.delivery.flush(); assert.equal(calls, 2);
    f.advance(9 * 3600000); // Delivery remains independent of the tenant's nine-hour window.
    const restarted = await createDiscordDelivery(f.options);
    await restarted.flush();
    assert.equal(restarted.status().pending, 0);
    assert.equal(restarted.status().delivered, 1);
  }, async () => {
    if (++calls === 1) throw new Error(`Network failure containing secret ${webhook}`);
    return calls === 2 ? Response.json({}, {status: 503}) : Response.json({id: 'confirmed'});
  });
});

test('deleted or unauthorized webhooks pause retries, retain alerts and resume with a replacement webhook', async () => {
  for (const status of [401, 403, 404]) {
    let calls = 0;
    await fixture(async f => {
      await f.delivery.enqueue(alert('pending'));
      await f.delivery.flush(); await f.delivery.flush();
      assert.equal(calls, 1);
      assert.equal(f.delivery.status().blocked, true);
      assert.equal(f.delivery.status().pending, 1);
      assert.ok(!JSON.stringify(f.delivery.status()).includes('a'.repeat(50)));
      const fixed = await createDiscordDelivery({...f.options, webhook: webhook.replace('a'.repeat(50), 'c'.repeat(50))});
      await fixed.flush();
      assert.equal(fixed.status().pending, 0);
    }, async () => (++calls === 1 ? Response.json({}, {status}) : Response.json({id: 'fixed'})));
  }
});

test('invalid payloads stay visible for repair, and unconfirmed success is never marked delivered', async () => {
  let calls = 0;
  await fixture(async f => {
    await f.delivery.enqueue(alert('invalid'));
    await f.delivery.flush(); await f.delivery.flush();
    assert.equal(calls, 1); assert.equal(f.delivery.status().failed, 1);
    await f.delivery.enqueue(alert('unconfirmed'));
    await f.delivery.flush();
    assert.equal(f.delivery.status().delivered, 0);
    assert.equal(f.delivery.status().pending, 2);
  }, async () => (++calls === 1 ? Response.json({}, {status: 400}) : new Response(null, {status: 204})));
});

test('setup checks one webhook with GET, preserves Gmail and the relay key, and removes obsolete archive configuration', () => fixture(async f => {
  const requests = [];
  await verifyDiscordWebhook(config, async (url, options) => {
    requests.push({url, options});
    return Response.json({type: 1, channel_id: 'alerts-channel'});
  });
  assert.equal(requests.length, 1);
  assert.ok(requests.every(request => !request.options.method && request.options.redirect === 'error'));
  const envFile = join(f.folder, '.env');
  const {writeFile} = await import('node:fs/promises');
  await writeFile(envFile, `# existing settings\nSMTP_USER=sender@gmail.com\nSMTP_PASS=fake-app-password\nRELAY_TOKEN=${token}\nNOTIFICATION_PROVIDER=email\nDISCORD_ARCHIVE_WEBHOOK_URL=obsolete\nDISCORD_ARCHIVE_STATUS_CODES=302\n`);
  await saveDiscordConfig({config, token, envFile});
  const text = await readFile(envFile, 'utf8');
  assert.ok(text.includes('SMTP_PASS=fake-app-password'));
  assert.ok(text.includes(`RELAY_TOKEN=${token}`));
  assert.equal((text.match(/NOTIFICATION_PROVIDER=/g) || []).length, 1);
  assert.ok(text.includes('NOTIFICATION_PROVIDER=discord'));
  assert.ok(!text.includes('DISCORD_ARCHIVE_'));
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);
  await assert.rejects(saveDiscordConfig({config: {webhook: 'https://invalid.example'}, token, envFile}));
  assert.equal(await readFile(envFile, 'utf8'), text);
}));

test('extension → authenticated relay → saved Discord outbox → one alerts channel and monitoring warnings', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'is-discord-e2e-'));
  const nativeFetch = globalThis.fetch;
  const sent = [];
  let h, server, delivery;
  try {
    delivery = await createDiscordDelivery({...config, stateFile: join(folder, 'discord.json'), autoDispatch: false,
      now: () => Date.now(), fetcher: async (url, options) => {sent.push({url, body: JSON.parse(options.body)}); return Response.json({id: String(sent.length)});}});
    server = await createRelay({token, discordDelivery: delivery, stateFile: join(folder, 'receipts.json'), now: () => Date.now()});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    h = await backgroundHarness({relayFetch: (url, options) => nativeFetch(`${base}${new URL(url).pathname}`, options)});
    await h.start();
    h.sap.set(TENANT, [message('redirect'), message('unrelated'), {...message('discarded'), Status: 'DISCARDED'}]
      .map(item => ({...item, IntegrationFlowName: 'IF_Orders_Process'})));
    h.sapErrors.set(`${TENANT}:redirect`, 'HTTP operation failed with statusCode: 302');
    h.sapErrors.set(`${TENANT}:unrelated`, 'Receiver service unavailable');
    await h.poll(); await h.poll();
    assert.equal(delivery.status().pending, 3);
    assert.equal(h.store.state.runs[TENANT].sent, 3);
    const health = await nativeFetch(`${base}/health`, {headers: {Authorization: `Bearer ${token}`}});
    assert.equal((await health.json()).delivery.pending, 3);
    const publicStatus = (await h.request('status')).value;
    assert.equal(publicStatus.delivery.provider, 'discord');
    assert.ok(!JSON.stringify(publicStatus).includes('a'.repeat(50)));
    await delivery.flush(); h.time += 100; await delivery.flush(); h.time += 100; await delivery.flush();
    assert.equal(sent.length, 3);
    assert.ok(sent.every(item => item.url.startsWith(webhook) && item.body.flags === 0));
    assert.deepEqual(sent.map(item => item.body.content), ['[FAILED] IF_Orders_Process', '[FAILED] IF_Orders_Process', '[DISCARDED] IF_Orders_Process']);
    assert.ok(sent.every(item => item.body.embeds[0].fields.find(field => field.name === 'Time').value.endsWith(' IST')));
    assert.ok(sent.some(item => item.body.embeds[0].description.includes('statusCode: 302')));
    assert.ok(sent.some(item => item.body.embeds[0].description.includes('Receiver service unavailable')));
    h.time += HEARTBEAT_TIMEOUT;
    await server.checkMonitoring(); await delivery.flush();
    assert.equal(sent.length, 4);
    assert.ok(sent[3].url.startsWith(webhook));
    assert.match(sent[3].body.embeds[0].title, /monitoring stopped/);
    assert.equal(delivery.status().pending, 0);
  } finally {
    delivery?.stop(); if (delivery) await delivery.flush();
    if (server) await new Promise(resolve => server.close(resolve));
    h?.close(); await rm(folder, {recursive: true, force: true});
  }
});

test('background dispatch starts automatically and records confirmation without a manual flush', () => fixture(async f => {
  let confirm;
  const posted = new Promise(resolve => {confirm = resolve;});
  const worker = await createDiscordDelivery({...f.options, autoDispatch: true, fetcher: async () => {confirm(); return Response.json({id: 'auto-confirmed'});}});
  let deadline;
  try {
    worker.start(); await worker.enqueue(alert('automatic'));
    await Promise.race([posted, new Promise((_, reject) => {deadline = setTimeout(() => reject(new Error('Worker did not dispatch')), 1000);})]);
    await worker.flush();
    assert.equal(worker.status().pending, 0);
    assert.equal(worker.status().delivered, 1);
  } finally {clearTimeout(deadline); worker.stop(); await worker.flush();}
}));

test('outbox write failure prevents acknowledgment and pauses repeated posts after an ambiguous confirmation', () => fixture(async f => {
  const {mkdir} = await import('node:fs/promises');
  await mkdir(`${f.options.stateFile}.tmp`);
  await assert.rejects(f.delivery.enqueue(alert('not-accepted')));
  assert.equal(f.delivery.status().pending, 0);
  await rm(`${f.options.stateFile}.tmp`, {recursive: true});
  await f.delivery.enqueue(alert('accepted'));
  await mkdir(`${f.options.stateFile}.tmp`);
  await assert.rejects(f.delivery.flush(), /outbox could not be saved/);
  assert.equal(f.sent.length, 1);
  await f.delivery.flush(); assert.equal(f.sent.length, 1);
  assert.match(f.delivery.status().fatalError, /disk access/);
}));

test('a slow Discord request does not hold the HTTP relay lock or block health and monitoring heartbeats', async () => {
  let release, started;
  const entered = new Promise(resolve => {started = resolve;});
  await fixture(async f => {
    const server = await createRelay({token, discordDelivery: f.delivery, stateFile: join(f.folder, 'receipts.json'), now: f.options.now});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body) => fetch(`${base}${path}`, {method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(1000)});
    let sending;
    try {
      assert.equal((await post('/alert', alert('slow'))).status, 200);
      sending = f.delivery.flush();
      await entered;
      const run = f.options.now();
      assert.equal((await post('/monitor', {action: 'start', tenant: TENANT, run, endsAt: run + 9 * 3600000, lastCheck: run, status: 'healthy'})).status, 200);
      const health = await fetch(`${base}/health`, {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(1000)});
      assert.equal((await health.json()).delivery.pending, 1);
      release(Response.json({id: 'slow-confirmed'})); await sending;
      assert.equal(f.delivery.status().pending, 0);
    } finally {
      release?.(Response.json({id: 'cleanup'})); if (sending) await sending;
      await new Promise(resolve => server.close(resolve));
    }
  }, async () => {started(); return new Promise(resolve => {release = resolve;});});
});


test('migration keeps old queued alerts and delivery receipts while removing archive routing and silent flags', () => fixture(async f => {
  const {writeFile} = await import('node:fs/promises');
  await f.delivery.enqueue(alert('pending-legacy', 'statusCode: 302'));
  const modern = JSON.parse(await readFile(f.options.stateFile, 'utf8'));
  const job = Object.values(modern.pending)[0];
  job.target = 'archive'; job.payload.flags = 4096;
  job.payload.embeds[0].footer.text = 'Archived error · notifications suppressed';
  const legacy = {version: 1, pending: modern.pending, receipts: {'existing-receipt': f.options.now()},
    targets: {active: modern.destination, archive: {identity: 'old-archive', nextAt: 0, blocked: false}}, globalUntil: 0};
  await writeFile(f.options.stateFile, JSON.stringify(legacy));
  const upgraded = await createDiscordDelivery(f.options);
  assert.equal(upgraded.status().pending, 1);
  assert.equal(upgraded.status().delivered, 1);
  await upgraded.flush();
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].url.startsWith(webhook));
  assert.equal(f.sent[0].body.flags, 0);
  assert.ok(!f.sent[0].body.embeds[0].footer.text.includes('Archived'));
  const saved = JSON.parse(await readFile(f.options.stateFile, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(Object.keys(saved.pending).length, 0);
  assert.equal(Object.keys(saved.receipts).length, 2);
  assert.ok(!('targets' in saved));
}));
