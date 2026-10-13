export function composeReport(report) {
  const totals = report.flows.reduce((sum, flow) => ({completed: sum.completed + flow.completed, retry: sum.retry + flow.retry, failed: sum.failed + flow.failed}),
    {completed: 0, retry: 0, failed: 0});
  const window = `${new Date(report.from).toISOString()} (inclusive) to ${new Date(report.to).toISOString()} (exclusive)`;
  const selection = report.scope?.artifactIds?.length
    ? `${report.scope.artifactIds.length} selected iFlows, including those with no logs in this window.`
    : 'All iFlows with message processing logs starting in this UTC window.';
  const scope = `${selection}${report.scope?.packageId ? ` Restricted to package: ${report.scope.packageId}.` : ''} Counts use current MPL status; Retry counts messages, not individual retry attempts. Other statuses are excluded from the three counts.`;
  const singleLine = value => value.replace(/[\r\n\t]/g, ' ');
  const text = [
    `Tenant: ${report.tenant}`, `Last 24 hours: ${window}`, scope,
    `Totals — Completed: ${totals.completed}, Retry: ${totals.retry}, Failed: ${totals.failed}`,
    report.flows.length ? report.flows.map(flow => `${singleLine(flow.name)} [${singleLine(flow.id)}]\nCompleted: ${flow.completed} | Retry: ${flow.retry} | Failed: ${flow.failed}`).join('\n\n') : 'No message processing logs found in this window.'
  ].join('\n\n');
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const row = flow => `<tr><td>${escape(flow.name)}</td><td>${escape(flow.id)}</td><td>${flow.completed}</td><td>${flow.retry}</td><td>${flow.failed}</td></tr>`;
  const html = `<h1>IS message report — last 24 hours</h1><p>Tenant: ${escape(report.tenant)}</p><p>${escape(window)}</p><p>${escape(scope)}</p>` +
    (report.flows.length ? `<table border="1" cellpadding="6" cellspacing="0"><thead><tr><th>iFlow</th><th>Technical ID</th><th>Completed</th><th>Retry</th><th>Failed</th></tr></thead><tbody>${report.flows.map(row).join('')}</tbody><tfoot>${row({name: 'Totals', id: '', ...totals})}</tfoot></table>` : '<p>No message processing logs found in this window.</p>');
  // Quote CSV cells and neutralize spreadsheet formulas from tenant-controlled names/IDs.
  const csvCell = value => `"${(/^[\s]*[=+\-@]/.test(value) ? "'" : '') + singleLine(value).replace(/"/g, '""')}"`;
  const csv = ['Tenant,Window start (UTC inclusive),Window end (UTC exclusive),iFlow,Technical ID,Completed,Retry,Failed',
    ...report.flows.map(flow => [report.tenant, new Date(report.from).toISOString(), new Date(report.to).toISOString(), flow.name, flow.id].map(csvCell).concat([flow.completed, flow.retry, flow.failed]).join(','))
  ].join('\r\n');
  return {subject: `IS Watchdog: 24-hour iFlow report — ${new URL(report.tenant).hostname}`, text, html,
    attachments: [{filename: 'iflow-24-hour-report.csv', content: csv, contentType: 'text/csv; charset=utf-8'}]};
}
