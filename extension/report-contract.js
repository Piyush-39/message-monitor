import {isTenantOrigin} from './core.js';

export function validateReport(value) {
  if (!value || !isTenantOrigin(value.tenant) || typeof value.nonce !== 'string' || !/^[\w-]{1,100}$/.test(value.nonce) ||
      !Number.isSafeInteger(value.from) || value.from < 0 || !Number.isSafeInteger(value.to) || value.to - value.from !== 86400000 ||
      !Number.isFinite(new Date(value.to).getTime()) ||
      !Array.isArray(value.flows) || value.flows.length > 1000) throw new Error('Invalid report');
  const ids = new Set();
  for (const flow of value.flows) {
    if (!flow || typeof flow.id !== 'string' || !flow.id || flow.id.length > 512 || ids.has(flow.id) ||
        typeof flow.name !== 'string' || flow.name.length > 300 ||
        ['completed', 'retry', 'failed'].some(field => !Number.isSafeInteger(flow[field]) || flow[field] < 0)) throw new Error('Invalid report row');
    ids.add(flow.id);
  }
  for (const field of ['completed', 'retry', 'failed']) {
    if (!Number.isSafeInteger(value.flows.reduce((sum, flow) => sum + flow[field], 0))) throw new Error('Invalid report total');
  }
  return value;
}
