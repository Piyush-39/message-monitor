import {monitorTenant} from './core.js';

const status = document.querySelector('#status');
const token = document.querySelector('#token');
const start = document.querySelector('#start');
const test = document.querySelector('#test');
const list = document.querySelector('#runs');
let busy = false;
start.disabled = true;
const [source] = await chrome.tabs.query({active: true, currentWindow: true});
const tenant = monitorTenant(source?.url);

async function send(type, targetTenant) {
  const result = await chrome.runtime.sendMessage({type, token: token.value.trim(),
    ...(type === 'start' ? {sourceTabId: source?.id} : {}), ...(targetTenant ? {tenant: targetTenant} : {})});
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function render(notice = '') {
  const state = await send('status');
  const currentRunning = state.runs.some(run => run.tenant === tenant && run.running);
  start.disabled = busy || currentRunning;
  test.disabled = busy;
  status.textContent = notice || `${state.activeCount} tenant${state.activeCount === 1 ? '' : 's'} running.\n${tenant ? `${currentRunning ? 'Already watching' : 'Ready to start'}: ${new URL(tenant).hostname}` : 'Open a tenant’s Monitor Message Processing page to add it.'}`;
  list.replaceChildren();
  for (const run of state.runs) {
    const card = document.createElement('section');
    card.className = 'run';
    const heading = document.createElement('h2');
    heading.textContent = new URL(run.tenant).hostname;
    const detail = document.createElement('p');
    detail.textContent = `${run.status}\nEnds: ${new Date(run.endsAt).toLocaleTimeString()}\nFailed messages emailed: ${run.sent}`;
    if (run.lastCheck) detail.textContent += `\nLast check: ${new Date(run.lastCheck).toLocaleTimeString()}`;
    if (run.lastRefresh) detail.textContent += `\nLast table refresh: ${new Date(run.lastRefresh).toLocaleTimeString()}`;
    if (run.tableRefresh === false) detail.textContent += '\nTable refresh unavailable; email checks continue.';
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
  document.querySelectorAll('button').forEach(button => {button.disabled = true;});
  let notice = '';
  try {
    if (type === 'start') {
      if (!tenant) throw new Error('Open your IS Monitor Message Processing page in this Chrome profile first.');
      // Resolve the source before clicking; the permission request stays in the user gesture.
      if (!(await chrome.permissions.request({origins: [`${tenant}/*`]}))) throw new Error('Tenant access was declined. Click Start again and allow access to monitor this tenant.');
    }
    const result = await send(type, targetTenant);
    if (type === 'test') notice = result.status;
  } catch (error) {notice = error.message;}
  finally {
    busy = false;
    await render(notice);
  }
}
start.addEventListener('click', () => act('start'));
test.addEventListener('click', () => act('test'));
token.value = (await chrome.storage.local.get('relayToken')).relayToken || '';
await render();
