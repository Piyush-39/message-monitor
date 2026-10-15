// Serialized by chrome.scripting into the SAP tab. Never pass relay/Gmail secrets here.
export function refreshMessageTable(expectedOrigin) {
  if (location.origin !== expectedOrigin || !/^\/shell\/monitoring\/Messages(?:\/|$)/.test(location.pathname)) return false;
  // SAP's message toolbar has a stable title ID. The reload icon also works with localized labels.
  const toolbar = document.querySelector('[role="toolbar"][aria-labelledby~="PanelMessagesTitle"]');
  if (!toolbar) return false;
  const candidates = [...toolbar.querySelectorAll('button')].filter(button => {
    const icon = button.querySelector('[data-sap-ui-icon-content]')?.getAttribute('data-sap-ui-icon-content');
    const label = button.getAttribute('aria-label') || button.title;
    return (icon === '\ue010' || /^(Reload content|Refresh)$/i.test(label || '')) &&
      !button.disabled && button.getAttribute('aria-disabled') !== 'true' && button.getClientRects().length > 0;
  });
  if (candidates.length !== 1) return false;
  // Native DOM .click() does not dispatch SAP UI5's press handler on this monitor.
  const control = globalThis.sap?.ui?.getCore?.().byId?.(candidates[0].id);
  if (control?.getMetadata?.().getName?.() !== 'sap.m.Button' || control.getIcon?.() !== 'sap-icon://refresh' ||
      !control.getEnabled?.() || !control.hasListeners?.('press') || typeof control.firePress !== 'function') return false;
  control.firePress();
  return true;
}

export async function readNonCompletedMessages(since, expectedOrigin, scope = {}, emailStatuses) {
  const origin = location.origin;
  if (origin !== expectedOrigin) {
    throw new Error('SAP tab has left the tenant. Sign in again.');
  }
  const url = new URL('/odata/api/v1/MessageProcessingLogs', origin);
  const artifactIds = scope.artifactIds ?? [];
  if (!Array.isArray(artifactIds) || artifactIds.some(id => typeof id !== 'string' || !id) ||
      (scope.packageId != null && typeof scope.packageId !== 'string')) throw new Error('Invalid artifact monitoring scope.');
  // OData string literals escape apostrophes by doubling them, not by URL encoding.
  const literal = value => `'${value.replace(/'/g, "''")}'`;
  if (emailStatuses !== undefined && (!Array.isArray(emailStatuses) || !emailStatuses.length ||
      emailStatuses.some(status => typeof status !== 'string' || !/^[A-Z][A-Z0-9_]{0,49}$/.test(status) || ['ALL', 'COMPLETED'].includes(status)))) throw new Error('Invalid email status selection.');
  const statusFilter = emailStatuses === undefined ? "Status ne 'COMPLETED'" : `(${emailStatuses.map(status => `Status eq ${literal(status)}`).join(' or ')})`;
  const timestamp = new Date(since).toISOString().slice(0, 19);
  // Processing/retrying messages may not have an end time yet. Keep LogEnd too
  // so a message started before the run but ending during it can still be found.
  const filters = [`${statusFilter} and (LogStart ge datetime'${timestamp}' or LogEnd ge datetime'${timestamp}')`];
  if (artifactIds.length) filters.push(`(${artifactIds.map(id => `IntegrationArtifact/Id eq ${literal(id)}`).join(' or ')})`);
  if (scope.packageId) filters.push(`IntegrationArtifact/PackageId eq ${literal(scope.packageId)}`);
  url.searchParams.set('$format', 'json');
  url.searchParams.set('$orderby', 'LogStart desc');
  url.searchParams.set('$top', '50');
  url.searchParams.set('$filter', filters.join(' and '));
  const messages = [];
  const visited = new Set();
  const deadline = Date.now() + 20000;
  let next = url.href;
  while (next) {
    const page = new URL(next, origin);
    // Some SAP responses link to /api/v1, outside the browser-session route.
    if (page.origin !== origin || !/^\/(?:odata\/)?api\/v1\/MessageProcessingLogs$/.test(page.pathname)) {
      throw new Error('Unexpected SAP pagination URL.');
    }
    page.pathname = '/odata/api/v1/MessageProcessingLogs';
    if (visited.has(page.href) || visited.size >= 200 || Date.now() >= deadline) throw new Error('SAP pagination did not finish within the check budget.');
    visited.add(page.href);
    const response = await fetch(page.href, {
      credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - Date.now())))
    });
    if (response.status === 401 || response.status === 403) throw new Error('SAP session expired or access denied. Sign in again.');
    if (!response.ok) throw new Error(`SAP monitoring returned HTTP ${response.status}.`);
    if (!(response.headers.get('content-type') || '').includes('json')) {
      throw new Error('SAP returned a login page instead of messages. Sign in again.');
    }
    const body = await response.json();
    if (!Array.isArray(body.d?.results)) throw new Error('Unexpected SAP monitoring response.');
    for (const item of body.d.results) {
      if (item.Status === 'COMPLETED') continue;
      if (typeof item.Status !== 'string' || !/^[A-Z][A-Z0-9_]{0,49}$/.test(item.Status) || item.Status === 'ALL') throw new Error('SAP returned a message without a valid status.');
      if (emailStatuses && !emailStatuses.includes(item.Status)) continue;
      // Check every result too: a malformed/mis-scoped pagination response must not email other iFlows.
      if (artifactIds.length && typeof item.IntegrationArtifact?.Id !== 'string') throw new Error('SAP returned a message without its artifact ID for filtered monitoring.');
      if (scope.packageId && typeof item.IntegrationArtifact?.PackageId !== 'string') throw new Error('SAP returned a message without its package ID for filtered monitoring.');
      if (artifactIds.length && !artifactIds.includes(item.IntegrationArtifact.Id)) continue;
      if (scope.packageId && item.IntegrationArtifact.PackageId !== scope.packageId) continue;
      if (typeof item.MessageGuid !== 'string' || !item.MessageGuid) throw new Error('Message has no message ID.');
      const date = /\/Date\((\d+)(?:[+-]\d+)?\)\//.exec(item.LogEnd || item.LogStart || '');
      messages.push({
        id: item.MessageGuid,
        status: item.Status,
        flow: String(item.IntegrationFlowName || item.IntegrationArtifact?.Name || 'Unknown flow').slice(0, 300),
        time: date ? new Date(Number(date[1])).toISOString() : '',
        url: `${origin}/shell/monitoring/Messages/${encodeURIComponent(JSON.stringify({identifier: item.MessageGuid}))}`
      });
    }
    next = body.d.__next || null;
  }
  return messages;
}

// Serialized independently into the SAP tab; only enrich an unseen email batch.
export async function readMessageErrors(messages, expectedOrigin) {
  if (location.origin !== expectedOrigin || !/^\/shell\/monitoring\/Messages(?:\/|$)/.test(location.pathname)) throw new Error('SAP tab has left the monitor page.');
  if (!Array.isArray(messages) || !messages.length || messages.length > 50 ||
      messages.some(message => typeof message?.id !== 'string' || !/^[\w-]{1,200}$/.test(message.id) || message.status === 'COMPLETED')) throw new Error('Invalid error detail batch.');
  const limit = 2000;
  const deadline = Date.now() + 15000;
  const unavailable = 'Error details unavailable. Open the message in IS for details.';
  const absent = 'No error information available.';
  const errors = Array(messages.length).fill(unavailable);
  let next = 0;
  async function worker() {
    while (next < messages.length) {
      const index = next++;
      const message = messages[index];
      // SAP documents that Discarded messages have no error information.
      if (message.status === 'DISCARDED') {errors[index] = absent; continue;}
      if (Date.now() >= deadline) continue;
      const url = new URL(`/odata/api/v1/MessageProcessingLogs('${message.id}')/ErrorInformation/$value`, expectedOrigin);
      try {
        const response = await fetch(url.href, {
          credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          headers: {Accept: 'text/plain, application/octet-stream'},
          signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now())))
        });
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok || /text\/html/i.test(contentType) || response.status === 204) {
          if (response.status === 404 || response.status === 204) errors[index] = absent;
          await response.body?.cancel();
          continue;
        }
        // Read only the start of potentially large exception streams.
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let text = '';
        if (reader) {
          try {
            while (text.length <= limit) {
              const {value, done} = await reader.read();
              if (done) {text += decoder.decode(); break;}
              text += decoder.decode(value, {stream: true});
            }
          } finally {await reader.cancel();}
        }
        if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text)) continue;
        text = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
        const marker = '\n[truncated]';
        errors[index] = text.length > limit ? text.slice(0, limit - marker.length) + marker : text || absent;
      } catch { /* Details are best-effort; a failed lookup must not suppress the alert. */ }
    }
  }
  await Promise.all(Array.from({length: Math.min(5, messages.length)}, () => worker()));
  return errors;
}
