// NBA channel poster: a tiny web form that posts straight to a WhatsApp
// channel from its own linked WhatsApp account.
//
// Pick a template, drop an image, fill the fields, hit Post. The server
// builds the caption from the shared template (so the channel format never
// drifts) and sends it through Baileys (whatsapp.js). Linking is done from
// the page with a pairing code.
//
// `npm start`

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';
import { buildCaption, missingFields, TEMPLATES } from './public/templates.js';
import { createWhatsApp } from './whatsapp.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = new URL('./public/', import.meta.url);
const MAX_BODY = 12 * 1024 * 1024; // base64 image + fields
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const history = []; // last few posts, newest first

export function config(env = process.env) {
  return {
    password: env.POSTER_PASSWORD || '',
    footer: (env.POST_FOOTER ?? '').replace(/\\n/g, '\n'),
    channel: (env.WHATSAPP_CHANNEL || '').trim(),
    // Railway volume mounted at /data keeps the WhatsApp login across deploys.
    authDir: env.AUTH_DIR || (env.RAILWAY_ENVIRONMENT ? '/data/baileys_auth' : './baileys_auth'),
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

async function handlePost(req, res, cfg, wa) {
  const { template, fields, image } = await readJson(req);

  const missing = missingFields(template, fields);
  if (missing.length) return send(res, 400, { error: `Missing: ${missing.join(', ')}` });

  const caption = buildCaption(template, fields, { footer: cfg.footer });

  let img;
  if (image) {
    img = parseDataUrl(image);
    if (!img) return send(res, 400, { error: 'Image must be JPEG, PNG or WebP' });
  }

  const entry = { at: new Date().toISOString(), template, caption, status: 'sent' };

  if (cfg.dryRun) {
    entry.status = 'dry-run (DRY_RUN is on)';
    console.log(`[dry-run] ${template}${img ? ' + image' : ''}\n${caption}\n`);
  } else {
    entry.to = await wa.send({ caption, image: img });
  }

  history.unshift(entry);
  history.length = Math.min(history.length, 20);
  return send(res, 200, { ok: true, ...entry });
}

export function createApp(cfg = config(), wa = createWhatsApp({ authDir: cfg.authDir, target: cfg.channel })) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const authed = () => checkPassword(req.headers['x-poster-password'], cfg.password);
    try {
      if (url.pathname.startsWith('/api/') && url.pathname !== '/api/config' && !authed()) {
        return send(res, 401, { error: 'Wrong password' });
      }

      if (req.method === 'POST' && url.pathname === '/api/post') return await handlePost(req, res, cfg, wa);

      if (req.method === 'GET' && url.pathname === '/api/history') return send(res, 200, { history });

      if (req.method === 'GET' && url.pathname === '/api/whatsapp') {
        return send(res, 200, { ...wa.status(), dryRun: cfg.dryRun, channelSet: Boolean(cfg.channel) });
      }

      if (req.method === 'POST' && url.pathname === '/api/whatsapp/pair') {
        const { phone } = await readJson(req);
        return send(res, 200, { pairingCode: await wa.requestPairingCode(phone) });
      }

      if (req.method === 'GET' && url.pathname === '/api/config') {
        return send(res, 200, {
          footer: cfg.footer,
          needsPassword: Boolean(cfg.password),
          templates: Object.keys(TEMPLATES),
        });
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
      if (!err.status) console.error(err);
      send(res, err.status || 500, { error: err.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = config();
  const wa = createWhatsApp({ authDir: cfg.authDir, target: cfg.channel });
  createApp(cfg, wa).listen(PORT, () => {
    console.log(`NBA poster on http://localhost:${PORT}`);
    if (cfg.dryRun) console.log('DRY_RUN is on — posts are logged, not sent');
    if (!cfg.channel) console.log('WHATSAPP_CHANNEL not set — set it to the channel invite link');
    if (!cfg.password) console.log('POSTER_PASSWORD not set — anyone with the URL can post!');
  });
  wa.connect().catch((e) => console.error('WhatsApp failed to start:', e.message));
}
