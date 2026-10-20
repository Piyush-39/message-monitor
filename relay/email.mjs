const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const headerText = value => String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const STATUS_COLORS = {
  FAILED: ['#991b1b', '#fef2f2'], RETRY: ['#92400e', '#fffbeb'],
  PROCESSING: ['#1e40af', '#eff6ff'], ESCALATED: ['#6b21a8', '#faf5ff'],
  CANCELLED: ['#374151', '#f3f4f6'], DISCARDED: ['#475569', '#f1f5f9'],
  ABANDONED: ['#9a3412', '#fff7ed']
};

export function messageEmail(tenant, message) {
  const status = message.status ?? 'FAILED';
  const flow = message.flow || 'Unknown iFlow';
  const hostname = new URL(tenant).hostname;
  const time = message.time || 'Unavailable';
  const error = message.errorText || 'Error details unavailable. Open the message in IS for details.';
  const [color, background] = Object.hasOwn(STATUS_COLORS, status) ? STATUS_COLORS[status] : ['#374151', '#f3f4f6'];
  const metadata = [['Tenant', hostname], ['Time', time], ['Message ID', message.id]].map(([label, value]) =>
    `<tr><td style="padding:6px 12px 6px 0;width:90px;vertical-align:top;font-size:13px;color:#64748b;">${label}</td><td style="padding:6px 0;font-size:13px;color:#334155;overflow-wrap:anywhere;word-break:break-word;">${escapeHTML(value)}</td></tr>`
  ).join('');
  return {
    // Retain IS Watchdog for existing Gmail filters and a distinct ID for every alert.
    subject: `[${headerText(status)}] ${headerText(flow)} — IS Watchdog — ${hostname} — ${message.id}`,
    text: `Status: ${status}\niFlow: ${flow}\n\nTenant: ${hostname}\nMessage ID: ${message.id}\nTime: ${time}\n\nError: ${error}\n\nOpen: ${message.url}`,
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IS Watchdog message alert</title></head>
<body style="margin:0;padding:24px 16px;background:#f6f8fb;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:680px;margin:0 auto;table-layout:fixed;border-collapse:separate;">
<tr><td bgcolor="#ffffff" style="padding:28px;background:#ffffff;color:#0f172a;border:1px solid #dbe3ed;border-top:5px solid ${color};border-radius:12px;">
<p style="margin:0 0 20px;font-size:11px;line-height:16px;font-weight:bold;letter-spacing:1.5px;color:#64748b;">IS WATCHDOG · MESSAGE ALERT</p>
<p style="margin:0 0 22px;"><span style="display:inline-block;padding:8px 14px;border-radius:6px;background:${background};color:${color};font-size:16px;line-height:20px;font-weight:bold;">${escapeHTML(status)}</span></p>
<p style="margin:0 0 8px;font-size:11px;line-height:16px;font-weight:bold;letter-spacing:1px;color:#64748b;">IFLOW</p>
<h1 style="color:#0f172a;background-color:#ffffff;margin:0 0 24px;font-size:23px;line-height:32px;font-weight:bold;overflow-wrap:anywhere;word-break:break-word;">${escapeHTML(flow).replace(/_/g, '_<wbr>')}</h1>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;table-layout:fixed;border-collapse:collapse;border-top:1px solid #e2e8f0;">${metadata}</table>
<p style="margin:24px 0;"><a href="${escapeHTML(message.url)}" style="display:inline-block;padding:12px 18px;border-radius:6px;background:#0f172a;color:#ffffff;font-size:14px;line-height:20px;font-weight:bold;text-decoration:none;">Open message in SAP IS</a></p>
<h2 style="color:#0f172a;background-color:#ffffff;margin:0 0 10px;font-size:14px;line-height:20px;">Error details</h2>
<div style="padding:16px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;font-family:Consolas,Menlo,monospace;font-size:12px;line-height:20px;color:#334155;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;">${escapeHTML(error)}</div>
</td></tr></table></body></html>`
  };
}
