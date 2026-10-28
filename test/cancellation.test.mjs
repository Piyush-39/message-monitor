import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDiscordDelivery} from '../relay/discord.mjs';
import {createTeamsDelivery} from '../relay/teams.mjs';
import {createRelay} from '../relay/server.mjs';
import {backgroundHarness, message, token} from './background-harness.mjs';
import {TENANT, TRIAL_TENANT} from './fixtures.mjs';

const run = 1791800000000;
const alert = (id, tenant = TENANT, startedAt = run) => ({kind: 'messages', tenant, run: startedAt,
  messages: [{id, flow: 'Orders', status: 'FAILED', time: '', url: `${tenant}/shell/monitoring/Messages/${id}`}]});
const providers = [
  {name: 'Discord', create: createDiscordDelivery, webhook: `https://discord.com/api/webhooks/111111111111111111/${'a'.repeat(50)}`,
    accepted: () => Response.json({id: 'confirmed'})},
  {name: 'Teams', create: createTeamsDelivery,
    webhook: `https://prod-01.westeurope.logic.azure.com/workflows/${'1'.repeat(32)}/triggers/manual/paths/invoke?api-version=1&sig=test-signature`,
    accepted: () => new Response(null, {status: 202})}
];

async function fixture(provider, action) {
  const folder = await mkdtemp(join(tmpdir(), 'is-cancel-'));
  let clock = Date.now();
  const sent = [];
  const options = {webhook: provider.webhook, stateFile: join(folder, 'outbox.json'), autoDispatch: false,
    now: () => clock, fetcher: async (url, options) => {sent.push(JSON.parse(options.body)); return provider.accepted();}};
  const delivery = await provider.create(options);
  try {await action({folder, options, delivery, sent, advance() {clock += 1000;}});}
  finally {delivery.stop(); await delivery.flush(); await rm(folder, {recursive: true, force: true});}
}

for (const provider of providers) {
  test(`${provider.name}: Stop cancels the run durably while preserving other tenants, new runs, tests and delivered history`, () => fixture(provider, async f => {
    await f.delivery.enqueue(alert('delivered'));
    await f.delivery.flush();
    await f.delivery.enqueue(alert('pending'));
    await f.delivery.enqueue({kind: 'started', tenant: TENANT, run, episode: run, problem: 'Started'});
    await f.delivery.enqueue(alert('other-tenant', TRIAL_TENANT));
    await f.delivery.enqueue(alert('new-run', TENANT, run + 1));
    await f.delivery.enqueue({kind: 'test', nonce: 'keep-test'});
    assert.equal((await f.delivery.cancelRun(TENANT, run)).cancelled, 2);
    assert.equal(f.delivery.status().pending, 3);
    assert.equal(f.delivery.status().delivered, 1);
    assert.equal((await f.delivery.enqueue(alert('late'))).cancelled, true);
    const restarted = await provider.create(f.options);
    try {
      assert.equal((await restarted.enqueue(alert('late-after-restart'))).cancelled, true);
      for (let i = 0; i < 3; i++) {f.advance(); await restarted.flush();}
      assert.equal(restarted.status().pending, 0);
      assert.equal(restarted.status().delivered, 4);
      assert.equal(f.sent.length, 4);
    } finally {restarted.stop(); await restarted.flush();}
  }));

  test(`${provider.name}: Stop removes legacy and rejected alerts for that tenant`, () => fixture(provider, async f => {
    await f.delivery.enqueue(alert('legacy'));
    await f.delivery.enqueue(alert('other-legacy', TRIAL_TENANT));
    const state = JSON.parse(await readFile(f.options.stateFile, 'utf8'));
    for (const job of Object.values(state.pending)) {delete job.tenant; delete job.run; job.failed = true;}
    await writeFile(f.options.stateFile, JSON.stringify(state));
    const upgraded = await provider.create(f.options);
    try {
      assert.equal((await upgraded.cancelRun(TENANT, run)).cancelled, 1);
      assert.equal(upgraded.status().failed, 1);
      const remaining = Object.values(JSON.parse(await readFile(f.options.stateFile, 'utf8')).pending);
      assert.equal(remaining[0].tenant, TRIAL_TENANT);
    } finally {upgraded.stop(); await upgraded.flush();}
  }));

  test(`${provider.name}: failed cancellation writes block sends and can be retried durably`, () => fixture(provider, async f => {
    await f.delivery.enqueue(alert('keep-until-cancel-saved'));
    await mkdir(`${f.options.stateFile}.tmp`);
    await assert.rejects(f.delivery.cancelRun(TENANT, run));
    await f.delivery.flush();
    assert.equal(f.sent.length, 0);
    assert.equal(f.delivery.status().pending, 1);
    await rm(`${f.options.stateFile}.tmp`, {recursive: true});
    assert.equal((await f.delivery.cancelRun(TENANT, run)).cancelled, 1);
    const restarted = await provider.create(f.options);
    try {
      assert.equal((await restarted.enqueue(alert('late'))).cancelled, true);
      await restarted.flush();
      assert.equal(restarted.status().pending, 0);
      assert.equal(f.sent.length, 0);
    } finally {restarted.stop(); await restarted.flush();}
  }));

  test(`${provider.name}: Stop aborts an in-flight request without waiting for delivery or reviving its retry`, () => fixture(provider, async f => {
    let entered, release, signal;
    const started = new Promise(resolve => {entered = resolve;});
    const calls = [];
    const delivery = await provider.create({...f.options, fetcher: async (url, options) => {
      calls.push(JSON.parse(options.body));
      if (calls.length > 1) return provider.accepted();
      signal = options.signal;
      entered();
      return new Promise((resolve, reject) => {
        release = () => resolve(provider.accepted());
        signal.addEventListener('abort', () => reject(new Error('Aborted')), {once: true});
      });
    }});
    let sending;
    try {
      await delivery.enqueue(alert('slow'));
      await delivery.enqueue(alert('also-cancel'));
      await delivery.enqueue(alert('keep', TRIAL_TENANT));
      sending = delivery.flush();
      await started;
      await delivery.cancelRun(TENANT, run);
      assert.equal(signal.aborted, true);
      await sending;
      assert.equal(delivery.status().pending, 0);
      assert.equal(delivery.status().delivered, 1);
      assert.equal(delivery.status().fatalError, null);
      assert.equal(calls.length, 2);
      f.advance(); await delivery.flush();
      assert.equal(calls.length, 2);
    } finally {release?.(); delivery.stop(); if (sending) await sending;}
  }));
}

test('extension Stop clears its Discord backlog and late handoffs stay cancelled after a relay restart', () => fixture(providers[0], async f => {
  const nativeFetch = globalThis.fetch;
  const config = {token, delivery: f.delivery, stateFile: join(f.folder, 'receipts.json')};
  let server = await createRelay(config), h, restartedDelivery;
  const listen = async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  let base = await listen();
  const post = async (path, body) => {
    const response = await nativeFetch(`${base}${path}`, {method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(1500)});
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    h = await backgroundHarness({relayFetch: (url, options) => nativeFetch(`${base}${new URL(url).pathname}`, options)});
    await h.start(); await h.start(TRIAL_TENANT); await server.checkMonitoring();
    const startedAt = h.store.state.runs[TENANT].startedAt;
    h.sap.set(TENANT, [message('cancel-one'), message('cancel-two')]);
    h.sap.set(TRIAL_TENANT, [message('keep-one')]);
    await h.poll();
    assert.equal(f.delivery.status().pending, 5);
    assert.equal((await h.request('stop', TENANT)).ok, true);
    assert.equal(f.delivery.status().pending, 2);
    assert.equal((await post('/alert', alert('late', TENANT, startedAt))).cancelled, true);
    const heartbeat = {action: 'heartbeat', tenant: TENANT, run: startedAt, endsAt: null, lastCheck: startedAt, status: 'healthy'};
    assert.equal((await post('/monitor', heartbeat)).cancelled, true);
    assert.ok(!JSON.parse(await readFile(`${config.stateFile}.monitoring`, 'utf8'))[`${TENANT}:${startedAt}`]);
    await server.checkMonitoring(); await new Promise(resolve => server.close(resolve));
    restartedDelivery = await createDiscordDelivery(f.options);
    server = await createRelay({...config, delivery: restartedDelivery});
    base = await listen();
    assert.equal((await post('/alert', alert('late-restart', TENANT, startedAt))).cancelled, true);
    assert.equal((await post('/monitor', heartbeat)).cancelled, true);
    f.advance(); await restartedDelivery.flush(); f.advance(); await restartedDelivery.flush();
    assert.equal(restartedDelivery.status().pending, 0);
    assert.equal(f.sent.length, 2);
    assert.ok(f.sent.every(payload => payload.embeds[0].url.startsWith(TRIAL_TENANT)));
  } finally {
    h?.close(); restartedDelivery?.stop();
    if (restartedDelivery) await restartedDelivery.flush();
    await server.checkMonitoring();
    await new Promise(resolve => server.close(resolve));
  }
}));
