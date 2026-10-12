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
export const DURATION = 9 * 60 * 60 * 1000;
export const POLL_ALARM = 'is-watchdog-poll';
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
