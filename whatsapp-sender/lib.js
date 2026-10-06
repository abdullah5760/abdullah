'use strict';
const crypto = require('node:crypto');

// Normalize to E.164. defaultCc (e.g. "20") is used for numbers written with a leading 0.
function normalizePhone(raw, defaultCc) {
  let s = String(raw || '').trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+') && defaultCc && s.startsWith('0')) s = '+' + defaultCc + s.slice(1);
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

// Replace {name}, {phone} and custom fields in a value; unknown keys become ''.
function render(value, contact) {
  return String(value).replace(/\{(\w+)\}/g, (_, k) => {
    if (k === 'name') return contact.name || '';
    if (k === 'phone') return contact.phone;
    return (contact.fields && contact.fields[k]) || '';
  });
}

function buildParameters(mapping, contact) {
  const out = {};
  for (const [param, value] of Object.entries(mapping || {})) out[param] = render(value, contact);
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { normalizePhone, render, buildParameters, safeEqual };
