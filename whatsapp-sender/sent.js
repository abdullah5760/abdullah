'use strict';
// Thin client for the Sent REST API.
// ASSUMPTION (not verified against official docs, which were unreachable from this build
// environment): POST {base}/v3/messages with headers x-api-key / x-sender-id and a body of
// { to: [E.164], channel: ["whatsapp"], template: { name, parameters } }.
// If Sent rejects the request, this is the only file to adjust.

function createSentClient({ baseUrl, apiKey, senderId, dryRun, fetchImpl = fetch }) {
  return {
    async sendWhatsApp({ phone, templateName, parameters }) {
      if (dryRun) {
        console.log(`[DRY_RUN] would send "${templateName}" to ${phone}`, parameters);
        return { messageId: 'dry-run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) };
      }
      const res = await fetchImpl(`${baseUrl}/v3/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'x-sender-id': senderId },
        body: JSON.stringify({
          to: [phone],
          channel: ['whatsapp'],
          template: { name: templateName, parameters }
        })
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON body */ }
      if (!res.ok) throw new Error(`Sent ${res.status}: ${text.slice(0, 300)}`);
      // Response shape is unverified; keep the raw body for the log.
      const id = json && (json.id || json.messageId || (json.data && (json.data.id || json.data.messageId)));
      return { messageId: id || null, raw: json };
    }
  };
}

module.exports = { createSentClient };
