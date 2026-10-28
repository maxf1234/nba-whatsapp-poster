import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCaption, missingFields } from '../public/templates.js';
import { createApp } from '../server.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('breaking template keeps the channel format and skips empty optionals', () => {
  const caption = buildCaption('breaking', { headline: ' Big news ', details: '', source: 'Shams' }, { footer: '📲 Follow' });
  assert.equal(caption, '🚨 *BREAKING* 🚨\n\n*Big news*\n\n📰 _via Shams_\n\n📲 Follow');
});

test('final score template', () => {
  const caption = buildCaption('final', { away: 'Celtics', awayScore: '112', home: 'Knicks', homeScore: '108' });
  assert.equal(caption, '🏀 *FINAL*\n\nCeltics *112*\nKnicks *108*');
});

test('trade template turns lines into bullets', () => {
  const caption = buildCaption('trade', { headline: 'Deal', teamA: 'Suns', getsA: '- Player A\n2027 1st', teamB: 'Heat', getsB: 'Beal' });
  assert.match(caption, /\*Suns receive:\*\n• Player A\n• 2027 1st/);
  assert.match(caption, /\*Heat receive:\*\n• Beal/);
});

test('empty required fields render as blank in preview, never "undefined"', () => {
  assert.equal(buildCaption('breaking', {}, { blank: '…' }), '🚨 *BREAKING* 🚨\n\n*…*\n\n…');
  assert.doesNotMatch(buildCaption('trade', {}), /undefined/);
});

test('missingFields lists required fields only', () => {
  assert.deepEqual(missingFields('final', { away: 'A', home: 'B' }), ['Away score', 'Home score']);
  assert.deepEqual(missingFields('custom', { body: 'hi' }), []);
  assert.deepEqual(missingFields('nope', {}), ['template']);
});

async function listen(server) {
  await new Promise((r) => server.listen(0, r));
  return `http://127.0.0.1:${server.address().port}`;
}

function fakeWhatsApp(state = 'connected') {
  const sent = [];
  return {
    sent,
    status: () => ({ state, pairingCode: null, target: 'NBA Daily', error: null }),
    requestPairingCode: async () => 'ABCD1234',
    send: async (msg) => { sent.push(msg); return 'NBA Daily'; },
  };
}

const cfg = {
  password: 'pw', footer: '', channel: 'https://whatsapp.com/channel/abc', dryRun: false, timeZone: 'UTC',
  dataDir: await mkdtemp(join(tmpdir(), 'poster-')),
};

async function start(t, wa, overrides = {}) {
  const app = createApp({ ...cfg, ...overrides }, wa);
  const base = await listen(app);
  t.after(() => app.close());
  const call = (path, { pw = 'pw', body } = {}) =>
    fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-poster-password': pw },
      body: body && JSON.stringify(body),
    });
  return call;
}

test('posts formatted caption + image through WhatsApp', async (t) => {
  const wa = fakeWhatsApp();
  const call = await start(t, wa);

  assert.equal((await call('/api/post', { pw: 'wrong', body: { template: 'custom', fields: { body: 'x' } } })).status, 401);
  assert.equal((await call('/api/post', { body: { template: 'final', fields: {} } })).status, 400);

  const res = await call('/api/post', { body: { template: 'stats', fields: { player: 'Jokić', line: '31/17/12' }, image: PNG_1PX } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).to, 'NBA Daily');
  assert.equal(wa.sent.length, 1);
  assert.equal(wa.sent[0].caption, '📊 *STAT LINE*\n\n*Jokić*\n🔥 31/17/12');
  assert.equal(wa.sent[0].image.type, 'image/png');
  assert.ok(wa.sent[0].image.buf.length > 0);
});

test('WhatsApp status and pairing endpoints are password-protected', async (t) => {
  const call = await start(t, fakeWhatsApp('needs_link'));
  assert.equal((await call('/api/whatsapp', { pw: 'nope' })).status, 401);
  assert.equal((await (await call('/api/whatsapp')).json()).state, 'needs_link');
  const pair = await call('/api/whatsapp/pair', { body: { phone: '+1 555 123 4567' } });
  assert.equal((await pair.json()).pairingCode, 'ABCD1234');
  assert.equal((await call('/api/config', { pw: 'nope' })).status, 200);
});

test('dry-run logs instead of sending', async (t) => {
  const wa = fakeWhatsApp('needs_link');
  const call = await start(t, wa, { dryRun: true });
  const res = await call('/api/post', { body: { template: 'custom', fields: { body: 'hello' } } });
  assert.equal(res.status, 200);
  assert.match((await res.json()).status, /dry-run/);
  assert.equal(wa.sent.length, 0);
});

test('unlinked WhatsApp returns a clear error', async (t) => {
  const wa = fakeWhatsApp('needs_link');
  wa.send = async () => { throw Object.assign(new Error('WhatsApp is not linked yet — link it first'), { status: 503 }); };
  const call = await start(t, wa);
  const res = await call('/api/post', { body: { template: 'custom', fields: { body: 'hello' } } });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /not linked/);
});

test('queue endpoints: add, list, send now', async (t) => {
  const wa = fakeWhatsApp();
  const call = await start(t, wa, { dataDir: await mkdtemp(join(tmpdir(), 'poster-')) });
  await call('/api/queue/settings', { body: { paused: true } });
  const added = await (await call('/api/queue', { body: { template: 'custom', fields: { body: 'later' }, image: PNG_1PX } })).json();
  assert.equal(added.position, 1);
  assert.equal((await call('/api/queue', { body: { template: 'final', fields: {} } })).status, 400);

  const list = await (await call('/api/queue')).json();
  assert.equal(list.items.length, 1);
  assert.equal((await call(`/api/queue/${added.id}/image`)).headers.get('content-type'), 'image/png');

  const sent = await (await call(`/api/queue/${added.id}/send`, { body: {} })).json();
  assert.equal(sent.status, 'sent');
  assert.equal(wa.sent[0].caption, 'later');
  assert.equal((await (await call('/api/queue')).json()).items.length, 0);
  const { history } = await (await call('/api/history')).json();
  assert.match(history[0].status, /queued/);
});
