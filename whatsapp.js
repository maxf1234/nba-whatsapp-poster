// WhatsApp connection (Baileys) — same library and pairing-code login as the
// DealsPulse bot, but driven from the web page: the pairing code shows up on
// the poster instead of only in Railway logs.
//
// Auth lives in AUTH_DIR (a Railway volume) so linking is a one-time thing.

import { rm } from 'node:fs/promises';

// Baileys wants a pino-like logger; a silent no-op keeps logs clean.
const logger = {
  level: 'silent',
  child: () => logger,
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

const isJid = (s) => /@(newsletter|g\.us)$/.test(s);
const channelInviteCode = (s) => s.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i)?.[1] ?? null;

export function createWhatsApp({ authDir, target }) {
  let baileys; // lazy-loaded so tests and dry-run never touch the network
  let sock = null;
  let state = 'connecting'; // connecting | needs_link | pairing | connected
  let pairingCode = null;
  let targetJid = isJid(target) ? target : null;
  let targetName = null;
  let lastError = null;

  async function connect() {
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
        resolveTarget().catch((e) => { lastError = e.message; });
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

  // Channel invite link → @newsletter id (needs a live connection). Posting
  // to a channel requires the linked account to be its owner or an admin.
  async function resolveTarget() {
    if (!target) throw new Error('WHATSAPP_CHANNEL is not set');
    if (targetJid && targetName) return targetJid;
    const code = channelInviteCode(target);
    if (!targetJid && !code) throw new Error('WHATSAPP_CHANNEL must be a channel link or an @newsletter / @g.us id');
    const meta = code
      ? await sock.newsletterMetadata('invite', code)
      : targetJid.endsWith('@newsletter')
        ? await sock.newsletterMetadata('jid', targetJid).catch(() => null)
        : await sock.groupMetadata(targetJid).catch(() => null);
    if (code && !meta?.id) throw new Error('Channel link did not resolve — check WHATSAPP_CHANNEL');
    targetJid ??= meta.id;
    targetName = meta?.thread_metadata?.name?.text ?? meta?.name ?? meta?.subject ?? targetJid;
    console.log(`Posting to ${targetName} (${targetJid})`);
    return targetJid;
  }

  return {
    connect,

    status: () => ({ state, pairingCode, target: targetName, error: lastError }),

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
      const jid = await resolveTarget();
      await sock.sendMessage(jid, image ? { image: image.buf, mimetype: image.type, caption } : { text: caption });
      return targetName;
    },
  };
}
