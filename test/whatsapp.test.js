import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWhatsApp } from '../whatsapp.js';

const LINK = 'https://whatsapp.com/channel/0029VaNBA';

function fakeSocket(role) {
  const sent = [];
  return {
    sent,
    newsletterMetadata: async (type, key) => {
      if (key !== '0029VaNBA' && key !== '123@newsletter') throw new Error('not found');
      return { id: '123@newsletter', thread_metadata: { name: { text: 'NBA Daily' } }, viewer_metadata: { role } };
    },
    sendMessage: async (jid, msg) => { sent.push({ jid, msg }); },
  };
}

async function tmp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wa-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('setChannel looks up the link, reports the role and saves it', async (t) => {
  const dir = await tmp(t);
  const socket = fakeSocket('OWNER');
  const wa = createWhatsApp({ authDir: dir, channelFile: join(dir, 'channel.json'), socket });

  assert.equal(wa.status().channel, null);
  const ch = await wa.setChannel(` ${LINK} `);
  assert.deepEqual(ch, { jid: '123@newsletter', name: 'NBA Daily', role: 'OWNER', canPost: true });
  assert.deepEqual(wa.status().channel, { link: LINK, name: 'NBA Daily', role: 'OWNER', canPost: true });
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'channel.json'), 'utf8')), { target: LINK });

  assert.equal(await wa.send({ caption: 'hi' }), 'NBA Daily');
  assert.deepEqual(socket.sent, [{ jid: '123@newsletter', msg: { text: 'hi' } }]);
});

test('rejects bad links and unknown channels', async (t) => {
  const dir = await tmp(t);
  const wa = createWhatsApp({ authDir: dir, socket: fakeSocket('ADMIN') });
  await assert.rejects(wa.setChannel('NBA Daily'), /Paste the channel link/);
  await assert.rejects(wa.setChannel('https://whatsapp.com/channel/nope'), /Could not look up/);
  assert.equal(wa.status().channel, null, 'a failed lookup does not replace the channel');
});

test('a follower-only account gets a clear error instead of a silent failure', async (t) => {
  const dir = await tmp(t);
  const socket = fakeSocket('SUBSCRIBER');
  const wa = createWhatsApp({ authDir: dir, socket });
  const ch = await wa.setChannel(LINK);
  assert.equal(ch.canPost, false);
  await assert.rejects(wa.send({ caption: 'hi' }), (e) => e.status === 403 && /admin/.test(e.message));
  assert.equal(socket.sent.length, 0);
});

test('no channel set: sending says so', async (t) => {
  const wa = createWhatsApp({ authDir: await tmp(t), socket: fakeSocket('OWNER') });
  await assert.rejects(wa.send({ caption: 'hi' }), /No channel set/);
});

test('env WHATSAPP_CHANNEL still works as the default', async (t) => {
  const socket = fakeSocket('ADMIN');
  const wa = createWhatsApp({ authDir: await tmp(t), target: LINK, socket });
  assert.equal(await wa.send({ caption: 'hi' }), 'NBA Daily');
});
