import {createHash} from 'node:crypto';
import {readFile, writeFile, rename} from 'node:fs/promises';

const hash = value => createHash('sha256').update(value).digest('hex');
function retryDelay(response, body, now) {
  // Discord uses seconds in JSON; Teams workflows use Retry-After seconds or HTTP dates.
  const raw = body?.retry_after ?? response.headers.get('Retry-After') ?? 1;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(1000, date - now) : 1000;
}
const deliveryKey = (provider, alert) => hash(JSON.stringify([provider, alert.kind, alert.tenant,
  ['messages', 'failures'].includes(alert.kind) ? alert.messages[0].id : alert.kind === 'test' ? alert.nonce : [alert.run, alert.episode]]));

export async function createWebhookDelivery({webhook: destinationURL, stateFile, provider, label, formatMessage,
  requestURL = value => value, isAccepted, migrate = value => value, spacing = 100,
  fetcher = fetch, now = Date.now, autoDispatch = true}) {
  let state = {version: 2, pending: {}, receipts: {}, destination: {}, globalUntil: 0};
  try {state = JSON.parse(await readFile(stateFile, 'utf8'));}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  state = migrate(state);
  if (state.version !== 2 || !state.pending || !state.receipts || !state.destination) throw new Error(`Invalid ${label} outbox state. Preserve the file and restore it from backup.`);
  state.cancelledRuns ||= {};
  // Older outboxes have only a formatted payload. Recover the tenant so Stop
  // also clears those alerts; their original run cannot be recovered.
  for (const job of Object.values(state.pending)) {
    if (!job.tenant) {
      const link = job.payload?.embeds?.[0]?.url || job.payload?.attachments?.[0]?.content?.actions?.[0]?.url;
      try {job.tenant = new URL(link).origin;} catch { /* Test notices have no tenant. */ }
    }
  }
  const cancelledRuns = new Set(Object.keys(state.cancelledRuns));
  const cancelledTenants = new Set([...cancelledRuns].map(key => key.slice(0, key.lastIndexOf(':'))));
  const runKey = (tenant, run) => `${tenant}:${run}`;
  const isCancelled = (tenant, run) => cancelledRuns.has(runKey(tenant, run));
  const cancelledJob = job => isCancelled(job.tenant, job.run) ||
    (!Number.isSafeInteger(job.run) && cancelledTenants.has(job.tenant));
  state.receipts = Object.fromEntries(Object.entries(state.receipts).filter(([, time]) => time > now() - 30 * 86400000));
  if (state.destination.identity !== hash(destinationURL)) state.destination = {identity: hash(destinationURL), nextAt: 0, error: null, blocked: false};
  let writes = Promise.resolve(), pumping, timer, running = false, stopped = false, controller, activeJob, fatalError = null;
  function change(operation) {
    const result = writes.then(async () => {
      const next = structuredClone(state);
      const value = operation(next);
      await writeFile(`${stateFile}.tmp`, JSON.stringify(next), {mode: 0o600});
      await rename(`${stateFile}.tmp`, stateFile);
      state = next;
      return value;
    });
    writes = result.catch(() => {});
    return result;
  }
  await change(() => {});
  function status() {
    const jobs = Object.values(state.pending);
    return {provider, pending: jobs.length,
      delivered: Object.keys(state.receipts).length, failed: jobs.filter(job => job.failed).length, fatalError,
      errors: state.destination.error ? {[provider]: state.destination.error} : {},
      blocked: state.destination.blocked};
  }
  function dueJob() {
    const eligible = job => !job.failed && !cancelledJob(job) && !state.destination.blocked &&
      Math.max(state.destination.nextAt, state.globalUntil) <= now();
    const jobs = Object.values(state.pending);
    return jobs.find(job => job.priority && eligible(job)) || jobs.find(eligible);
  }
  function schedule() {
    if (!running || stopped || pumping) return;
    clearTimeout(timer);
    const ready = Object.values(state.pending).filter(job => !job.failed && !cancelledJob(job) && !state.destination.blocked);
    if (!ready.length) return;
    const next = ready.reduce((earliest, job) => Math.min(earliest, Math.max(state.destination.nextAt, state.globalUntil)), Infinity);
    timer = setTimeout(() => flush().catch(() => {}), Math.min(60000, Math.max(0, next - now())));
    timer.unref();
  }
  async function attempt(job) {
    let response, body;
    activeJob = job;
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      response = await fetcher(requestURL(destinationURL), {method: 'POST', redirect: 'error', signal: controller.signal,
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify(job.payload)});
      body = await response.json().catch(() => null);
    } catch { /* Persist a retry without exposing the webhook URL or response body. */ }
    finally {clearTimeout(timeout); controller = null; activeJob = null;}
    await change(next => {
      const route = next.destination;
      const current = next.pending[job.key];
      // Stop may remove the alert while a request is in flight. Do not revive
      // it, count it as delivered, or apply an aborted request's retry delay.
      if (!current || cancelledJob(current)) return;
      if (response && isAccepted(response, body)) {
        next.receipts[job.key] = now();
        delete next.pending[job.key];
        route.error = null;
        const reset = Number(response.headers.get('X-RateLimit-Reset-After'));
        route.nextAt = now() + (response.headers.get('X-RateLimit-Remaining') === '0' && Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000) : spacing);
      } else if (response?.status === 429) {
        const until = now() + retryDelay(response, body, now());
        route.nextAt = until;
        route.error = `${label} rate limit; waiting to retry.`;
        if (body?.global === true || response.headers.get('X-RateLimit-Global') === 'true' || response.headers.get('X-RateLimit-Scope') === 'global') next.globalUntil = until;
      } else if ([401, 403, 404, 410].includes(response?.status)) {
        route.blocked = true;
        route.error = `${label} webhook rejected (HTTP ${response.status}). Recreate the webhook and rerun setup.`;
      } else if ([400, 413, 422].includes(response?.status)) {
        current.failed = true;
        route.error = `${label} rejected an alert format (HTTP ${response.status}). The alert is retained locally; update the relay before retrying.`;
      } else {
        current.attempts++;
        route.nextAt = now() + Math.min(60000, 1000 * 2 ** Math.min(current.attempts, 6));
        route.error = response ? `${label} delivery failed (HTTP ${response.status}); retrying.` : `${label} unreachable or delivery unconfirmed; retrying.`;
      }
    });
  }
  function flush() {
    if (pumping) return pumping;
    if (stopped || fatalError) return Promise.resolve();
    pumping = (async () => {
      // Work in short passes. Network waits never hold the relay's HTTP/heartbeat lock.
      for (let count = 0; count < 20 && !stopped; count++) {
        const job = dueJob();
        if (!job) break;
        await attempt(job);
      }
    })().catch(async () => {
      // A local write failure must not cause a tight loop resending an accepted message.
      running = false;
      fatalError = `${label} outbox could not be saved. Check disk access, then restart the relay.`;
      throw new Error(fatalError);
    }).finally(() => {pumping = null; schedule();});
    return pumping;
  }
  return {
    status, flush, isCancelled,
    async cancelRun(tenant, run) {
      // Gate dispatch immediately, even while an earlier disk write finishes.
      const key = runKey(tenant, run);
      cancelledRuns.add(key);
      cancelledTenants.add(tenant);
      if (activeJob && cancelledJob(activeJob)) controller?.abort();
      const cancelled = await change(next => {
        next.cancelledRuns[key] = now();
        let count = 0;
        for (const [key, job] of Object.entries(next.pending)) {
          if (cancelledJob(job)) {delete next.pending[key]; count++;}
        }
        return count;
      });
      schedule();
      return {ok: true, cancelled};
    },
    async enqueue(alert) {
      if (isCancelled(alert.tenant, alert.run)) return {ok: true, queued: false, cancelled: true, provider};
      const key = deliveryKey(provider, alert);
      const payload = formatMessage(alert);
      const result = await change(next => {
        if (isCancelled(alert.tenant, alert.run)) return {queued: false, cancelled: true};
        if (next.receipts[key] || next.pending[key]) return {queued: false, duplicate: true};
        next.pending[key] = {key, payload, tenant: alert.tenant, run: alert.run,
          priority: ['problem', 'stopped', 'started', 'resumed'].includes(alert.kind), attempts: 0, acceptedAt: now()};
        return {queued: true, duplicate: false};
      });
      schedule();
      return {ok: true, ...result, provider};
    },
    start() {stopped = false; running = autoDispatch; schedule();},
    stop() {stopped = true; running = false; clearTimeout(timer); controller?.abort();}
  };
}
