import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildCaption, missingFields } from '../public/templates.js';
import { createApp } from '../server.js';

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

test('missingFields lists required fields only', () => {
  assert.deepEqual(missingFields('final', { away: 'A', home: 'B' }), ['Away score', 'Home score']);
  assert.deepEqual(missingFields('custom', { body: 'hi' }), []);
  assert.deepEqual(missingFields('nope', {}), ['template']);
});

async function listen(server) {
  await new Promise((r) => server.listen(0, r));
  return `http://127.0.0.1:${server.address().port}`;
}

test('posts formatted caption + fetchable image URL to the bot', async (t) => {
  const received = [];
  const bot = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    received.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    res.end('ok');
  });
  const botUrl = await listen(bot);
  const app = createApp({ botUrl, botToken: 'tok', password: 'pw', footer: '', publicUrl: '' });
  const base = await listen(app);
  t.after(() => { bot.close(); app.close(); });

  const post = (pw, payload) =>
    fetch(`${base}/api/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-poster-password': pw },
      body: JSON.stringify(payload),
    });

  assert.equal((await post('wrong', { template: 'custom', fields: { body: 'x' } })).status, 401);
  assert.equal((await post('pw', { template: 'final', fields: {} })).status, 400);

  const res = await post('pw', { template: 'stats', fields: { player: 'Jokić', line: '31/17/12' }, image: PNG_1PX });
  assert.equal(res.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].auth, 'Bearer tok');
  assert.equal(received[0].body.caption, '📊 *STAT LINE*\n\n*Jokić*\n🔥 31/17/12');
  assert.equal(received[0].body.mimetype, 'image/png');

  const img = await fetch(received[0].body.image);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
});

test('dry-run when no bot URL is configured', async (t) => {
  const app = createApp({ botUrl: '', botToken: '', password: '', footer: '', publicUrl: '' });
  const base = await listen(app);
  t.after(() => app.close());
  const res = await fetch(`${base}/api/post`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ template: 'custom', fields: { body: 'hello' } }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.match(data.status, /dry-run/);
});
