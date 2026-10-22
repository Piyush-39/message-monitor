import {monitorTenant, EMAIL_STATUSES, emailStatuses, statusLabel} from './core.js';

const status = document.querySelector('#status');
const token = document.querySelector('#token');
const start = document.querySelector('#start');
const test = document.querySelector('#test');
const list = document.querySelector('#runs');
const deliveryStatus = document.querySelector('#delivery-status');
const statusFieldset = document.querySelector('#email-statuses');
const statusOptions = document.querySelector('#status-options');
const statusInputs = EMAIL_STATUSES.map(value => {
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.value = value;
  input.checked = true;
  const text = document.createElement('span');
  text.textContent = statusLabel(value);
  label.append(input, text);
  statusOptions.append(label);
  return input;
});
let busy = false;
let currentRunning = false;
let initializedStatuses = false;
start.disabled = true;
const [source] = await chrome.tabs.query({active: true, currentWindow: true});
const tenant = monitorTenant(source?.url);

async function send(type, targetTenant) {
  const result = await chrome.runtime.sendMessage({type, token: token.value.trim(),
    ...(['start', 'updateStatuses'].includes(type) ? {emailStatuses: emailStatuses(statusInputs.filter(input => input.checked).map(input => input.value))} : {}),
    ...(type === 'start' ? {sourceTabId: source?.id} : {}), ...(targetTenant ? {tenant: targetTenant} : {})});
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function render(notice = '') {
  const state = await send('status');
  const delivery = state.delivery;
  deliveryStatus.textContent = delivery?.provider === 'discord'
    ? `Discord: ${delivery.pending} queued. ${delivery.delivered} delivered in the last 30 days.${delivery.failed ? ` ${delivery.failed} alerts need repair.` : ''}${delivery.fatalError ? `\n${delivery.fatalError}` : ''}${Object.entries(delivery.errors || {}).map(([channel, error]) => `\n${channel}: ${error}`).join('')}`
    : delivery?.error || '';
  const currentRun = state.runs.find(run => run.tenant === tenant);
  currentRunning = Boolean(currentRun?.running);
  if (!initializedStatuses) {
    const selected = emailStatuses(currentRun?.emailStatuses);
    statusInputs.forEach(input => {input.checked = selected.includes(input.value);});
    initializedStatuses = true;
  }
  start.textContent = currentRunning ? 'Save statuses' : 'Start this tenant';
  start.disabled = busy || !tenant;
  statusFieldset.disabled = busy;
  test.disabled = busy;
  status.textContent = notice || `${state.activeCount} tenant${state.activeCount === 1 ? '' : 's'} running.\n${tenant ? `${currentRunning ? 'Already watching' : 'Ready to start'}: ${new URL(tenant).hostname}` : 'Open a tenant’s Monitor Message Processing page to add it.'}`;
  list.replaceChildren();
  for (const run of state.runs) {
    const card = document.createElement('section');
    card.className = 'run';
    const heading = document.createElement('h2');
    heading.textContent = new URL(run.tenant).hostname;
    const detail = document.createElement('p');
    detail.textContent = `${run.status}\nEnds: ${new Date(run.endsAt).toLocaleTimeString()}\nMessages accepted by relay: ${run.sent}\nAlert statuses: ${emailStatuses(run.emailStatuses).map(statusLabel).join(', ')}`;
    const count = new Set(run.scope?.artifactIds || []).size;
    detail.textContent += `\nMonitoring: ${count ? `${count} iFlow${count === 1 ? '' : 's'}` : run.scope?.packageId ? 'All iFlows in the selected package' : 'All iFlows'}`;
    if (run.scope?.packageId) detail.textContent += `\nPackage: ${run.scope.packageId}`;
    if (run.lastCheck) detail.textContent += `\nLast check: ${new Date(run.lastCheck).toLocaleTimeString()}`;
    if (run.running && run.phase) detail.textContent += `\nActivity: ${run.phase}`;
    if (run.pendingAlerts) detail.textContent += `\nAlerts awaiting handoff: ${run.pendingAlerts}. Retrying on the next check.`;
    if (run.lastRefresh) detail.textContent += `\nLast table refresh: ${new Date(run.lastRefresh).toLocaleTimeString()}`;
    if (run.tableRefresh === false) detail.textContent += '\nTable refresh unavailable; alert checks continue.';
    if (run.problem) detail.textContent += `\n${run.problem}`;
    card.append(heading, detail);
    if (run.running) {
      const actions = document.createElement('div');
      actions.className = 'actions';
      for (const [type, label] of [['open', 'Open watchdog tab'], ['stop', 'Stop']]) {
        const button = document.createElement('button');
        button.className = 'secondary';
        button.textContent = label;
        button.disabled = busy;
        button.addEventListener('click', () => act(type, run.tenant));
        actions.append(button);
      }
      card.append(actions);
    }
    list.append(card);
  }
}
async function act(type, targetTenant) {
  busy = true;
  statusFieldset.disabled = true;
  document.querySelectorAll('button').forEach(button => {button.disabled = true;});
  let notice = '';
  try {
    if (['start', 'updateStatuses'].includes(type)) emailStatuses(statusInputs.filter(input => input.checked).map(input => input.value));
    if (type === 'start') {
      if (!tenant) throw new Error('Open your IS Monitor Message Processing page in this Chrome profile first.');
      // Resolve the source before clicking; the permission request stays in the user gesture.
      if (!(await chrome.permissions.request({origins: [`${tenant}/*`]}))) throw new Error('Tenant access was declined. Click Start again and allow access to this tenant.');
    }
    const result = await send(type, targetTenant);
    if (['test', 'updateStatuses'].includes(type)) notice = result.status;
  } catch (error) {notice = error.message;}
  finally {
    busy = false;
    await render(notice);
  }
}
start.addEventListener('click', () => act(currentRunning ? 'updateStatuses' : 'start', currentRunning ? tenant : undefined));
test.addEventListener('click', () => act('test'));
token.value = (await chrome.storage.local.get('relayToken')).relayToken || '';
await render();
