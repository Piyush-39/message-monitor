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

export async function readFailedMessages(since, expectedOrigin) {
  const origin = location.origin;
  if (origin !== expectedOrigin) {
    throw new Error('SAP tab has left the tenant. Sign in again.');
  }
  const url = new URL('/odata/api/v1/MessageProcessingLogs', origin);
  url.searchParams.set('$format', 'json');
  url.searchParams.set('$orderby', 'LogEnd desc');
  url.searchParams.set('$top', '50');
  url.searchParams.set('$filter', `Status eq 'FAILED' and LogEnd ge datetime'${new Date(since).toISOString().slice(0, 19)}'`);
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
      if (item.Status !== 'FAILED') continue;
      if (typeof item.MessageGuid !== 'string' || !item.MessageGuid) throw new Error('Failed message has no message ID.');
      const date = /\/Date\((\d+)(?:[+-]\d+)?\)\//.exec(item.LogEnd || '');
      messages.push({
        id: item.MessageGuid,
        flow: String(item.IntegrationFlowName || item.IntegrationArtifact?.Name || 'Unknown flow').slice(0, 300),
        time: date ? new Date(Number(date[1])).toISOString() : '',
        url: `${origin}/shell/monitoring/Messages/${encodeURIComponent(JSON.stringify({identifier: item.MessageGuid}))}`
      });
    }
    next = body.d.__next || null;
  }
  return messages;
}
