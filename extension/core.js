// Only for migrating runs/receipts saved by version 1.0.0 without a tenant.
export const LEGACY_TENANT = 'https://inccpidev.integrationsuite.cfapps.eu10.hana.ondemand.com';
export function isTenantOrigin(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.origin === value && !parsed.username && !parsed.password;
  } catch { return false; }
}
export function monitorTenant(url) {
  try {
    const parsed = new URL(url);
    return isTenantOrigin(parsed.origin) && !parsed.username && !parsed.password && /^\/shell\/monitoring\/Messages(?:\/|$)/.test(parsed.pathname) ? parsed.origin : null;
  } catch { return null; }
}
export function monitorSelection(url) {
  if (!monitorTenant(url)) throw new Error('Open Monitor Message Processing first.');
  const encoded = new URL(url).pathname.replace(/^\/shell\/monitoring\/Messages\/?/, '');
  let filter = {};
  try {if (encoded) filter = JSON.parse(decodeURIComponent(encoded));}
  catch {throw new Error('Cannot read the monitor page filters. Apply the filters with Go and try again.');}
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new Error('Invalid monitor page filters.');
  const ids = filter.artifactIds === undefined || filter.artifactIds === 'ALL' ? [] : filter.artifactIds;
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id || id.length > 512)) throw new Error('Cannot read the selected artifact IDs. Apply the filters with Go and try again.');
  if (filter.packageId !== undefined && (typeof filter.packageId !== 'string' || filter.packageId.length > 512)) throw new Error('Cannot read the selected package.');
  return {filter, scope: {artifactIds: [...new Set(ids)], packageId: filter.packageId && filter.packageId !== 'ALL' ? filter.packageId : null}};
}
export const DURATION = 9 * 60 * 60 * 1000;
export const EMAIL_STATUSES = ['FAILED', 'RETRY', 'PROCESSING', 'ESCALATED', 'CANCELLED', 'DISCARDED', 'ABANDONED'];
export const statusLabel = status => status[0] + status.slice(1).toLowerCase();
export function emailStatuses(value = EMAIL_STATUSES) {
  if (!Array.isArray(value) || !value.length || value.some(status => !EMAIL_STATUSES.includes(status))) {
    throw new Error('Select at least one alert status. Completed is always excluded.');
  }
  return EMAIL_STATUSES.filter(status => value.includes(status));
}
export const POLL_ALARM = 'is-watchdog-poll';
export const HEARTBEAT_ALARM = 'is-watchdog-heartbeat';
export const END_ALARM = 'is-watchdog-end';
export const endAlarm = tenant => `${END_ALARM}:${tenant}`;

export function monitoringState(saved) {
  if (saved?.version === 2) return saved;
  const runs = {};
  if (saved?.startedAt) {
    const tenant = saved.tenant || LEGACY_TENANT;
    runs[tenant] = {...saved, tenant};
  }
  return {version: 2, runs, pendingStops: []};
}

export function unseenMessages(messages, seen) {
  const ids = new Set(seen);
  return messages.filter(message => {
    if (ids.has(message.id)) return false;
    ids.add(message.id);
    return true;
  });
}

export function activeRun(state, now = Date.now()) {
  return Boolean(state?.running && now < state.endsAt);
}
