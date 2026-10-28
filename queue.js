// Post queue: load up a batch of posts, they go out one at a time every
// `intervalMin`, only inside the active hours (in TIMEZONE).
//
// Saved to DATA_DIR (the Railway volume) so a redeploy never loses it:
//   queue.json          — settings, items (caption + metadata), lastSentAt
//   queue-images/<id>   — each queued post's image

import { mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const STEP_MS = 5 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000; // after a failed send
export const DEFAULT_SETTINGS = { intervalMin: 120, startHour: 9, endHour: 23, paused: false };

export function hourIn(ms, timeZone) {
  const h = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(ms);
  return Number(h) % 24;
}

// Active window [startHour, endHour) in local time; start === end = all day.
// An overnight window (e.g. 18 → 2) works too.
export function inWindow(ms, { startHour, endHour }, timeZone) {
  if (startHour === endHour) return true;
  const h = hourIn(ms, timeZone);
  return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

// First moment at or after `ms` that's inside the window.
export function nextOpen(ms, settings, timeZone) {
  if (inWindow(ms, settings, timeZone)) return ms;
  let t = Math.ceil(ms / STEP_MS) * STEP_MS;
  for (let i = 0; i < 400 && !inWindow(t, settings, timeZone); i++) t += STEP_MS;
  // Land on the hour the window opens rather than a 5-minute step past it.
  const onHour = t - (t % (60 * 60 * 1000));
  return onHour >= ms && inWindow(onHour, settings, timeZone) ? onHour : t;
}

// Scheduled send time for every queued item, in order.
export function schedule(state, now, timeZone) {
  const { items, settings, lastSentAt, retryAt } = state;
  const gap = settings.intervalMin * 60 * 1000;
  let t = Math.max(now, lastSentAt ? lastSentAt + gap : now, retryAt || 0);
  return items.map((item, i) => {
    if (i > 0) t += gap;
    t = nextOpen(t, settings, timeZone);
    return { ...item, eta: t };
  });
}

export function createQueue({ dir, timeZone, deliver, onSent = () => {}, now = Date.now }) {
  const file = join(dir, 'queue.json');
  const imgDir = join(dir, 'queue-images');
  let state = { settings: { ...DEFAULT_SETTINGS }, items: [], lastSentAt: 0, retryAt: 0, error: null };
  let sending = false;
  let timer = null;

  async function save() {
    await mkdir(dir, { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2));
    await rename(`${file}.tmp`, file); // atomic: a crash never leaves half a file
  }

  const find = (id) => {
    const i = state.items.findIndex((it) => it.id === id);
    if (i < 0) throw Object.assign(new Error('Post not in the queue'), { status: 404 });
    return i;
  };

  const readImage = async (item) =>
    item.imageType ? { type: item.imageType, buf: await readFile(join(imgDir, item.id)) } : undefined;

  async function sendItem(i) {
    const item = state.items[i];
    const result = await deliver({ caption: item.caption, image: await readImage(item) });
    state.items.splice(i, 1);
    state.lastSentAt = now();
    state.retryAt = 0;
    state.error = null;
    await save();
    await rm(join(imgDir, item.id), { force: true });
    onSent({ ...item, result });
    return result;
  }

  return {
    async load() {
      try {
        const saved = JSON.parse(await readFile(file, 'utf8'));
        state = { ...state, ...saved, settings: { ...DEFAULT_SETTINGS, ...saved.settings } };
      } catch {} // first run
    },

    view() {
      const items = schedule(state, now(), timeZone).map(({ id, template, caption, imageType, addedAt, eta }) => ({
        id, template, caption, hasImage: Boolean(imageType), addedAt, eta,
      }));
      return { items, settings: state.settings, lastSentAt: state.lastSentAt, error: state.error, timeZone };
    },

    async add({ template, caption, image }) {
      const id = randomUUID();
      if (image) {
        await mkdir(imgDir, { recursive: true });
        await writeFile(join(imgDir, id), image.buf);
      }
      state.items.push({ id, template, caption, imageType: image?.type ?? null, addedAt: now() });
      await save();
      return id;
    },

    async remove(id) {
      state.items.splice(find(id), 1);
      await save();
      await rm(join(imgDir, id), { force: true });
    },

    async move(id, dir) {
      const i = find(id);
      const j = i + (dir < 0 ? -1 : 1);
      if (j < 0 || j >= state.items.length) return;
      [state.items[i], state.items[j]] = [state.items[j], state.items[i]];
      await save();
    },

    image: async (id) => readImage(state.items[find(id)]),

    async sendNow(id) {
      if (sending) throw Object.assign(new Error('A post is sending right now — try again in a moment'), { status: 409 });
      sending = true;
      try {
        return await sendItem(find(id));
      } finally {
        sending = false;
      }
    },

    async updateSettings(patch) {
      const s = { ...state.settings };
      if (patch.intervalMin !== undefined) {
        const m = Number(patch.intervalMin);
        if (!(m >= 5 && m <= 24 * 60)) throw Object.assign(new Error('Interval must be 5 min – 24 h'), { status: 400 });
        s.intervalMin = m;
      }
      for (const k of ['startHour', 'endHour']) {
        if (patch[k] === undefined) continue;
        const h = Number(patch[k]);
        if (!Number.isInteger(h) || h < 0 || h > 23) throw Object.assign(new Error('Hours are 0–23'), { status: 400 });
        s[k] = h;
      }
      if (patch.paused !== undefined) s.paused = Boolean(patch.paused);
      state.settings = s;
      await save();
    },

    // Called on a timer: send the head of the queue once it's due.
    async tick() {
      if (sending || state.settings.paused || !state.items.length) return;
      const [head] = schedule(state, now(), timeZone);
      if (head.eta > now()) return;
      sending = true;
      try {
        await sendItem(0);
      } catch (err) {
        // Keep it at the front and retry in a few minutes (e.g. WhatsApp
        // reconnecting); the error shows on the page meanwhile.
        state.error = err.message;
        state.retryAt = now() + RETRY_MS;
        console.warn(`Queued post failed: ${err.message} — retrying in 5 min`);
        await save();
      } finally {
        sending = false;
      }
    },

    start(everyMs = 30 * 1000) {
      timer = setInterval(() => this.tick().catch((e) => console.error('Queue tick failed:', e)), everyMs);
      timer.unref?.();
    },

    stop: () => clearInterval(timer),
  };
}
