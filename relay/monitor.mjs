import {readFile, writeFile, rename} from 'node:fs/promises';
import {isTenantOrigin, DURATION} from '../extension/core.js';

export const HEARTBEAT_TIMEOUT = 3 * 60 * 1000;
export function validateMonitor(value) {
  if (!value || !isTenantOrigin(value.tenant) || !Number.isSafeInteger(value.run) || value.run < 0 ||
      !['start', 'heartbeat', 'stop'].includes(value.action)) throw new Error('Invalid monitoring update');
  if (value.action !== 'stop' && (value.endsAt !== value.run + DURATION || !Number.isSafeInteger(value.lastCheck) ||
      value.lastCheck < value.run || value.lastCheck > value.endsAt || !['healthy', 'problem'].includes(value.status))) throw new Error('Invalid monitoring window');
  return value;
}

export async function createMonitoringWatch({stateFile, sendAlert, now = Date.now}) {
  let leases = {};
  try {leases = JSON.parse(await readFile(stateFile, 'utf8'));}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  async function save() {
    await writeFile(`${stateFile}.tmp`, JSON.stringify(leases), {mode: 0o600});
    await rename(`${stateFile}.tmp`, stateFile);
  }
  async function sendNotice(lease) {
    if (!lease.notice || lease.notice.sent) return;
    await sendAlert({kind: 'stopped', tenant: lease.tenant, run: lease.run,
      episode: lease.notice.episode, problem: lease.notice.problem});
    lease.notice.sent = true;
    await save();
  }
  return {
    async receive(update) {
      const key = `${update.tenant}:${update.run}`;
      if (update.action === 'stop') delete leases[key];
      else {
        const previous = leases[key];
        leases[key] = {
          tenant: update.tenant, run: update.run, endsAt: update.endsAt,
          lastCheck: update.lastCheck, lastContact: now(), status: update.status,
          // Preserve an undelivered outage notice when checks recover while Gmail is unavailable.
          ...(previous?.notice && !previous.notice.sent ? {notice: previous.notice} : {})
        };
      }
      await save();
      return {ok: true};
    },
    async check() {
      for (const [key, lease] of Object.entries(leases)) {
        if (!lease.notice && Math.min(now(), lease.endsAt) - lease.lastContact >= HEARTBEAT_TIMEOUT) {
          lease.notice = {episode: lease.lastContact, sent: false,
            problem: 'No monitoring heartbeat arrived for at least three minutes. Chrome, the extension, or the computer may have stopped. Open Chrome and restart this tenant if needed.'};
          await save();
        }
        try {await sendNotice(lease);}
        catch { /* SMTP outage: keep the notice and retry on the next check/restart. */ }
        if (now() >= lease.endsAt && (!lease.notice || lease.notice.sent)) {
          delete leases[key];
          await save();
        }
      }
    },
    async shutdown() {
      for (const lease of Object.values(leases)) {
        if (now() >= lease.endsAt) continue;
        lease.notice ||= {episode: now(), sent: false,
          problem: 'The local notification relay is stopping while this tenant is being monitored. Restart the relay to restore alerts.'};
        await save();
        try {await sendNotice(lease);}
        catch { /* Persist for delivery after the relay is restarted. */ }
      }
    }
  };
}
