// NBA channel poster: a tiny web form → the WhatsApp bot on Railway.
//
// Pick a template, drop an image, fill the fields, hit Post. The server
// builds the caption from the shared template (so the channel format never
// drifts), hosts the uploaded image at a public URL, and POSTs
// { image, caption } to the bot — the same contract the deal alerts use.
//
// Zero dependencies: `node server.js`.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';
import { buildCaption, missingFields, TEMPLATES } from './public/templates.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = new URL('./public/', import.meta.url);
const MAX_BODY = 12 * 1024 * 1024; // base64 image + fields
const IMAGE_TTL_MS = 24 * 60 * 60 * 1000;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Uploaded images live in memory just long enough for the bot to fetch them.
const images = new Map(); // id → { buf, type, at }
const history = []; // last few posts, newest first

export function config(env = process.env) {
  return {
    botUrl: env.WHATSAPP_BOT_URL || '',
    botToken: env.WHATSAPP_BOT_TOKEN || '',
    password: env.POSTER_PASSWORD || '',
    footer: (env.POST_FOOTER ?? '').replace(/\\n/g, '\n'),
    // Railway exposes the service domain; PUBLIC_URL overrides it.
    publicUrl:
      env.PUBLIC_URL ||
      (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : ''),
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
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function parseDataUrl(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m || !IMAGE_TYPES.has(m[1])) return null;
  return { type: m[1], buf: Buffer.from(m[2], 'base64') };
}

function pruneImages(now = Date.now()) {
  for (const [id, img] of images) if (now - img.at > IMAGE_TTL_MS) images.delete(id);
}

async function handlePost(req, res, cfg) {
  if (!checkPassword(req.headers['x-poster-password'], cfg.password)) {
    return send(res, 401, { error: 'Wrong password' });
  }
  const { template, fields, image, dryRun } = await readJson(req);

  const missing = missingFields(template, fields);
  if (missing.length) return send(res, 400, { error: `Missing: ${missing.join(', ')}` });

  const caption = buildCaption(template, fields, { footer: cfg.footer });

  let imageUrl;
  let img;
  if (image) {
    img = parseDataUrl(image);
    if (!img) return send(res, 400, { error: 'Image must be JPEG, PNG or WebP' });
    const id = randomUUID();
    images.set(id, { ...img, at: Date.now() });
    pruneImages();
    const base = cfg.publicUrl || `http://${req.headers.host}`;
    imageUrl = `${base}/i/${id}`;
  }

  const entry = { at: new Date().toISOString(), template, caption, imageUrl, status: 'sent' };

  if (dryRun || !cfg.botUrl) {
    entry.status = cfg.botUrl ? 'preview' : 'dry-run (WHATSAPP_BOT_URL not set)';
    console.log(`[${entry.status}] ${template}\n${caption}\n${imageUrl ?? '(no image)'}\n`);
  } else {
    const botRes = await fetch(cfg.botUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.botToken ? { authorization: `Bearer ${cfg.botToken}` } : {}),
      },
      // `image` is a URL (same as the deal alerts); base64 is included too
      // in case the bot can't reach this service over the network.
      body: JSON.stringify({
        image: imageUrl,
        caption,
        ...(img ? { image_base64: img.buf.toString('base64'), mimetype: img.type } : {}),
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!botRes.ok) {
      const detail = (await botRes.text().catch(() => '')).slice(0, 200);
      return send(res, 502, { error: `WhatsApp bot HTTP ${botRes.status} ${detail}`.trim() });
    }
  }

  history.unshift(entry);
  history.length = Math.min(history.length, 20);
  return send(res, 200, { ok: true, ...entry });
}

export function createApp(cfg = config()) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'POST' && url.pathname === '/api/post') return await handlePost(req, res, cfg);

      if (req.method === 'GET' && url.pathname === '/api/history') {
        if (!checkPassword(req.headers['x-poster-password'], cfg.password)) {
          return send(res, 401, { error: 'Wrong password' });
        }
        return send(res, 200, { history, botConnected: Boolean(cfg.botUrl) });
      }

      if (req.method === 'GET' && url.pathname === '/api/config') {
        return send(res, 200, {
          footer: cfg.footer,
          needsPassword: Boolean(cfg.password),
          templates: Object.keys(TEMPLATES),
        });
      }

      if (req.method === 'GET' && url.pathname.startsWith('/i/')) {
        const img = images.get(url.pathname.slice(3));
        if (!img) return send(res, 404, 'Image expired');
        return send(res, 200, img.buf, { 'content-type': img.type, 'cache-control': 'public, max-age=86400' });
      }

      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, 'ok');

      if (req.method === 'GET') {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (file.includes('..')) return send(res, 400, 'Bad path');
        const buf = await readFile(new URL(file, PUBLIC_DIR)).catch(() => null);
        if (!buf) return send(res, 404, 'Not found');
        return send(res, 200, buf, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      }

      send(res, 405, 'Method not allowed');
    } catch (err) {
      console.error(err);
      send(res, err.status || 500, { error: err.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = config();
  createApp(cfg).listen(PORT, () => {
    console.log(`NBA poster on http://localhost:${PORT}`);
    if (!cfg.botUrl) console.log('WHATSAPP_BOT_URL not set — posts are dry-run (logged only)');
    if (!cfg.password) console.log('POSTER_PASSWORD not set — anyone with the URL can post!');
  });
}
