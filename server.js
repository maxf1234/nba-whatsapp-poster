// NBA channel poster: a tiny web form that posts straight to a WhatsApp
// channel from its own linked WhatsApp account.
//
// Pick a template, drop an image, fill the fields, then either post now or
// add it to the queue (queue.js), which sends one post every N hours inside
// the active hours. The caption is built from the shared template, so the
// channel format never drifts. WhatsApp (whatsapp.js) is linked from the
// page with a pairing code.
//
// `npm start`

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join } from 'node:path';
import { buildCaption, missingFields, TEMPLATES } from './public/templates.js';
import { createWhatsApp } from './whatsapp.js';
import { createQueue } from './queue.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = new URL('./public/', import.meta.url);
const MAX_BODY = 12 * 1024 * 1024; // base64 image + fields
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

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
    if (size > MAX_BODY) throw Object.assign(new Error('Image too large (max ~8 MB)'), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function parseDataUrl(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m || !IMAGE_TYPES.has(m[1])) return null;
  return { type: m[1], buf: Buffer.from(m[2], 'base64') };
}

// Validate a submitted post and build its caption + image.
async function readPost(req, cfg) {
  const { template, fields, image } = await readJson(req);
  const missing = missingFields(template, fields);
  if (missing.length) throw Object.assign(new Error(`Missing: ${missing.join(', ')}`), { status: 400 });
  let img;
  if (image) {
    img = parseDataUrl(image);
    if (!img) throw Object.assign(new Error('Image must be JPEG, PNG or WebP'), { status: 400 });
  }
  return { template, caption: buildCaption(template, fields, { footer: cfg.footer }), image: img };
}

export function createApp(cfg = config(), wa = createWhatsApp({ authDir: cfg.authDir, target: cfg.channel }), queue) {
  const history = []; // last few posts, newest first
  const record = (template, caption, status, to) => {
    history.unshift({ at: new Date().toISOString(), template, caption, status, to });
    history.length = Math.min(history.length, 20);
  };

  // The one place a post actually leaves: WhatsApp, or the log in dry-run.
  async function deliver({ caption, image }) {
    if (cfg.dryRun) {
      console.log(`[dry-run]${image ? ' (+ image)' : ''}\n${caption}\n`);
      return { status: 'dry-run (DRY_RUN is on)' };
    }
    return { status: 'sent', to: await wa.send({ caption, image }) };
  }

  queue ??= createQueue({
    dir: cfg.dataDir,
    timeZone: cfg.timeZone,
    deliver,
    onSent: (item) => record(item.template, item.caption, `${item.result.status} (queued)`, item.result.to),
  });

  const routes = {
    'POST /api/post': async (req) => {
      const post = await readPost(req, cfg);
      const result = await deliver(post);
      record(post.template, post.caption, result.status, result.to);
      return { ok: true, ...result };
    },
    'POST /api/queue': async (req) => {
      const id = await queue.add(await readPost(req, cfg));
      const view = queue.view();
      return { ok: true, id, position: view.items.findIndex((i) => i.id === id) + 1, eta: view.items.at(-1)?.eta };
    },
    'GET /api/queue': () => queue.view(),
    'POST /api/queue/settings': async (req) => {
      await queue.updateSettings(await readJson(req));
      return queue.view();
    },
    'GET /api/history': () => ({ history }),
    'GET /api/whatsapp': () => ({ ...wa.status(), dryRun: cfg.dryRun, channelSet: Boolean(cfg.channel) }),
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

      // Per-item queue actions: /api/queue/<id>[/image|/send|/up|/down]
      const m = /^\/api\/queue\/([\w-]+)(?:\/(image|send|up|down))?$/.exec(url.pathname);
      if (m) {
        const [, id, action] = m;
        if (req.method === 'DELETE' && !action) { await queue.remove(id); return send(res, 200, queue.view()); }
        if (req.method === 'GET' && action === 'image') {
          const img = await queue.image(id);
          return img ? send(res, 200, img.buf, { 'content-type': img.type }) : send(res, 404, 'No image');
        }
        if (req.method === 'POST' && (action === 'up' || action === 'down')) {
          await queue.move(id, action === 'up' ? -1 : 1);
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
  const wa = createWhatsApp({ authDir: cfg.authDir, target: cfg.channel });
  const app = createApp(cfg, wa);
  await app.queue.load();
  app.queue.start();
  app.listen(PORT, () => {
    console.log(`NBA poster on http://localhost:${PORT}`);
    if (cfg.dryRun) console.log('DRY_RUN is on — posts are logged, not sent');
    if (!cfg.channel) console.log('WHATSAPP_CHANNEL not set — set it to the channel invite link');
    if (!cfg.password) console.log('POSTER_PASSWORD not set — anyone with the URL can post!');
    console.log(`Queue: ${app.queue.view().items.length} waiting · times in ${cfg.timeZone}`);
  });
  wa.connect().catch((e) => console.error('WhatsApp failed to start:', e.message));
}
