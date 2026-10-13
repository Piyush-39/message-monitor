// Serialized into the tenant tab: keep this function self-contained and secret-free.
export async function readMessageReport(from, to, expectedOrigin) {
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
    const url = new URL('/odata/api/v1/MessageProcessingLogs', expectedOrigin);
    url.searchParams.set('$format', 'json');
    // Use the monitor's browser-session request shape. Fetch the full record so
    // technical artifact metadata is not omitted by the proxy's projection.
    url.searchParams.set('$orderby', 'LogStart desc');
    url.searchParams.set('$top', '50');
    // LogStart includes Retry messages whose LogEnd may be absent. Ignore the page's filters.
    const date = value => new Date(value).toISOString().slice(0, 19);
    url.searchParams.set('$filter', `LogStart ge datetime'${date(from)}' and LogStart lt datetime'${date(to)}'`);
    const flows = new Map();
    const fields = new Map([['COMPLETED', 'completed'], ['RETRY', 'retry'], ['FAILED', 'failed']]);
    const seen = new Set();
    const visited = new Set();
    const deadline = Date.now() + 60000;
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
        if (time < from || time >= to) continue;
        const id = item.IntegrationArtifact?.Id;
        if (typeof id !== 'string' || !id || id.length > 512 || typeof item.MessageGuid !== 'string' || !item.MessageGuid ||
            typeof item.Status !== 'string' || !item.Status) throw new Error('SAP returned a message without its iFlow ID, message ID or status.');
        if (seen.has(item.MessageGuid)) continue;
        seen.add(item.MessageGuid);
        if (!flows.has(id)) {
          if (flows.size >= 1000) throw new Error('Too many iFlows for one report; no partial report was emailed.');
          const name = String(item.IntegrationFlowName || item.IntegrationArtifact.Name || id).replace(/[\r\n\t]/g, ' ').slice(0, 300);
          flows.set(id, {id, name, completed: 0, retry: 0, failed: 0});
        }
        const field = fields.get(item.Status);
        if (field) flows.get(id)[field]++;
      }
      next = body.d.__next || null;
    }
    return [...flows.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
