'use strict';
// Client for the official WhatsApp Cloud API (Meta). Request shape follows Meta's "Get Started" doc:
// POST https://graph.facebook.com/v23.0/{PHONE_NUMBER_ID}/messages, Bearer token,
// body { messaging_product: "whatsapp", to, type: "template", template: { name, language: { code }, components } }.
// Template variables are sent POSITIONALLY in the order they were listed on the template in this app
// (matches templates whose body uses {{1}}, {{2}}, ...). Named-variable templates are not supported yet.

function createMetaClient({ token, phoneNumberId, apiVersion = 'v23.0', dryRun, fetchImpl = fetch }) {
  return {
    async sendWhatsApp({ phone, templateName, templateLang = 'ar', paramOrder = [], parameters = {} }) {
      if (dryRun) {
        console.log(`[DRY_RUN] would send "${templateName}" (${templateLang}) to ${phone}`, parameters);
        return { messageId: 'dry-run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) };
      }
      const template = { name: templateName, language: { code: templateLang } };
      if (paramOrder.length) {
        template.components = [{ type: 'body', parameters: paramOrder.map((k) => ({ type: 'text', text: String(parameters[k] ?? '') })) }];
      }
      const res = await fetchImpl(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: phone.replace(/^\+/, ''), type: 'template', template })
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON */ }
      if (!res.ok) throw new Error(`Meta ${res.status}: ${(json && json.error && json.error.message) || text.slice(0, 300)}`);
      const id = json && json.messages && json.messages[0] && json.messages[0].id;
      return { messageId: id || null, raw: json };
    }
  };
}

module.exports = { createMetaClient };
