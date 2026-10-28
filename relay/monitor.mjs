import {readFile, writeFile, rename} from 'node:fs/promises';
import {isTenantOrigin} from '../extension/core.js';

export const HEARTBEAT_TIMEOUT = 3 * 60 * 1000;
export function validateMonitor(value) {
  if (!value || !isTenantOrigin(value.tenant) || !Number.isSafeInteger(value.run) || value.run < 0 ||
      !['start', 'heartbeat', 'stop'].includes(value.action)) throw new Error('Invalid monitoring update');
  // Finite windows remain supported for older extensions during an upgrade.
  if (value.action !== 'stop' && ((value.endsAt !== null && (!Number.isSafeInteger(value.endsAt) || value.endsAt < value.run)) ||
      !Number.isSafeInteger(value.lastCheck) || value.lastCheck < value.run ||
      (value.endsAt !== null && value.lastCheck > value.endsAt) || !['healthy', 'problem'].includes(value.status))) throw new Error('Invalid monitoring window');
  if (value.problem != null && (typeof value.problem !== 'string' || value.problem.length > 400)) throw new Error('Invalid monitoring problem');
  if (value.phase != null && (typeof value.phase !== 'string' || value.phase.length > 100)) throw new Error('Invalid monitoring phase');
  return value;
}

const time = value => new Date(value).toLocaleString('en-GB', {timeZone: 'Asia/Kolkata', hour12: false}) + ' IST';
export async function createMonitoringWatch({stateFile, sendAlert, now = Date.now}) {
  let leases = {};
  try {leases = JSON.parse(await readFile(stateFile, 'utf8'));}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  for (const lease of Object.values(leases)) {
    lease.events ||= [];
    // Keep old outage identities so upgrading never resends an accepted notice.
    if (lease.notice) {
      lease.interruption ||= {episode: lease.notice.episode, lastCheck: lease.lastCheck,
        reason: lease.notice.problem, stoppedQueued: true};
      if (!lease.notice.sent) lease.events.push({kind: 'stopped', episode: lease.notice.episode, problem: lease.notice.problem});
      delete lease.notice;
    }
  }
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
  function interrupt(lease, reason, stopped = false) {
    if (!lease.interruption) {
      lease.lastEpisode = Math.max(now(), (lease.lastEpisode || 0) + 1);
      lease.interruption = {episode: lease.lastEpisode, lastCheck: lease.lastCheck, reason};
    }
    if (stopped && !lease.interruption.stoppedQueued) {
      lease.events.push({kind: 'stopped', episode: lease.interruption.episode, problem: reason});
      lease.interruption.stoppedQueued = true;
    }
  }
  function missedHeartbeat(lease) {
    if (lease.cancelled) return;
    const checkedUntil = lease.endsAt == null ? now() : Math.min(now(), lease.endsAt);
    if (checkedUntil - lease.lastContact < HEARTBEAT_TIMEOUT) return;
    interrupt(lease, [
      `Reason: the relay received no extension heartbeat for ${Math.floor((checkedUntil - lease.lastContact) / 60000)} minutes.`,
      `Last heartbeat: ${time(lease.lastContact)}. Last successful SAP check: ${time(lease.lastCheck)}.`,
      `Last activity: ${lease.phase || 'not recorded by this extension version'}.`,
      lease.problem ? `Last reported problem: ${lease.problem}` : `Last reported state: ${lease.status}.`,
      'The exact cause is unknown: a missing heartbeat alone cannot distinguish Chrome/extension shutdown, computer sleep, or a blocked connection to the local relay.',
      'Open the extension to check the tenant; keep Chrome and the relay running. SAP session expiry is not confirmed by this alert.'
    ].join('\n'), true);
  }
  async function sendEvents(lease) {
    while (!lease.cancelled && lease.events.length) {
      const event = lease.events[0];
      await sendAlert({...event, tenant: lease.tenant, run: lease.run});
      lease.events.shift();
      await save();
    }
  }
  return {
    async receive(update) {
      const key = `${update.tenant}:${update.run}`;
      const previous = leases[key];
      if (update.action === 'stop') {
        if (previous) {
          // A manual Stop also cancels lifecycle notices still waiting locally.
          previous.cancelled = true;
          previous.events = [];
          delete leases[key];
        }
      } else if (!previous?.cancelled) {
        if (previous && update.lastCheck < previous.lastCheck) {
          // An older independent heartbeat must not undo a newer successful poll.
          previous.lastContact = now();
          await save();
          return {ok: true};
        }
        if (previous) missedHeartbeat(previous); // Covers sleep while relay timers were suspended.
        const lease = previous || {tenant: update.tenant, run: update.run, lastCheck: update.lastCheck, events: []};
        if (update.action === 'start' && !lease.startAnnounced) {
          lease.events.push({kind: 'started', episode: update.run,
            problem: `Monitoring started by you.\nTime: ${time(now())}.\nSAP message checks are running every minute.`});
          lease.startAnnounced = true;
        }
        if (previous && update.status === 'healthy' && update.lastCheck > previous.lastCheck &&
            now() - previous.lastCheck >= HEARTBEAT_TIMEOUT && !lease.interruption) {
          interrupt(lease, 'No successful SAP check was recorded for at least three minutes.');
        }
        if (update.status === 'problem') interrupt(lease, update.problem || 'The extension reported a monitoring problem.');
        if (update.status === 'healthy' && lease.interruption && update.lastCheck > lease.interruption.lastCheck) {
          lease.events.push({kind: 'resumed', episode: lease.interruption.episode,
            problem: `Monitoring resumed.\nTime: ${time(now())}.\nA new SAP check completed successfully.\nPrevious interruption: ${lease.interruption.reason.slice(0, 220)}`});
          delete lease.interruption;
        }
        // Mutate the same lease object: heartbeat writes may arrive during delivery.
        Object.assign(lease, {endsAt: update.endsAt, lastCheck: update.lastCheck, lastContact: now(),
          status: update.status, problem: update.problem || null, phase: update.phase || null});
        leases[key] = lease;
      }
      await save();
      return {ok: true};
    },
    async check() {
      for (const [key, lease] of Object.entries(leases)) {
        missedHeartbeat(lease);
        // Persist events before delivery, including gaps detected only on this pass.
        await save();
        try {await sendEvents(lease);}
        catch { /* Keep notices for retry without holding up extension heartbeats. */ }
        if ((lease.cancelled || lease.endsAt != null && now() >= lease.endsAt) && !lease.events.length) {
          delete leases[key];
          await save();
        }
      }
    },
    async shutdown() {
      for (const lease of Object.values(leases)) {
        if (lease.cancelled || lease.endsAt != null && now() >= lease.endsAt) continue;
        interrupt(lease, 'The local notification relay is stopping while this tenant is being monitored. Restart the relay to restore alerts.', true);
        await save();
        try {await sendEvents(lease);}
        catch { /* Persist for delivery after the relay is restarted. */ }
      }
    }
  };
}
