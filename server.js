// NBA channel poster: a tiny web form that posts straight to a WhatsApp
// channel from its own linked WhatsApp account.
//
// Pick a template, add a photo or video, fill the fields, then either post
// now or add it to the queue (queue.js), which sends one post every N hours
// inside the active hours, or at a time you pick. The caption is built from
// the shared template, so the channel format never drifts. Photos/videos are
// uploaded first (media.js); WhatsApp (whatsapp.js) is linked from the page
// with a pairing code.
//
// `npm start`

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join } from 'node:path';
import { buildCaption, missingFields, TEMPLATES } from './public/templates.js';
import { createWhatsApp } from './whatsapp.js';
import { createQueue } from './queue.js';
import { createMedia } from './media.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = new URL('./public/', import.meta.url);
const MAX_BODY = 256 * 1024; // JSON only — photos/videos go through /api/media
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

export function config(env = process.env) {
  // Railway volume mounted at /data keeps the WhatsApp login and the queue
  // across deploys.
  const dataDir = env.DATA_DIR || (env.RAILWAY_ENVIRONMENT ? '/data' : './data');
  return {
    password: env.POSTER_PASSWORD || '',
    footer: (env.POST_FOOTER ?? '').replace(/\\n/g, '\n'),
    channel: (env.WHATSAPP_CHANNEL || '').trim(),
    dataDir,
    authDir: env.AUTH_DIR || join(dataDir, 'baileys_auth'),
    timeZone: env.TIMEZONE || 'America/New_York',
    dryRun: /^(1|true|yes)$/i.test(env.DRY_RUN || ''),
  };
}

function checkPassword(given, expected) {
  if (!expected) return true; // no password set = open (fine for local dev only)
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isJson ? 'application/json' : 'text/plain',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

// Validate a submitted post and build its caption. `mediaId` refers to an
// earlier /api/media upload; the post takes ownership of that file.
async function readPost(req, cfg, media) {
  const { template, fields, mediaId, sendAt } = await readJson(req);
  const missing = missingFields(template, fields);
  if (missing.length) throw Object.assign(new Error(`Missing: ${missing.join(', ')}`), { status: 400 });
  return {
    template,
    caption: buildCaption(template, fields, { footer: cfg.footer }),
    media: mediaId ? media.take(mediaId) : null,
    sendAt,
  };
}

const waOptions = (cfg) => ({
  authDir: cfg.authDir,
  target: cfg.channel, // default until a channel is set from the page
  channelFile: join(cfg.dataDir, 'channel.json'),
});

export function createApp(cfg = config(), wa = createWhatsApp(waOptions(cfg)), queue) {
  const history = []; // last few posts, newest first
  const record = (template, caption, status, to) => {
    history.unshift({ at: new Date().toISOString(), template, caption, status, to });
    history.length = Math.min(history.length, 20);
  };

  // The one place a post actually leaves: WhatsApp, or the log in dry-run.
  async function deliver({ caption, media }) {
    if (cfg.dryRun) {
      const what = media ? ` (+ ${media.kind}${media.width ? ` ${media.width}×${media.height}` : ''})` : '';
      console.log(`[dry-run]${what}\n${caption}\n`);
      return { status: 'dry-run (DRY_RUN is on)' };
    }
    return { status: 'sent', to: await wa.send({ caption, media }) };
  }

  queue ??= createQueue({
    dir: cfg.dataDir,
    timeZone: cfg.timeZone,
    deliver,
    onSent: (item) => record(item.template, item.caption, `${item.result.status} (queued)`, item.result.to),
  });
  const media = createMedia({ dir: cfg.dataDir, keep: () => queue.files() });

  const routes = {
    'POST /api/media': (req) => media.store(req),
    'POST /api/post': async (req) => {
      const post = await readPost(req, cfg, media);
      try {
        const result = await deliver({ caption: post.caption, media: post.media && media.toDeliverable(post.media) });
        record(post.template, post.caption, result.status, result.to);
        return { ok: true, ...result };
      } finally {
        if (post.media) await media.remove(post.media);
      }
    },
    'POST /api/queue': async (req) => {
      const post = await readPost(req, cfg, media);
      let id;
      try {
        id = await queue.add(post);
      } catch (e) {
        if (post.media) await media.remove(post.media);
        throw e;
      }
      const view = queue.view();
      const item = view.items.find((i) => i.id === id);
      return { ok: true, id, position: view.items.indexOf(item) + 1, eta: item.eta };
    },
    'GET /api/queue': () => queue.view(),
    'POST /api/queue/settings': async (req) => {
      await queue.updateSettings(await readJson(req));
      return queue.view();
    },
    'GET /api/history': () => ({ history }),
    'GET /api/whatsapp': () => ({ ...wa.status(), dryRun: cfg.dryRun }),
    'POST /api/whatsapp/channel': async (req) => ({ ok: true, channel: await wa.setChannel((await readJson(req)).link) }),
    'POST /api/whatsapp/pair': async (req) => ({ pairingCode: await wa.requestPairingCode((await readJson(req)).phone) }),
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/') && url.pathname !== '/api/config' &&
          !checkPassword(req.headers['x-poster-password'], cfg.password)) {
        return send(res, 401, { error: 'Wrong password' });
      }

      const route = routes[`${req.method} ${url.pathname}`];
      if (route) return send(res, 200, await route(req));

      // Per-item queue actions: /api/queue/<id>[/image|/send|/up|/down|/time]
      const m = /^\/api\/queue\/([\w-]+)(?:\/(image|send|up|down|time))?$/.exec(url.pathname);
      if (m) {
        const [, id, action] = m;
        if (req.method === 'DELETE' && !action) { await queue.remove(id); return send(res, 200, queue.view()); }
        if (req.method === 'GET' && action === 'image') {
          const img = await queue.thumbnail(id);
          return img ? send(res, 200, img.buf, { 'content-type': img.type }) : send(res, 404, 'No image');
        }
        if (req.method === 'POST' && (action === 'up' || action === 'down')) {
          await queue.move(id, action === 'up' ? -1 : 1);
          return send(res, 200, queue.view());
        }
        if (req.method === 'POST' && action === 'time') {
          await queue.setTime(id, (await readJson(req)).sendAt);
          return send(res, 200, queue.view());
        }
        if (req.method === 'POST' && action === 'send') {
          const result = await queue.sendNow(id);
          return send(res, 200, { ok: true, ...result, ...queue.view() });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/config') {
        return send(res, 200, {
          footer: cfg.footer,
          needsPassword: Boolean(cfg.password),
          templates: Object.keys(TEMPLATES),
        });
      }

      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, 'ok');

      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (file.includes('..')) return send(res, 400, 'Bad path');
        const buf = await readFile(new URL(file, PUBLIC_DIR)).catch(() => null);
        if (!buf) return send(res, 404, 'Not found');
        return send(res, 200, buf, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      }

      send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!err.status) console.error(err);
      send(res, err.status || 500, { error: err.message });
    }
  });
  server.queue = queue;
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = config();
  const wa = createWhatsApp(waOptions(cfg));
  const app = createApp(cfg, wa);
  await app.queue.load();
  app.queue.start();
  app.listen(PORT, () => {
    console.log(`NBA poster on http://localhost:${PORT}`);
    if (cfg.dryRun) console.log('DRY_RUN is on — posts are logged, not sent');
    if (!cfg.password) console.log('POSTER_PASSWORD not set — anyone with the URL can post!');
    console.log(`Queue: ${app.queue.view().items.length} waiting · times in ${cfg.timeZone}`);
  });
  wa.connect().catch((e) => console.error('WhatsApp failed to start:', e.message));
}
