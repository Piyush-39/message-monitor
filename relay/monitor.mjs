import {readFile, writeFile, rename} from 'node:fs/promises';
import {isTenantOrigin, DURATION} from '../extension/core.js';

export const HEARTBEAT_TIMEOUT = 3 * 60 * 1000;
export function validateMonitor(value) {
  if (!value || !isTenantOrigin(value.tenant) || !Number.isSafeInteger(value.run) || value.run < 0 ||
      !['start', 'heartbeat', 'stop'].includes(value.action)) throw new Error('Invalid monitoring update');
  if (value.action !== 'stop' && (value.endsAt !== value.run + DURATION || !Number.isSafeInteger(value.lastCheck) ||
      value.lastCheck < value.run || value.lastCheck > value.endsAt || !['healthy', 'problem'].includes(value.status))) throw new Error('Invalid monitoring window');
  if (value.problem != null && (typeof value.problem !== 'string' || value.problem.length > 400)) throw new Error('Invalid monitoring problem');
  if (value.phase != null && (typeof value.phase !== 'string' || value.phase.length > 100)) throw new Error('Invalid monitoring phase');
  return value;
}

export async function createMonitoringWatch({stateFile, sendAlert, now = Date.now}) {
  let leases = {};
  try {leases = JSON.parse(await readFile(stateFile, 'utf8'));}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  let writes = Promise.resolve();
  function save() {
    const snapshot = JSON.stringify(leases);
    const result = writes.then(async () => {
      await writeFile(`${stateFile}.tmp`, snapshot, {mode: 0o600});
      await rename(`${stateFile}.tmp`, stateFile);
    });
    writes = result.catch(() => {});
    return result;
  }
  function missedHeartbeat(lease) {
    if (lease.notice || Math.min(now(), lease.endsAt) - lease.lastContact < HEARTBEAT_TIMEOUT) return;
    const time = value => new Date(value).toLocaleString('en-GB', {timeZone: 'Asia/Kolkata', hour12: false}) + ' IST';
    lease.notice = {episode: lease.lastContact, sent: false, problem: [
      `Reason: the relay received no extension heartbeat for ${Math.floor((Math.min(now(), lease.endsAt) - lease.lastContact) / 60000)} minutes.`,
      `Last heartbeat: ${time(lease.lastContact)}. Last successful SAP check: ${time(lease.lastCheck)}.`,
      `Last activity: ${lease.phase || 'not recorded by this extension version'}.`,
      lease.problem ? `Last reported problem: ${lease.problem}` : `Last reported state: ${lease.status}.`,
      'The exact cause is unknown: a missing heartbeat alone cannot distinguish Chrome/extension shutdown, computer sleep, or a blocked connection to the local relay.',
      'Open the extension to check the tenant; keep Chrome and the relay running. SAP session expiry is not confirmed by this alert.'
    ].join('\n')};
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
          problem: update.problem || null, phase: update.phase || null,
          // Preserve an undelivered outage notice when checks recover while Gmail is unavailable.
          ...(previous?.notice && !previous.notice.sent ? {notice: previous.notice} : {})
        };
      }
      await save();
      return {ok: true};
    },
    async check() {
      for (const [key, lease] of Object.entries(leases)) {
        const hadNotice = Boolean(lease.notice);
        missedHeartbeat(lease);
        if (!hadNotice && lease.notice) {
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
