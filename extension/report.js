// Serialized into the tenant tab: keep this function self-contained and secret-free.
export async function readMessageReport(from, to, expectedOrigin, scope = {}) {
  // Chrome does not return an injected function's thrown error in InjectionResult.
  // Catch inside the page and return plain JSON so the popup can show the reason.
  try {
    return {ok: true, flows: await read()};
  } catch (error) {
    const message = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? 'SAP report request timed out. Try again; no partial report was emailed.'
      : String(error?.message || 'SAP report request failed.').replace(/[\r\n\t]/g, ' ').slice(0, 400);
    return {ok: false, error: message};
  }

  async function read() {
    if (location.origin !== expectedOrigin || !/^\/shell\/monitoring\/Messages(?:\/|$)/.test(location.pathname)) {
      throw new Error('Open your IS Monitor Message Processing page and sign in again.');
    }
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to - from !== 86400000) {
      throw new Error('Invalid 24-hour report window.');
    }
    const artifactIds = scope.artifactIds ?? [];
    if (!Array.isArray(artifactIds) || artifactIds.some(id => typeof id !== 'string' || !id || id.length > 512) ||
        (scope.packageId != null && (typeof scope.packageId !== 'string' || !scope.packageId || scope.packageId.length > 512))) {
      throw new Error('Invalid report artifact selection. Apply the filters with Go and try again.');
    }
    const selected = new Set(artifactIds);
    if (selected.size > 1000) throw new Error('Too many iFlows for one report; no partial report was emailed.');
    const url = new URL('/odata/api/v1/MessageProcessingLogs', expectedOrigin);
    url.searchParams.set('$format', 'json');
    // Use the monitor's browser-session request shape. Fetch the full record so
    // technical artifact metadata is not omitted by the proxy's projection.
    url.searchParams.set('$orderby', 'LogStart desc');
    url.searchParams.set('$top', '50');
    // Preserve artifact/package selection, but count every status in the fixed 24-hour window.
    // LogStart includes Retry messages whose LogEnd may be absent.
    const date = value => new Date(value).toISOString().slice(0, 19);
    const literal = value => `'${value.replace(/'/g, "''")}'`;
    const filters = [`LogStart ge datetime'${date(from)}' and LogStart lt datetime'${date(to)}'`];
    if (selected.size) filters.push(`(${[...selected].map(id => `IntegrationArtifact/Id eq ${literal(id)}`).join(' or ')})`);
    if (scope.packageId) filters.push(`IntegrationArtifact/PackageId eq ${literal(scope.packageId)}`);
    url.searchParams.set('$filter', filters.join(' and '));
    // Explicitly selected flows remain in the report even when they have no logs.
    const flows = new Map([...selected].map(id => [id, {id, name: id.replace(/[\r\n\t]/g, ' ').slice(0, 300), completed: 0, retry: 0, failed: 0}]));
    const fields = new Map([['COMPLETED', 'completed'], ['RETRY', 'retry'], ['FAILED', 'failed']]);
    const seen = new Set();
    const visited = new Set();
    const deadline = Date.now() + 60000;
    let offset = 0;
    let chunkStart = 0;
    let fresh = 0;
    let next = url.href;
    while (next) {
      const page = new URL(next, expectedOrigin);
      if (page.origin !== expectedOrigin || page.username || page.password ||
          !/^\/(?:odata\/)?api\/v1\/MessageProcessingLogs$/.test(page.pathname)) throw new Error('Unexpected SAP report pagination URL.');
      page.pathname = '/odata/api/v1/MessageProcessingLogs';
      if (visited.has(page.href) || visited.size >= 200 || Date.now() >= deadline) {
        throw new Error('The report exceeded its read budget; no partial report was emailed.');
      }
      visited.add(page.href);
      const response = await fetch(page.href, {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - Date.now())))
      });
      if (response.status === 401 || response.status === 403) throw new Error('SAP session expired or access denied. Sign in again.');
      if (!response.ok) {
        const detail = (response.headers.get('content-type') || '').includes('json') ? await response.json().catch(() => null) : null;
        const reason = detail?.error?.message?.value ?? detail?.error?.message;
        throw new Error(`SAP report returned HTTP ${response.status}.${typeof reason === 'string' ? ` ${reason.slice(0, 250)}` : ''}`);
      }
      if (!(response.headers.get('content-type') || '').includes('json')) throw new Error('SAP returned a login page instead of report data. Sign in again.');
      const body = await response.json();
      if (Date.now() >= deadline) throw new Error('The report exceeded its read budget; no partial report was emailed.');
      if (!Array.isArray(body.d?.results) || (body.d.__next != null && typeof body.d.__next !== 'string')) throw new Error('Unexpected SAP report response.');
      for (const item of body.d.results) {
        const match = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/.exec(item.LogStart || '');
        const time = match ? Number(match[1]) : typeof item.LogStart === 'string' &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(item.LogStart) ? Date.parse(item.LogStart) : NaN;
        if (!Number.isFinite(time)) throw new Error('SAP returned a message without a valid processing start time.');
        const id = item.IntegrationArtifact?.Id;
        if (typeof id !== 'string' || !id || id.length > 512 || typeof item.MessageGuid !== 'string' || !item.MessageGuid ||
            typeof item.Status !== 'string' || !item.Status) throw new Error('SAP returned a message without its iFlow ID, message ID or status.');
        if (seen.has(item.MessageGuid)) continue;
        seen.add(item.MessageGuid);
        fresh++;
        if (time < from || time >= to) continue;
        if (scope.packageId && typeof item.IntegrationArtifact.PackageId !== 'string') throw new Error('SAP returned a message without its package ID for a filtered report.');
        if (selected.size && !selected.has(id)) continue;
        if (scope.packageId && item.IntegrationArtifact.PackageId !== scope.packageId) continue;
        if (!flows.has(id)) {
          if (flows.size >= 1000) throw new Error('Too many iFlows for one report; no partial report was emailed.');
          flows.set(id, {id, name: id.slice(0, 300), completed: 0, retry: 0, failed: 0});
        }
        flows.get(id).name = String(item.IntegrationFlowName || item.IntegrationArtifact.Name || id).replace(/[\r\n\t]/g, ' ').slice(0, 300);
        const field = fields.get(item.Status);
        if (field) flows.get(id)[field]++;
      }
      offset += body.d.results.length;
      next = body.d.__next || null;
      // $top limits this request, so SAP may omit __next even when more logs exist.
      // SAP may split those 50 records across smaller server-driven pages.
      // Read the next offset once the entire requested chunk has been consumed.
      if (!next && body.d.results.length && offset - chunkStart >= 50) {
        if (!fresh) throw new Error('SAP report pagination made no progress; no partial report was emailed.');
        const following = new URL(url);
        following.searchParams.set('$skip', String(offset));
        next = following.href;
        chunkStart = offset;
        fresh = 0;
      }
    }
    return [...flows.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
