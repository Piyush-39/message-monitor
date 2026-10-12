const status = document.querySelector('#status');
const token = document.querySelector('#token');
const buttons = [...document.querySelectorAll('button')];
// Resolve before the click so permissions.request stays directly in the user gesture.
document.querySelector('#start').disabled = true;
const [source] = await chrome.tabs.query({active: true, currentWindow: true});
const tenant = monitorTenant(source?.url);
async function send(type) {
  const result = await chrome.runtime.sendMessage({type, token: token.value.trim(), ...(type === 'start' ? {sourceTabId: source?.id} : {})});
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
async function render() {
  const state = await send('status');
  document.querySelector('#start').disabled = Boolean(state.running);
  document.querySelector('#stop').disabled = !state.running;
  document.querySelector('#open').disabled = !state.running;
  status.textContent = state.status || 'Ready';
  if (state.running) {
    if (state.tenant) status.textContent += `\nTenant: ${new URL(state.tenant).hostname}`;
    status.textContent += `\nEnds: ${new Date(state.endsAt).toLocaleTimeString()}\nFailed messages emailed: ${state.sent}`;
    if (state.lastCheck) status.textContent += `\nLast check: ${new Date(state.lastCheck).toLocaleTimeString()}`;
    if (state.lastRefresh) status.textContent += `\nLast table refresh: ${new Date(state.lastRefresh).toLocaleTimeString()}`;
    if (state.tableRefresh === false) status.textContent += '\nTable refresh unavailable; email checks continue.';
  }
  if (state.problem) status.textContent += `\n${state.problem}`;
}
for (const button of buttons) button.addEventListener('click', async () => {
  buttons.forEach(item => item.disabled = true);
  try {
    if (button.id === 'start') {
      if (!tenant) throw new Error('Open your IS Monitor Message Processing page in this Chrome profile first.');
      if (!(await chrome.permissions.request({origins: [`${tenant}/*`]}))) throw new Error('Tenant access was declined. Click Start again and allow access to monitor this tenant.');
    }
    const result = await send(button.id);
    if (button.id === 'start') await chrome.storage.local.set({ relayToken: token.value.trim() });
    await render();
    if (button.id === 'test') status.textContent = result.status;
  } catch (error) { status.textContent = error.message; }
  finally {
    const state = await send('status');
    document.querySelector('#start').disabled = Boolean(state.running);
    document.querySelector('#stop').disabled = !state.running;
    document.querySelector('#open').disabled = !state.running;
    document.querySelector('#test').disabled = false;
  }
});
const saved = await chrome.storage.local.get('relayToken');
token.value = saved.relayToken || '';
await render();
import { monitorTenant } from './core.js';
