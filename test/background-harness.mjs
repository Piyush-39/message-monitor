import {runInNewContext} from 'node:vm';
import {TENANT, TRIAL_TENANT} from './fixtures.mjs';
import {POLL_ALARM} from '../extension/core.js';

let generation = 0;
export const token = 'a'.repeat(64);
export const message = id => ({MessageGuid: id, Status: 'FAILED', IntegrationFlowName: 'flow', LogEnd: '/Date(1791610000000)/'});
export async function backgroundHarness({saved, relayFetch} = {}) {
  let clock = Date.now();
  const originalNow = Date.now;
  Date.now = () => clock;
  const store = saved ? {state: structuredClone(saved)} : {};
  const tabs = new Map([[1, {id: 1, url: `${TENANT}/shell/monitoring/Messages/`}], [2, {id: 2, url: `${TRIAL_TENANT}/shell/monitoring/Messages/` }]]);
  const sap = new Map();
  const broken = new Set();
  const denied = new Set();
  const alarms = new Map();
  const delivered = [];
  const monitoring = [];
  const notices = [];
  const tableClicks = [];
  const reads = [];
  let refreshAvailable = true;
  let emailBroken = false;
  let monitorBroken = false;
  let keepAwake = false;
  let onMessage, onAlarm;
  const chrome = {
    storage: {local: {
      async get(key) {return {[key]: structuredClone(store[key])};},
      async set(values) {Object.assign(store, structuredClone(values));}, async setAccessLevel() {}
    }},
    tabs: {
      async query() {return [tabs.get(1)];},
      async get(id) {if (!tabs.has(id)) throw new Error('No tab'); return tabs.get(id);},
      async update(id, options) {const tab = await this.get(id); Object.assign(tab, options); return tab;},
      async create(options) {const id = Math.max(...tabs.keys()) + 1; const tab = {id, ...options}; tabs.set(id, tab); return tab;}
    },
    permissions: {async contains({origins}) {return !denied.has(origins[0].slice(0, -2));}},
    scripting: {async executeScript({func, args, target}) {
      const location = new URL(tabs.get(target.tabId).url);
      const tenant = location.origin;
      // Separate page globals reproduce MAIN-world scripts running in different tabs concurrently.
      const context = {args, URL, Date, AbortSignal, location,
        fetch: async (url, options) => {
          reads.push({tenant, url: String(url), options});
          if (broken.has(tenant)) return new Response('Login', {headers: {'content-type': 'text/html'}});
          const records = sap.get(tenant);
          const value = typeof records === 'function' ? await records(url, options) : records || [];
          return value instanceof Response ? value : Response.json({d: {results: value}});
        },
        document: {querySelector() {return refreshAvailable ? {querySelectorAll() {return [{id: 'refresh',
          querySelector() {return {getAttribute() {return '\ue010';}};}, getAttribute() {return null;}, getClientRects() {return [{}];}
        }];}} : null;}},
        sap: {ui: {getCore() {return {byId() {return {
          getMetadata() {return {getName() {return 'sap.m.Button';}};}, getIcon() {return 'sap-icon://refresh';},
          getEnabled() {return true;}, hasListeners() {return true;}, firePress() {tableClicks.push(tenant);}
        };}};}}}
      };
      try {
        return [{frameId: 0, result: structuredClone(await runInNewContext(`(${func.toString()})(...args)`, context))}];
      } catch {
        // Chrome resolves with no result for a page-script exception, rather than
        // rejecting executeScript with that exception as the old harness did.
        return [{frameId: 0}];
      }
    }},
    alarms: {
      async create(name, options) {alarms.set(name, options);}, async get(name) {return alarms.get(name);},
      async clear(name) {return alarms.delete(name);}, onAlarm: {addListener(listener) {onAlarm = listener;}}
    },
    action: {async setBadgeText() {}, async setBadgeBackgroundColor() {}},
    power: {requestKeepAwake() {keepAwake = true;}, releaseKeepAwake() {keepAwake = false;}},
    notifications: {async create(id, notice) {notices.push({id, ...notice});}},
    runtime: {id: 'test-extension', onMessage: {addListener(listener) {onMessage = listener;}}}
  };
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  globalThis.chrome = chrome;
  globalThis.fetch = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    if (new URL(url).pathname === '/monitor') {
      if (monitorBroken) return Response.json({error: 'Relay unavailable'}, {status: 502});
      monitoring.push(body);
    } else if (body) {
      if (emailBroken) return Response.json({error: 'Email unavailable'}, {status: 502});
      delivered.push(body);
    }
    return relayFetch ? relayFetch(url, options) : Response.json({ok: true});
  };
  function request(type, tenant, extra = {}) {
    return new Promise(resolve => onMessage({type, token, ...(tenant ? {tenant} : {}), ...extra}, {id: chrome.runtime.id}, resolve));
  }
  async function reload() {
    await import(`../extension/background.js?test=${++generation}`);
    await request('status');
  }
  await reload();
  return {
    store, tabs, sap, broken, denied, alarms, delivered, monitoring, notices, tableClicks, reads, request, reload,
    set time(value) {clock = value;}, get time() {return clock;}, get awake() {return keepAwake;},
    set emailBroken(value) {emailBroken = value;}, set monitorBroken(value) {monitorBroken = value;},
    set refreshAvailable(value) {refreshAvailable = value;},
    async start(tenant = TENANT) {
      let source = [...tabs.values()].find(tab => new URL(tab.url).origin === tenant);
      if (!source) {source = {id: Math.max(...tabs.keys()) + 1, url: `${tenant}/shell/monitoring/Messages/`}; tabs.set(source.id, source);}
      return request('start', null, {sourceTabId: source.id});
    },
    async poll(name = POLL_ALARM) {onAlarm({name}); return request('status');},
    close() {Date.now = originalNow; globalThis.chrome = originalChrome; globalThis.fetch = originalFetch;}
  };
}
