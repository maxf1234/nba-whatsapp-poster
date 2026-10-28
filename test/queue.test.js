import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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

test('queue and images survive a restart', async (t) => {
  const { q, dir } = await setup(t);
  await q.updateSettings({ intervalMin: 180 });
  await q.add({ template: 'custom', caption: 'A', image: { type: 'image/png', buf: Buffer.from('png!') } });

  const sent = [];
  const q2 = createQueue({ dir, timeZone: TZ, deliver: async (m) => { sent.push(m); return { status: 'sent' }; } });
  await q2.load();
  const view = q2.view();
  assert.equal(view.settings.intervalMin, 180);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].hasImage, true);
  await q2.sendNow(view.items[0].id);
  assert.equal(sent[0].image.buf.toString(), 'png!');
});
