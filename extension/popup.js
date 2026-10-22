import {monitorTenant, monitorSelection, EMAIL_STATUSES, emailStatuses, statusLabel} from './core.js';

const $ = id => document.querySelector(`#${id}`);
const token = $('token');
const start = $('start');
const test = $('test');
const list = $('runs');
const statusFieldset = $('email-statuses');
const openDetails = new Set();
const statusInputs = EMAIL_STATUSES.map(value => {
  const label = element('label', 'status-option');
  const input = element('input');
  input.type = 'checkbox';
  input.value = value;
  input.checked = true;
  input.addEventListener('change', updateSelection);
  label.append(input, element('span', '', statusLabel(value)));
  $('status-options').append(label);
  return input;
});
let busy = false;
let currentRunning = false;
let initializedStatuses = false;
let editing = false;
let relayConnected = false;
let renderVersion = 0;
const [source] = await chrome.tabs.query({active: true, currentWindow: true});
const tenant = monitorTenant(source?.url);
let sourceScope;
try {sourceScope = monitorSelection(source?.url).scope;} catch { /* Start reports malformed page filters. */ }

function element(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function selectedStatuses() {
  return statusInputs.filter(input => input.checked).map(input => input.value);
}
function scopeSummary(scope) {
  const count = new Set(scope?.artifactIds || []).size;
  return count ? `${count} selected iFlow${count === 1 ? '' : 's'}`
    : scope?.packageId ? 'All iFlows in the selected package' : 'All iFlows';
}
function relativeTime(value) {
  if (!value) return 'Not checked yet';
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 5) return 'Just now';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
function updateSelection() {
  const selected = selectedStatuses();
  $('selected-count').textContent = `${selected.length} selected`;
  $('select-all').textContent = selected.length ? 'Clear all' : 'Select all';
  $('select-all').disabled = busy;
  $('status-hint').textContent = selected.length ? 'Select at least one status. Completed messages are excluded.' : 'Select at least one status to continue. Completed messages are excluded.';
  $('status-hint').className = `hint${selected.length ? '' : ' error'}`;
  $('status-summary-text').textContent = `${selected.length === EMAIL_STATUSES.length ? 'All 7' : selected.length} alert statuses selected`;
  $('status-editor').hidden = currentRunning && !editing;
  $('status-summary').hidden = !currentRunning || editing;
  start.hidden = currentRunning && !editing;
  start.disabled = busy || !tenant || !selected.length || (!currentRunning && !relayConnected);
  start.textContent = currentRunning ? 'Save alert statuses' : 'Start monitoring';
}
async function send(type, targetTenant) {
  const result = await chrome.runtime.sendMessage({type, token: token.value.trim(),
    ...(['start', 'updateStatuses'].includes(type) ? {emailStatuses: emailStatuses(selectedStatuses())} : {}),
    ...(type === 'start' ? {sourceTabId: source?.id} : {}), ...(targetTenant ? {tenant: targetTenant} : {})});
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function showNotice(notice = '', error = false) {
  for (const id of ['status', 'relay-notice']) {
    $(id).textContent = notice;
    $(id).hidden = !notice;
    $(id).className = error ? 'error' : '';
  }
  if (notice && !$('relay-settings').hidden) {
    const content = $('popup-content');
    const bounds = $('relay-notice').getBoundingClientRect?.();
    const viewport = content.getBoundingClientRect?.();
    // Scroll only the panel so the header and navigation stay in place.
    if (bounds && viewport && bounds.bottom > viewport.bottom) content.scrollTop += bounds.bottom - viewport.bottom + 8;
  }
}
function showSettings(show) {
  $('monitoring-view').hidden = show;
  $('relay-settings').hidden = !show;
  $('monitoring-tab').setAttribute('aria-pressed', String(!show));
  $('relay-tab').setAttribute('aria-pressed', String(show));
  $('popup-content').scrollTop = 0;
}
function tenantColor(origin) {
  let hash = 0;
  for (const char of origin) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 6;
}
function tenantCard(run) {
  const card = element('section', `run tenant-color-${tenantColor(run.tenant)}${run.tenant === tenant ? ' current-tenant' : ''}`);
  const hostname = new URL(run.tenant).hostname;
  card.setAttribute('aria-label', hostname);
  const top = element('div', 'run-top');
  const name = element('div', 'run-name');
  const identity = element('span', 'tenant-icon', hostname.slice(0, 2).toUpperCase());
  identity.setAttribute('aria-hidden', 'true');
  const title = element('div', 'tenant-title');
  title.append(element('h2', '', hostname.split('.')[0]));
  if (run.tenant === tenant) title.append(element('span', 'current-tag', 'Current tab'));
  name.append(identity, title);
  const health = element('span', `run-state${!run.running ? ' stopped' : run.problem ? ' problem' : ''}`);
  const dot = element('span', 'dot');
  dot.setAttribute('aria-hidden', 'true');
  health.append(dot, element('span', '', !run.running ? 'Stopped' : run.problem ? 'Needs attention' : 'Monitoring'));
  top.append(name, health);
  card.append(top, element('p', 'hostname', hostname));
  const metrics = element('div', 'metrics');
  const lastCheck = element('div', '', 'Last successful check');
  const time = element('strong', '', relativeTime(run.lastCheck));
  if (run.lastCheck) time.title = new Date(run.lastCheck).toLocaleString();
  lastCheck.append(time);
  const accepted = element('div', '', 'Accepted by relay');
  accepted.append(element('strong', '', `${run.sent || 0} messages`));
  metrics.append(lastCheck, accepted);
  card.append(metrics);
  if (run.running && run.problem) card.append(element('p', 'run-problem', run.problem));
  const actions = element('div', 'actions');
  if (run.running) {
    const open = element('button', 'secondary', 'Open watchdog tab ↗');
    open.disabled = busy;
    open.addEventListener('click', () => act('open', run.tenant));
    actions.append(open);
  }
  const detailsButton = element('button', 'link details-button', 'Details ▾');
  const details = element('div', 'run-details');
  details.id = `run-details-${encodeURIComponent(run.tenant)}`;
  details.textContent = [
    `Monitoring: ${scopeSummary(run.scope)}`,
    ...(run.scope?.packageId ? [`Package: ${run.scope.packageId}`] : []),
    `Alert statuses: ${emailStatuses(run.emailStatuses).map(statusLabel).join(', ')}`,
    `Duration: ${run.running ? 'No time limit — runs until you stop it' : run.status || 'Stopped'}`,
    ...(run.lastCheck ? [`Last successful check: ${new Date(run.lastCheck).toLocaleString()}`] : []),
    ...(run.lastRefresh ? [`Last table refresh: ${new Date(run.lastRefresh).toLocaleString()}`] : []),
    ...(run.running && run.phase ? [`Activity: ${run.phase}`] : []),
    ...(run.pendingAlerts ? [`Alerts awaiting handoff: ${run.pendingAlerts}. Retrying on the next check.`] : []),
    ...(run.tableRefresh === false ? ['Table refresh unavailable; alert checks continue.'] : [])
  ].join('\n');
  const toggleDetails = () => {
    details.hidden = !openDetails.has(run.tenant);
    detailsButton.textContent = details.hidden ? 'Details ▾' : 'Details ▴';
    detailsButton.setAttribute('aria-expanded', String(!details.hidden));
  };
  detailsButton.setAttribute('aria-controls', details.id);
  detailsButton.disabled = busy;
  detailsButton.addEventListener('click', () => {
    if (openDetails.has(run.tenant)) openDetails.delete(run.tenant); else openDetails.add(run.tenant);
    toggleDetails();
  });
  toggleDetails();
  actions.append(detailsButton);
  if (run.running) {
    const stop = element('button', 'secondary stop', 'Stop');
    stop.disabled = busy;
    stop.addEventListener('click', () => act('stop', run.tenant));
    actions.append(stop);
  }
  card.append(actions, details);
  return card;
}
async function render() {
  const version = ++renderVersion;
  const state = await send('status');
  if (version !== renderVersion) return;
  const currentRun = state.runs.find(run => run.tenant === tenant);
  const wasRunning = currentRunning;
  currentRunning = Boolean(currentRun?.running);
  if (currentRunning !== wasRunning) editing = false;
  if (!initializedStatuses) {
    const selected = emailStatuses(currentRun?.emailStatuses);
    statusInputs.forEach(input => {input.checked = selected.includes(input.value);});
    initializedStatuses = true;
  }
  relayConnected = Boolean(state.relay?.connected && token.value.trim());
  $('tenant-name').textContent = tenant ? new URL(tenant).hostname : 'No tenant detected';
  $('tenant-state').textContent = !tenant ? 'Action needed' : currentRunning ? currentRun.problem ? 'Needs attention' : 'Monitoring' : 'Ready';
  $('tenant-state').className = `pill${!tenant || currentRun?.running && currentRun.problem ? ' warning' : currentRunning ? ' live' : ''}`;
  $('tenant-help').textContent = !tenant ? 'Open a tenant’s Monitor Message Processing page to begin.'
    : currentRunning ? `Monitoring ${scopeSummary(currentRun.scope).replace(/^All/, 'all')}. Your saved filters stay in effect.`
    : sourceScope ? `${scopeSummary(sourceScope)}. Uses the filters applied on this page.` : 'Apply your artifact and package filters with Go before starting.';
  const hint = !tenant ? 'Open Monitor Message Processing to start this tenant.' : !token.value.trim() ? 'Add your notification relay key in Relay settings.' : !relayConnected && !currentRunning ? 'Connect the notification relay before starting.' : '';
  $('start-hint').textContent = hint;
  $('start-hint').hidden = !hint;
  statusFieldset.disabled = busy;
  test.disabled = busy || !token.value.trim();
  $('check-relay').disabled = busy || !token.value.trim();
  $('edit-statuses').disabled = busy;
  $('show-token').disabled = busy;
  $('monitoring-tab').disabled = busy;
  $('relay-tab').disabled = busy;
  token.disabled = busy;
  updateSelection();
  $('active-count').textContent = `${state.activeCount} active`;
  const problems = state.runs.filter(run => run.running && run.problem).length;
  $('attention').hidden = !problems;
  $('attention').textContent = `${problems} tenant${problems === 1 ? '' : 's'} need${problems === 1 ? 's' : ''} attention. Other tenants continue checking.`;
  $('empty').hidden = state.runs.length > 0;
  $('empty').textContent = tenant ? 'No tenants running yet. Start monitoring above.' : 'No tenants running. Open a monitor page to add one.';
  list.replaceChildren(...state.runs.map(tenantCard));
  $('relay-state').className = `relay-state${relayConnected ? '' : ' offline'}`;
  $('relay-label').textContent = relayConnected ? 'Notification relay connected' : token.value.trim() ? 'Notification relay unavailable' : 'Notification relay key required';
  const delivery = state.delivery;
  const deliveryText = !relayConnected ? state.relay?.error || 'Start the local relay with npm start to enable notifications.'
    : delivery?.provider === 'discord' ? [`Discord · ${delivery.pending} queued · ${delivery.delivered} delivered in 30 days`,
      ...(delivery.failed ? [`${delivery.failed} alerts need repair.`] : []),
      ...(delivery.fatalError ? [delivery.fatalError] : []),
      ...Object.values(delivery.errors || {})].join('\n') : '';
  $('delivery-status').textContent = deliveryText;
  $('delivery-status').hidden = !deliveryText;
}
async function act(type, targetTenant) {
  if (busy) return;
  busy = true;
  ++renderVersion;
  statusFieldset.disabled = true;
  token.disabled = true;
  document.querySelectorAll('button').forEach(button => {button.disabled = true;});
  let notice = '', failed = false;
  try {
    if (['start', 'updateStatuses'].includes(type)) emailStatuses(selectedStatuses());
    if (type === 'start') {
      if (!tenant) throw new Error('Open your IS Monitor Message Processing page in this Chrome profile first.');
      if (!(await chrome.permissions.request({origins: [`${tenant}/*`]}))) throw new Error('Tenant access was declined. Click Start again and allow access to this tenant.');
    }
    const result = await send(type, targetTenant);
    if (type === 'updateStatuses') editing = false;
    if (type !== 'open') notice = result.status || '';
  } catch (error) {notice = error.message; failed = true;}
  finally {
    busy = false;
    try {await render();} catch (error) {notice = error.message; failed = true;}
    showNotice(notice, failed);
  }
}
start.addEventListener('click', () => act(currentRunning ? 'updateStatuses' : 'start', currentRunning ? tenant : undefined));
test.addEventListener('click', () => act('test'));
$('check-relay').addEventListener('click', () => act('connect'));
$('monitoring-tab').addEventListener('click', () => showSettings(false));
$('relay-tab').addEventListener('click', () => showSettings(true));
$('select-all').addEventListener('click', () => {
  const select = !selectedStatuses().length;
  statusInputs.forEach(input => {input.checked = select;});
  updateSelection();
});
$('edit-statuses').addEventListener('click', () => {editing = true; updateSelection();});
$('show-token').addEventListener('click', () => {
  const show = token.type === 'password';
  token.type = show ? 'text' : 'password';
  $('show-token').textContent = show ? 'Hide key' : 'Show key';
  $('show-token').setAttribute('aria-label', `${show ? 'Hide' : 'Show'} relay key`);
  $('show-token').setAttribute('aria-pressed', String(show));
});
token.addEventListener('input', () => {
  relayConnected = false;
  $('relay-state').className = 'relay-state offline';
  $('relay-label').textContent = token.value.trim() ? 'Relay key changed — click Connect' : 'Notification relay key required';
  updateSelection();
  test.disabled = !token.value.trim();
  $('check-relay').disabled = !token.value.trim();
});
token.addEventListener('change', () => render().catch(error => showNotice(error.message, true)));
token.value = (await chrome.storage.local.get('relayToken')).relayToken || '';
showSettings(!token.value.trim());
try {await render();} catch (error) {showNotice(error.message, true);}
let refreshTimer;
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== 'local' || !changes.state || busy) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!busy) render().catch(error => showNotice(error.message, true));
  }, 250);
});
