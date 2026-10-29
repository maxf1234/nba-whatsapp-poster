// WhatsApp connection (Baileys) — same library and pairing-code login as the
// DealsPulse bot, but driven from the web page: the pairing code shows up on
// the poster instead of only in Railway logs.
//
// Auth lives in AUTH_DIR (a Railway volume) so linking is a one-time thing.
// The channel to post to is set from the page (saved to channelFile) or
// falls back to WHATSAPP_CHANNEL.

import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// Baileys wants a pino-like logger; a silent no-op keeps logs clean.
const logger = {
  level: 'silent',
  child: () => logger,
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

const isJid = (s) => /@(newsletter|g\.us)$/.test(s);
export const channelInviteCode = (s) => s.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i)?.[1] ?? null;
const err = (message, status) => Object.assign(new Error(message), { status });

// Only owners and admins can post to a WhatsApp channel.
const canPostAs = (role) => (role ? ['OWNER', 'ADMIN'].includes(String(role).toUpperCase()) : null);

// `socket` is for tests: a fake, already-connected Baileys socket.
export function createWhatsApp({ authDir, target = '', channelFile, socket = null }) {
  let baileys; // lazy-loaded so tests and dry-run never touch the network
  let sock = socket;
  let state = socket ? 'connected' : 'connecting'; // connecting | needs_link | pairing | connected
  let pairingCode = null;
  let channel = null; // { jid, name, role, canPost } for the current target
  let lastError = null;

  // Look a channel link / id up on WhatsApp (needs a live connection).
  async function lookup(input) {
    const code = channelInviteCode(input);
    if (!code && !isJid(input)) {
      throw err('Paste the channel link (WhatsApp → channel → ⋯ → Share → Copy link)', 400);
    }
    if (input.endsWith('@g.us')) {
      const meta = await sock.groupMetadata(input).catch(() => null);
      if (!meta) throw err('Group not found, or this WhatsApp account is not in it', 404);
      return { jid: input, name: meta.subject || input, role: null, canPost: true };
    }
    const meta = await sock.newsletterMetadata(code ? 'invite' : 'jid', code || input).catch((e) => {
      throw err(`Could not look up that channel: ${e.message}`, 404);
    });
    if (!meta?.id) throw err('Channel not found — check the link', 404);
    const role = meta.viewer_metadata?.role ?? null;
    return { jid: meta.id, name: meta.thread_metadata?.name?.text || meta.id, role, canPost: canPostAs(role) };
  }

  async function ensureChannel() {
    if (!target) throw err('No channel set — paste the channel link in the WhatsApp card', 400);
    if (!channel) {
      channel = await lookup(target);
      console.log(`Posting to ${channel.name} (${channel.jid}) as ${channel.role ?? 'unknown role'}`);
    }
    return channel;
  }

  async function connect() {
    if (channelFile) {
      try {
        target = JSON.parse(await readFile(channelFile, 'utf8')).target || target;
      } catch {} // nothing saved yet: keep WHATSAPP_CHANNEL
    }
    baileys ??= await import('@whiskeysockets/baileys');
    const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = baileys;
    const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (e) {
      console.warn(`Could not fetch latest WA version (${e.message}); using bundled default.`);
    }

    sock = makeWASocket({
      auth,
      version,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    sock.ev.on('creds.update', saveCreds);
    if (!sock.authState.creds.registered && state !== 'pairing') state = 'needs_link';

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        state = 'connected';
        pairingCode = null;
        lastError = null;
        console.log('WhatsApp connected');
        if (target) ensureChannel().catch((e) => { lastError = e.message; });
      } else if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === baileys.DisconnectReason.loggedOut) {
          // Unlinked from the phone: wipe the session so the page can relink.
          console.warn('Logged out by WhatsApp — clearing session, relink from the page.');
          await rm(authDir, { recursive: true, force: true });
          state = 'needs_link';
          pairingCode = null;
        } else if (state === 'connected') {
          state = 'connecting';
        }
        console.warn(`WhatsApp connection closed (code ${code}). Reconnecting in 5s…`);
        setTimeout(() => connect().catch((e) => console.error('Reconnect failed:', e.message)), 5000);
      }
    });
  }

  return {
    connect,

    status: () => ({
      state,
      pairingCode,
      target: channel?.name ?? null,
      channel: target ? { link: target, name: channel?.name ?? null, role: channel?.role ?? null, canPost: channel?.canPost ?? null } : null,
      error: lastError,
    }),

    // Set the channel from the page: look it up, check this account may
    // post there, then save it so it sticks across restarts.
    async setChannel(input) {
      const link = String(input ?? '').trim();
      if (state !== 'connected') throw err('Link WhatsApp first, then set the channel', 409);
      const found = await lookup(link);
      target = link;
      channel = found;
      lastError = null;
      if (channelFile) {
        await mkdir(dirname(channelFile), { recursive: true });
        await writeFile(channelFile, JSON.stringify({ target: link }));
      }
      console.log(`Channel set: ${found.name} (${found.jid}) as ${found.role ?? 'unknown role'}`);
      return found;
    },

    // Digits only, with country code. Returns the 8-character code the user
    // types on their phone: Linked Devices → Link a Device → "Link with phone
    // number instead".
    async requestPairingCode(phone) {
      const digits = String(phone ?? '').replace(/\D/g, '');
      if (digits.length < 8) throw Object.assign(new Error('Enter the full number with country code'), { status: 400 });
      if (state === 'connected') throw Object.assign(new Error('Already linked'), { status: 409 });
      if (!sock) throw Object.assign(new Error('Still starting up — try again in a few seconds'), { status: 503 });
      pairingCode = await sock.requestPairingCode(digits);
      state = 'pairing';
      return pairingCode;
    },

    async send({ caption, image }) {
      if (state !== 'connected') {
        throw Object.assign(new Error('WhatsApp is not linked yet — link it first'), { status: 503 });
      }
      const ch = await ensureChannel();
      if (ch.canPost === false) {
        throw err(`This WhatsApp account is only a follower of "${ch.name}" — make it an admin of the channel to post`, 403);
      }
      await sock.sendMessage(ch.jid, image ? { image: image.buf, mimetype: image.type, caption } : { text: caption });
      return ch.name;
    },
  };
}
