'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizePhone, buildParameters } = require('../lib');
const { createApp } = require('../server');

test('normalizePhone', () => {
  assert.strictEqual(normalizePhone('01012345678', '20'), '+201012345678');
  assert.strictEqual(normalizePhone('+20 101-234-5678'), '+201012345678');
  assert.strictEqual(normalizePhone('0020 101 234 5678'), '+201012345678');
  assert.strictEqual(normalizePhone('12345'), null);
  assert.strictEqual(normalizePhone('01012345678'), null); // no country code known
});

test('buildParameters', () => {
  const c = { name: 'Ali', phone: '+201', fields: { city: 'Cairo' } };
  assert.deepStrictEqual(buildParameters({ a: 'Hi {name} from {city}{x}', b: '{phone}' }, c), { a: 'Hi Ali from Cairo', b: '+201' });
});

async function boot(sentImpl) {
  const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-')), 'd.json');
  const calls = [];
  const sent = { sendWhatsApp: async (x) => { calls.push(x); return sentImpl ? sentImpl(x) : { messageId: 'm' + calls.length }; } };
  const app = createApp({ password: 'pw', dataFile, delayMs: 0, dryRun: true, sent });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const H = { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('u:pw').toString('base64') };
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: H, body: b && JSON.stringify(b) }); return { s: r.status, j: await r.json() }; };
  return { app, calls, call, base };
}
const until = async (f) => { for (let i = 0; i < 100; i++) { if (f()) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };

test('requires auth', async () => {
  const { app, base } = await boot();
  assert.strictEqual((await fetch(base + '/api/state')).status, 401);
  app.server.close();
});

test('only opted-in contacts are messaged; failures recorded; opt-out wins', async () => {
  const { app, calls, call } = await boot((x) => { if (x.phone === '+201000000002') throw new Error('boom'); return { messageId: 'ok' }; });
  const rows = [{ phone: '01000000001', name: 'A' }, { phone: '01000000002', name: 'B' }, { phone: 'bad' }];
  assert.strictEqual((await call('POST', '/api/contacts', { contacts: rows, defaultCc: '20', consentConfirmed: false })).j.added, 2);
  assert.strictEqual((await call('POST', '/api/templates', { name: 'promo', params: ['name'] })).s, 200);
  // no consent -> refused
  assert.strictEqual((await call('POST', '/api/campaigns', { templateName: 'promo', mapping: { name: '{name}' } })).s, 400);
  await call('POST', '/api/contacts', { contacts: [{ phone: '01000000003', name: 'C' }, { phone: '01000000002' }], defaultCc: '20', consentConfirmed: true, consentSource: 'form' });
  // 01000000002 is a duplicate (stays without consent); only C is opted in
  const r = await call('POST', '/api/campaigns', { name: 't', templateName: 'promo', mapping: { name: '{name}' } });
  assert.strictEqual(r.s, 200); assert.strictEqual(r.j.recipients, 1);
  await until(() => app.db().campaigns[0].status === 'done');
  assert.deepStrictEqual(calls.map((c) => c.phone), ['+201000000003']);
  assert.deepStrictEqual(calls[0].parameters, { name: 'C' });
  assert.strictEqual(app.db().campaigns[0].results[0].status, 'accepted');
  app.server.close();
});

test('missing template params rejected', async () => {
  const { app, call } = await boot();
  await call('POST', '/api/templates', { name: 'p', params: ['name', 'city'] });
  await call('POST', '/api/contacts', { contacts: [{ phone: '+201000000009' }], consentConfirmed: true });
  assert.strictEqual((await call('POST', '/api/campaigns', { templateName: 'p', mapping: { name: 'x' } })).s, 400);
  app.server.close();
});

test('APP_USER enforced when set (including Arabic names)', async () => {
  const app = createApp({ password: 'pw', user: 'رعد', dataFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-')), 'd.json'), sent: {} });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const hit = async (u, p) => (await fetch(base + '/api/state', { headers: { authorization: 'Basic ' + Buffer.from(u + ':' + p, 'utf8').toString('base64') } })).status;
  assert.strictEqual(await hit('رعد', 'pw'), 200);
  assert.strictEqual(await hit('other', 'pw'), 401);
  assert.strictEqual(await hit('رعد', 'bad'), 401);
  app.server.close();
});

test('one-time login token gives a session cookie, only once', async () => {
  const app = createApp({ password: 'pw', loginToken: 'tok', dataFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-')), 'd.json'), sent: {} });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const bad = await fetch(base + '/?login=nope', { redirect: 'manual' });
  assert.strictEqual(bad.status, 401);
  const ok = await fetch(base + '/?login=tok', { redirect: 'manual' });
  assert.strictEqual(ok.status, 302);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.strictEqual((await fetch(base + '/api/state', { headers: { cookie } })).status, 200);
  assert.strictEqual((await fetch(base + '/?login=tok', { redirect: 'manual' })).status, 401); // token burned
  assert.strictEqual((await fetch(base + '/api/state')).status, 401);
  app.server.close();
});

test('manual mode enforces consent, daily limit and repeat window', async () => {
  const app = createApp({ password: 'pw', dailyLimit: 2, repeatDays: 7, dataFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-')), 'd.json'), sent: {} });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const H = { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('u:pw').toString('base64') };
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: H, body: b && JSON.stringify(b) }); return { s: r.status, j: await r.json() }; };
  await call('POST', '/api/contacts', { contacts: [{ phone: '+201000000021' }, { phone: '+201000000022' }, { phone: '+201000000023' }], consentConfirmed: true });
  await call('POST', '/api/contacts', { contacts: [{ phone: '+201000000024' }], consentConfirmed: false });
  const cs = (await call('GET', '/api/state')).j.contacts;
  const id = (p) => cs.find((c) => c.phone === p).id;
  assert.strictEqual((await call('POST', `/api/manual/${id('+201000000024')}/opened`)).s, 403); // no consent
  assert.strictEqual((await call('POST', `/api/manual/${id('+201000000021')}/opened`)).s, 200);
  assert.strictEqual((await call('POST', `/api/manual/${id('+201000000021')}/opened`)).s, 409); // repeat window
  await call('POST', `/api/contacts/${id('+201000000023')}/optout`);
  assert.strictEqual((await call('POST', `/api/manual/${id('+201000000023')}/opened`)).s, 403); // opted out
  assert.strictEqual((await call('POST', `/api/manual/${id('+201000000022')}/opened`)).s, 200);
  assert.strictEqual((await call('POST', `/api/manual/${id('+201000000021')}/opened`)).s, 429); // daily cap hit (checked first)
  assert.strictEqual((await call('GET', '/api/state')).j.manual.today, 2);
  app.server.close();
});
