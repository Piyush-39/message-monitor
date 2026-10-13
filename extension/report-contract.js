import {isTenantOrigin} from './core.js';

export function validateReport(value) {
  if (!value || !isTenantOrigin(value.tenant) || typeof value.nonce !== 'string' || !/^[\w-]{1,100}$/.test(value.nonce) ||
      !Number.isSafeInteger(value.from) || value.from < 0 || !Number.isSafeInteger(value.to) || value.to - value.from !== 86400000 ||
      !Number.isFinite(new Date(value.to).getTime()) ||
      !Array.isArray(value.flows) || value.flows.length > 1000) throw new Error('Invalid report');
  const ids = new Set();
  if (value.scope !== undefined) {
    const scope = value.scope;
    if (!scope || !Array.isArray(scope.artifactIds) || scope.artifactIds.length > 1000 ||
        scope.artifactIds.some(id => typeof id !== 'string' || !id || id.length > 512) ||
        new Set(scope.artifactIds).size !== scope.artifactIds.length ||
        (scope.packageId != null && (typeof scope.packageId !== 'string' || !scope.packageId || scope.packageId.length > 512))) throw new Error('Invalid report scope');
  }
  for (const flow of value.flows) {
    if (!flow || typeof flow.id !== 'string' || !flow.id || flow.id.length > 512 || ids.has(flow.id) ||
        typeof flow.name !== 'string' || flow.name.length > 300 ||
        ['completed', 'retry', 'failed'].some(field => !Number.isSafeInteger(flow[field]) || flow[field] < 0)) throw new Error('Invalid report row');
    ids.add(flow.id);
  }
  if (value.scope?.artifactIds.length && (ids.size !== value.scope.artifactIds.length || value.scope.artifactIds.some(id => !ids.has(id)))) {
    throw new Error('Report must include every selected iFlow');
  }
  for (const field of ['completed', 'retry', 'failed']) {
    if (!Number.isSafeInteger(value.flows.reduce((sum, flow) => sum + flow[field], 0))) throw new Error('Invalid report total');
  }
  return value;
}
