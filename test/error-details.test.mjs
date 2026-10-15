import test from 'node:test';
import assert from 'node:assert/strict';
import {readMessageErrors} from '../extension/poll.js';
import {TENANT} from './fixtures.mjs';

async function withSAP(fetcher, action) {
  const previous = {fetch: globalThis.fetch, location: globalThis.location, now: Date.now};
  globalThis.location = new URL(`${TENANT}/shell/monitoring/Messages/`);
  globalThis.fetch = fetcher;
  try {return await action();}
  finally {globalThis.fetch = previous.fetch; globalThis.location = previous.location; Date.now = previous.now;}
}
const message = (id, status = 'FAILED') => ({id, status});
const read = messages => readMessageErrors(messages, TENANT);

test('reads authenticated error text from the fixed tenant route and skips discarded messages', async () => {
  const urls = [];
  const errors = await withSAP(async (url, options) => {
    urls.push(url);
    assert.equal(url, `${TENANT}/odata/api/v1/MessageProcessingLogs('failed-id')/ErrorInformation/$value`);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response('  java.net.ConnectException: Connection refused\r\nCaused by: receiver unavailable\u0000 ', {headers: {'content-type': 'application/octet-stream'}});
  }, () => read([message('failed-id'), message('discarded-id', 'DISCARDED')]));
  assert.deepEqual(errors, ['java.net.ConnectException: Connection refused\nCaused by: receiver unavailable', 'No error information available.']);
  assert.equal(urls.length, 1);
});

test('absent errors, failed lookups and login responses produce accurate fallbacks without aborting the batch', async () => {
  const responses = [
    new Response(null, {status: 404}), new Response(null, {status: 204}), new Response('  '),
    new Response('Denied', {status: 403}), new Response('Failed', {status: 500}),
    new Response('<html>Private login form</html>', {headers: {'content-type': 'text/html'}}),
    new Response('<!DOCTYPE html><html>Private login form</html>', {headers: {'content-type': 'text/plain'}}),
    new Error('Network or timeout failure'), new Response('Actual error text')
  ];
  const errors = await withSAP(async url => {
    const index = Number(/Logs\('(\d+)'\)/.exec(url)[1]);
    if (responses[index] instanceof Error) throw responses[index];
    return responses[index];
  }, () => read(responses.map((_, index) => message(String(index)))));
  assert.ok(errors.slice(0, 3).every(error => error === 'No error information available.'));
  assert.ok(errors.slice(3, 8).every(error => error === 'Error details unavailable. Open the message in IS for details.'));
  assert.equal(errors[8], 'Actual error text');
  assert.ok(errors.every(error => !/Private login|Denied|Network/.test(error)));
});

test('streams UTF-8 error text, truncates at 2000 characters and stops reading a long response', async () => {
  const encoded = new TextEncoder().encode('Receiver error: ' + 'é'.repeat(10000));
  let offset = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(encoded.slice(offset, offset + 127));
      offset += 127;
      if (offset >= encoded.length) controller.close();
    },
    cancel() {cancelled = true;}
  });
  const errors = await withSAP(async () => new Response(stream), () => read([message('long')]));
  assert.equal(errors[0].length, 2000);
  assert.match(errors[0], /^Receiver error: é+/);
  assert.ok(errors[0].endsWith('\n[truncated]'));
  assert.ok(!errors[0].includes('\ufffd'));
  assert.equal(cancelled, true);
  assert.ok(offset < encoded.length);
});

test('limits lookup concurrency to five and preserves the input message order', async () => {
  let active = 0;
  let maximum = 0;
  const errors = await withSAP(async url => {
    active++;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    active--;
    return new Response(/Logs\('(\d+)'\)/.exec(url)[1]);
  }, () => read(Array.from({length: 12}, (_, index) => message(String(index)))));
  assert.equal(maximum, 5);
  assert.deepEqual(errors, Array.from({length: 12}, (_, index) => String(index)));
});

test('the detail budget leaves unattempted messages with a fallback', async () => {
  let now = 1000;
  let calls = 0;
  await withSAP(async () => {
    calls++;
    now += 15000;
    return new Response('First error');
  }, async () => {
    Date.now = () => now;
    const errors = await read([message('first'), message('second'), message('third')]);
    assert.equal(calls, 1);
    assert.equal(errors[0], 'First error');
    assert.ok(errors.slice(1).every(error => error.startsWith('Error details unavailable.')));
  });
});

test('rejects tenant navigation, unsafe IDs and invalid batches before any detail request', async () => {
  await withSAP(async () => {throw new Error('Should never fetch');}, async () => {
    for (const messages of [[], null, [message("id')/Attachments")], [message(42)], [message('completed', 'COMPLETED')], Array.from({length: 51}, () => message('id'))]) {
      await assert.rejects(read(messages), /Invalid error detail batch/);
    }
    for (const url of ['https://other.example/shell/monitoring/Messages/', `${TENANT}/shell/design`]) {
      globalThis.location = new URL(url);
      await assert.rejects(read([message('id')]), /left the monitor page/);
    }
  });
});
