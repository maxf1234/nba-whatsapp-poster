// Post queue: load up a batch of posts, they go out one at a time every
// `intervalMin`, only inside the active hours (in TIMEZONE). A post can
// instead be pinned to an exact time (`sendAt`); pinned posts go out at that
// time and don't shift the spacing of the others.
//
// Saved to DATA_DIR (the Railway volume) so a redeploy never loses it:
//   queue.json          — settings, items (caption + media info), lastSentAt
//   media/<file>        — each queued post's photo or video (see media.js)
//   queue-images/<id>   — photos queued before media/ existed

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

// Scheduled send time for every queued item, soonest first. Pinned items
// keep their time; the rest are spaced `intervalMin` apart from the last
// spaced post, inside the active hours. A failed item waits for its retryAt.
export function schedule(state, now, timeZone) {
  const { items, settings, lastSentAt } = state;
  const gap = settings.intervalMin * 60 * 1000;
  let t = Math.max(now, lastSentAt ? lastSentAt + gap : now);
  let first = true;
  return items
    .map((item) => {
      if (item.sendAt) return { ...item, eta: Math.max(item.sendAt, item.retryAt || 0) };
      if (!first) t += gap;
      first = false;
      t = nextOpen(Math.max(t, item.retryAt || 0), settings, timeZone);
      return { ...item, eta: t };
    })
    .sort((a, b) => a.eta - b.eta);
}

const err = (message, status) => Object.assign(new Error(message), { status });

export function createQueue({ dir, timeZone, deliver, onSent = () => {}, now = Date.now }) {
  const file = join(dir, 'queue.json');
  const mediaDir = join(dir, 'media');
  const legacyImgDir = join(dir, 'queue-images');
  let state = { settings: { ...DEFAULT_SETTINGS }, items: [], lastSentAt: 0, error: null };
  let sending = false;
  let timer = null;

  async function save() {
    await mkdir(dir, { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2));
    await rename(`${file}.tmp`, file); // atomic: a crash never leaves half a file
  }

  const find = (id) => {
    const i = state.items.findIndex((it) => it.id === id);
    if (i < 0) throw err('Post not in the queue', 404);
    return i;
  };

  // What deliver() gets: the file on disk plus the size/thumbnail WhatsApp
  // needs to show it uncropped.
  const mediaFor = (item) => {
    if (item.media) {
      const { file: f, thumb, ...rest } = item.media;
      return { ...rest, path: join(mediaDir, f), thumbnail: thumb ? Buffer.from(thumb, 'base64') : undefined };
    }
    if (item.imageType) return { kind: 'image', mimetype: item.imageType, path: join(legacyImgDir, item.id) };
    return undefined;
  };

  const dropMedia = (item) =>
    rm(item.media ? join(mediaDir, item.media.file) : join(legacyImgDir, item.id), { force: true });

  async function sendItem(i) {
    const item = state.items[i];
    const result = await deliver({ caption: item.caption, media: mediaFor(item) });
    state.items.splice(i, 1);
    if (!item.sendAt) state.lastSentAt = now(); // pinned posts don't move the spacing
    state.error = null;
    await save();
    await dropMedia(item);
    onSent({ ...item, result });
    return result;
  }

  function checkTime(sendAt) {
    if (sendAt === null || sendAt === undefined || sendAt === '') return null;
    const t = Number(sendAt);
    if (!Number.isFinite(t)) throw err('Invalid time', 400);
    if (t < now() - 60 * 1000) throw err('That time has already passed', 400);
    return t;
  }

  return {
    async load() {
      try {
        const saved = JSON.parse(await readFile(file, 'utf8'));
        state = { ...state, ...saved, settings: { ...DEFAULT_SETTINGS, ...saved.settings } };
        delete state.retryAt; // older versions kept one global retry time
      } catch {} // first run
    },

    view() {
      const items = schedule(state, now(), timeZone).map((it) => ({
        id: it.id,
        template: it.template,
        caption: it.caption,
        kind: it.media?.kind ?? (it.imageType ? 'image' : null),
        seconds: it.media?.seconds ?? null,
        sendAt: it.sendAt ?? null,
        addedAt: it.addedAt,
        eta: it.eta,
      }));
      return { items, settings: state.settings, lastSentAt: state.lastSentAt, error: state.error, timeZone };
    },

    // `media` is what media.js stored: { file, kind, mimetype, width, height, seconds, thumb }.
    async add({ template, caption, media, sendAt }) {
      const id = randomUUID();
      state.items.push({ id, template, caption, media: media ?? null, sendAt: checkTime(sendAt), addedAt: now() });
      await save();
      return id;
    },

    async remove(id) {
      const [item] = state.items.splice(find(id), 1);
      await save();
      await dropMedia(item);
    },

    // Reorder among the spaced (unpinned) posts; pinned ones keep their time.
    async move(id, dir) {
      const flex = state.items.map((it, i) => (it.sendAt ? -1 : i)).filter((i) => i >= 0);
      const k = flex.indexOf(find(id));
      const other = flex[k + (dir < 0 ? -1 : 1)];
      if (k < 0 || other === undefined) return;
      const i = flex[k];
      [state.items[i], state.items[other]] = [state.items[other], state.items[i]];
      await save();
    },

    async setTime(id, sendAt) {
      const item = state.items[find(id)];
      item.sendAt = checkTime(sendAt);
      item.retryAt = 0;
      await save();
    },

    // Preview thumbnail for the queue list.
    async thumbnail(id) {
      const item = state.items[find(id)];
      if (item.media?.thumb) return { type: 'image/jpeg', buf: Buffer.from(item.media.thumb, 'base64') };
      if (item.media?.kind === 'image') return { type: item.media.mimetype, buf: await readFile(join(mediaDir, item.media.file)) };
      if (item.imageType) return { type: item.imageType, buf: await readFile(join(legacyImgDir, item.id)) };
      return null;
    },

    // Files this queue still owns (so media.js never prunes them).
    files: () => new Set(state.items.filter((it) => it.media).map((it) => it.media.file)),

    async sendNow(id) {
      if (sending) throw err('A post is sending right now — try again in a moment', 409);
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
        if (!(m >= 5 && m <= 24 * 60)) throw err('Interval must be 5 min – 24 h', 400);
        s.intervalMin = m;
      }
      for (const k of ['startHour', 'endHour']) {
        if (patch[k] === undefined) continue;
        const h = Number(patch[k]);
        if (!Number.isInteger(h) || h < 0 || h > 23) throw err('Hours are 0–23', 400);
        s[k] = h;
      }
      if (patch.paused !== undefined) s.paused = Boolean(patch.paused);
      state.settings = s;
      await save();
    },

    // Called on a timer: send whichever post is due first.
    async tick() {
      if (sending || state.settings.paused || !state.items.length) return;
      const [due] = schedule(state, now(), timeZone);
      if (due.eta > now()) return;
      sending = true;
      const i = find(due.id);
      try {
        await sendItem(i);
      } catch (e) {
        // Keep it and retry in a few minutes (e.g. WhatsApp reconnecting);
        // the error shows on the page meanwhile.
        state.error = e.message;
        state.items[i].retryAt = now() + RETRY_MS;
        console.warn(`Queued post failed: ${e.message} — retrying in 5 min`);
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
