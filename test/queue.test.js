import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQueue, inWindow, nextOpen } from '../queue.js';

const TZ = 'UTC';
const H = 60 * 60 * 1000;
const at = (iso) => Date.parse(iso);

async function setup(t, { deliver } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'q-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = at('2026-10-28T12:00:00Z');
  const sent = [];
  const q = createQueue({
    dir,
    timeZone: TZ,
    now: () => clock,
    deliver: deliver ?? (async (m) => { sent.push(m); return { status: 'sent' }; }),
  });
  await q.load();
  return { q, sent, dir, advance: (ms) => { clock += ms; }, set: (iso) => { clock = at(iso); } };
}

test('active-hours window, including overnight windows', () => {
  const day = { startHour: 9, endHour: 23 };
  assert.equal(inWindow(at('2026-10-28T08:59:00Z'), day, TZ), false);
  assert.equal(inWindow(at('2026-10-28T09:00:00Z'), day, TZ), true);
  assert.equal(inWindow(at('2026-10-28T23:00:00Z'), day, TZ), false);
  const night = { startHour: 18, endHour: 2 };
  assert.equal(inWindow(at('2026-10-28T01:30:00Z'), night, TZ), true);
  assert.equal(inWindow(at('2026-10-28T12:00:00Z'), night, TZ), false);
  assert.equal(inWindow(at('2026-10-28T03:00:00Z'), { startHour: 0, endHour: 0 }, TZ), true);
  assert.equal(nextOpen(at('2026-10-28T23:30:00Z'), day, TZ), at('2026-10-29T09:00:00Z'));
});

test('sends one post per interval, in order', async (t) => {
  const { q, sent, advance } = await setup(t);
  await q.updateSettings({ intervalMin: 120, startHour: 0, endHour: 0 });
  for (const n of [1, 2, 3]) await q.add({ template: 'custom', caption: `post ${n}` });

  await q.tick(); // first goes right away
  assert.deepEqual(sent.map((m) => m.caption), ['post 1']);
  advance(H);
  await q.tick(); // 1h later: not due yet
  assert.equal(sent.length, 1);
  advance(H);
  await q.tick();
  assert.deepEqual(sent.map((m) => m.caption), ['post 1', 'post 2']);
  assert.equal(q.view().items.length, 1);
});

test('ETAs skip quiet hours', async (t) => {
  const { q, set } = await setup(t);
  set('2026-10-28T20:00:00Z');
  await q.updateSettings({ intervalMin: 120, startHour: 9, endHour: 23 });
  for (const n of [1, 2, 3]) await q.add({ template: 'custom', caption: `p${n}` });
  const etas = q.view().items.map((i) => new Date(i.eta).toISOString());
  assert.deepEqual(etas, ['2026-10-28T20:00:00.000Z', '2026-10-28T22:00:00.000Z', '2026-10-29T09:00:00.000Z']);
});

test('pause, reorder, delete and send-now', async (t) => {
  const { q, sent } = await setup(t);
  await q.updateSettings({ startHour: 0, endHour: 0, paused: true });
  const a = await q.add({ template: 'custom', caption: 'A' });
  const b = await q.add({ template: 'custom', caption: 'B' });
  const c = await q.add({ template: 'custom', caption: 'C' });
  await q.tick();
  assert.equal(sent.length, 0, 'paused');
  await q.move(c, -1);
  assert.deepEqual(q.view().items.map((i) => i.caption), ['A', 'C', 'B']);
  await q.remove(a);
  await q.sendNow(b);
  assert.deepEqual(sent.map((m) => m.caption), ['B']);
  assert.deepEqual(q.view().items.map((i) => i.caption), ['C']);
});

test('failed send stays at the front and retries later', async (t) => {
  let fail = true;
  const sent = [];
  const { q, advance } = await setup(t, {
    deliver: async (m) => { if (fail) throw new Error('not linked'); sent.push(m); return { status: 'sent' }; },
  });
  await q.updateSettings({ startHour: 0, endHour: 0 });
  await q.add({ template: 'custom', caption: 'A' });
  await q.tick();
  assert.equal(q.view().error, 'not linked');
  fail = false;
  await q.tick(); // still inside the retry delay
  assert.equal(sent.length, 0);
  advance(5 * 60 * 1000);
  await q.tick();
  assert.equal(sent.length, 1);
  assert.equal(q.view().error, null);
});

test('queue and media survive a restart', async (t) => {
  const { q, dir } = await setup(t);
  await q.updateSettings({ intervalMin: 180 });
  await mkdir(join(dir, 'media'), { recursive: true });
  await writeFile(join(dir, 'media', 'abc.jpg'), 'jpg!');
  const media = { file: 'abc.jpg', kind: 'image', mimetype: 'image/jpeg', width: 1600, height: 900, thumb: Buffer.from('t').toString('base64') };
  await q.add({ template: 'custom', caption: 'A', media });

  const sent = [];
  const q2 = createQueue({ dir, timeZone: TZ, deliver: async (m) => { sent.push(m); return { status: 'sent' }; } });
  await q2.load();
  const view = q2.view();
  assert.equal(view.settings.intervalMin, 180);
  assert.equal(view.items[0].kind, 'image');
  assert.deepEqual([...q2.files()], ['abc.jpg']);
  await q2.sendNow(view.items[0].id);
  const m = sent[0].media;
  assert.deepEqual([m.kind, m.width, m.height, m.thumbnail.toString()], ['image', 1600, 900, 't']);
  assert.equal(await readFile(m.path, 'utf8').catch(() => 'deleted'), 'deleted', 'file removed after sending');
});

test('photos queued by the previous version still send', async (t) => {
  const { dir } = await setup(t);
  await mkdir(join(dir, 'queue-images'), { recursive: true });
  await writeFile(join(dir, 'queue-images', 'old1'), 'png!');
  await writeFile(join(dir, 'queue.json'), JSON.stringify({
    settings: { intervalMin: 60, startHour: 0, endHour: 0, paused: false },
    items: [{ id: 'old1', template: 'custom', caption: 'old', imageType: 'image/png', addedAt: 1 }],
    lastSentAt: 0, retryAt: 0, error: null,
  }));
  const sent = [];
  const q = createQueue({ dir, timeZone: TZ, deliver: async (m) => { sent.push(m); return { status: 'sent' }; } });
  await q.load();
  assert.equal(q.view().items[0].kind, 'image');
  await q.tick();
  assert.equal(await readFile(sent[0].media.path, 'utf8').catch(() => 'deleted'), 'deleted');
  assert.equal(sent[0].media.mimetype, 'image/png');
});

test('a post with a set time goes out then, without shifting the spacing', async (t) => {
  const { q, sent, advance, set } = await setup(t);
  set('2026-10-28T09:00:00Z');
  await q.updateSettings({ intervalMin: 120, startHour: 0, endHour: 0 });
  await q.add({ template: 'custom', caption: 'A' });
  await q.add({ template: 'custom', caption: 'B' });
  await q.add({ template: 'custom', caption: 'pinned', sendAt: at('2026-10-28T10:30:00Z') });
  assert.deepEqual(
    q.view().items.map((i) => `${i.caption}@${new Date(i.eta).toISOString().slice(11, 16)}`),
    ['A@09:00', 'pinned@10:30', 'B@11:00'],
  );

  await q.tick();
  advance(90 * 60 * 1000); // 10:30
  await q.tick();
  assert.deepEqual(sent.map((m) => m.caption), ['A', 'pinned']);
  advance(29 * 60 * 1000); // 10:59 — B still waits for 11:00
  await q.tick();
  assert.equal(sent.length, 2);
  advance(60 * 1000);
  await q.tick();
  assert.deepEqual(sent.map((m) => m.caption), ['A', 'pinned', 'B']);
});

test('set times ignore quiet hours and pause still holds them', async (t) => {
  const { q, sent, set } = await setup(t);
  set('2026-10-28T02:00:00Z');
  await q.updateSettings({ startHour: 9, endHour: 23, paused: true });
  const id = await q.add({ template: 'custom', caption: 'late night', sendAt: at('2026-10-28T02:00:00Z') });
  await q.tick();
  assert.equal(sent.length, 0, 'paused');
  await q.updateSettings({ paused: false });
  await q.tick();
  assert.deepEqual(sent.map((m) => m.caption), ['late night']);
  await assert.rejects(q.setTime(id, Date.now()), /not in the queue/);
});

test('setTime validates and can clear a time', async (t) => {
  const { q, set } = await setup(t);
  set('2026-10-28T12:00:00Z');
  await q.updateSettings({ startHour: 0, endHour: 0, paused: true });
  const id = await q.add({ template: 'custom', caption: 'A', sendAt: at('2026-10-28T15:00:00Z') });
  await assert.rejects(q.setTime(id, at('2026-10-28T11:00:00Z')), /already passed/);
  await assert.rejects(q.add({ template: 'custom', caption: 'B', sendAt: 'soon' }), /Invalid time/);
  await q.setTime(id, null);
  assert.equal(q.view().items[0].sendAt, null);
  assert.equal(q.view().items[0].eta, at('2026-10-28T12:00:00Z'));
});

test('reordering skips posts with a set time', async (t) => {
  const { q } = await setup(t);
  await q.updateSettings({ startHour: 0, endHour: 0, paused: true });
  const a = await q.add({ template: 'custom', caption: 'A' });
  await q.add({ template: 'custom', caption: 'P', sendAt: Date.parse('2026-10-29T00:00:00Z') });
  const b = await q.add({ template: 'custom', caption: 'B' });
  await q.move(b, -1);
  const flex = q.view().items.filter((i) => !i.sendAt).map((i) => i.caption);
  assert.deepEqual(flex, ['B', 'A']);
  await q.move(a, 1); // already last: no-op
  assert.deepEqual(q.view().items.filter((i) => !i.sendAt).map((i) => i.caption), ['B', 'A']);
});
