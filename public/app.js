import { TEMPLATES, buildCaption, missingFields } from './templates.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

let footer = '';
let media = null; // { kind: 'image'|'video', blob, url } — the selected photo/video
const MAX_VIDEO_MB = 100;
let current = store.get('template') in TEMPLATES ? store.get('template') : 'breaking';
const values = {}; // templateId → { field: value } so switching tabs keeps drafts

// ---------- Template tabs + fields ----------

function renderTabs() {
  $('tabs').innerHTML = '';
  for (const [id, t] of Object.entries(TEMPLATES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.label;
    b.setAttribute('aria-pressed', String(id === current));
    b.onclick = () => { current = id; store.set('template', id); renderTabs(); renderForm(); };
    $('tabs').append(b);
  }
}

function renderForm() {
  const form = $('form');
  form.innerHTML = '';
  values[current] ??= {};
  for (const f of TEMPLATES[current].fields) {
    const id = `f_${f.key}`;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = f.label;
    const input = document.createElement(f.type === 'textarea' ? 'textarea' : 'input');
    if (f.type !== 'textarea') input.type = 'text';
    input.id = id;
    input.placeholder = f.placeholder || '';
    input.value = values[current][f.key] || '';
    input.oninput = () => { values[current][f.key] = input.value; renderPreview(); };
    form.append(label, input);
  }
  renderPreview();
}

// ---------- WhatsApp-style preview ----------

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function waFormat(text) {
  return escapeHtml(text)
    .replace(/```([\s\S]+?)```/g, '<code>$1</code>')
    .replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=$|[\s).,!?:])/gm, '$1<b>$2</b>')
    .replace(/(^|[\s(])_(\S(?:[^_\n]*\S)?)_(?=$|[\s).,!?:])/gm, '$1<i>$2</i>')
    .replace(/(^|[\s(])~(\S(?:[^~\n]*\S)?)~(?=$|[\s).,!?:])/gm, '$1<s>$2</s>');
}

function currentCaption({ blank = '' } = {}) {
  return buildCaption(current, values[current] || {}, { footer, blank });
}

function renderPreview() {
  const caption = currentCaption({ blank: '…' });
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('preview').innerHTML =
    (media?.kind === 'image' ? `<img src="${media.url}" alt="Post image" />` : '') +
    (media?.kind === 'video' ? `<video src="${media.url}" controls muted playsinline></video>` : '') +
    `<div class="cap">${waFormat(caption) || '<span style="opacity:.5">Your post…</span>'}</div>` +
    `<div class="time">${time}</div>`;
  $('count').textContent = `${caption.length} characters`;
}

// ---------- Photo / video: pick / drop / paste ----------
// Photos are shrunk in the browser (long side ≤ 1600 px, same aspect ratio);
// videos are uploaded as-is and converted for WhatsApp on the server.

const EMPTY_DROP = '📷 Tap to add a photo or video, or drop / paste one here<br><small>Optional</small>';

async function loadMedia(file) {
  if (!file) return;
  if (file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|3gp)$/i.test(file.name || '')) {
    if (file.size > MAX_VIDEO_MB * 1024 * 1024) return setMsg(`❌ Video is too big (max ${MAX_VIDEO_MB} MB)`, 'err');
    setMedia({ kind: 'video', blob: file, url: URL.createObjectURL(file) });
    return;
  }
  if (!file.type.startsWith('image/')) return setMsg('❌ Only photos and videos can be added', 'err');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
  setMedia({ kind: 'image', blob, url: URL.createObjectURL(blob) });
}

function setMedia(m) {
  if (media) URL.revokeObjectURL(media.url);
  media = m;
  const tag = m.kind === 'video'
    ? `<video src="${m.url}" muted playsinline></video><small>🎬 ${(m.blob.size / 1024 / 1024).toFixed(1)} MB video · Tap to change · </small>`
    : `<img src="${m.url}" alt="Selected photo" /><small>Tap to change · </small>`;
  $('dropInner').innerHTML = `${tag}<small><a href="#" id="rmImg">remove</a></small>`;
  $('rmImg').onclick = (e) => { e.preventDefault(); e.stopPropagation(); clearMedia(); };
  renderPreview();
}

function clearMedia() {
  if (media) URL.revokeObjectURL(media.url);
  media = null;
  $('file').value = '';
  $('dropInner').innerHTML = EMPTY_DROP;
  renderPreview();
}

$('file').onchange = (e) => loadMedia(e.target.files[0]);
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); loadMedia(e.dataTransfer.files[0]); };
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/') || i.type.startsWith('video/'));
  if (item) loadMedia(item.getAsFile());
});

// ---------- Posting ----------

function setMsg(text, kind = '') {
  $('msg').textContent = text;
  $('msg').className = `msg ${kind}`;
}

function headers() {
  return { 'content-type': 'application/json', 'x-poster-password': $('pw').value };
}

// Upload the photo/video with a progress readout; resolves to its media id.
function uploadMedia() {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'api/media');
    xhr.setRequestHeader('content-type', media.blob.type || 'video/quicktime');
    xhr.setRequestHeader('x-poster-password', $('pw').value);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      setMsg(pct < 100 ? `Uploading ${media.kind}… ${pct}%`
        : media.kind === 'video' ? 'Converting video for WhatsApp… (can take a minute)' : 'Processing photo…');
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data.id);
      else reject(new Error(data.error || `Upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed — check your connection'));
    xhr.send(media.blob);
  });
}

function sendAtValue() {
  const v = $('sendAt').value;
  return v ? new Date(v).getTime() : null;
}

async function submit(mode) {
  const missing = missingFields(current, values[current]);
  if (missing.length) return setMsg(`Fill in: ${missing.join(', ')}`, 'err');
  const sendAt = mode === 'queue' ? sendAtValue() : null;
  if (sendAt && sendAt < Date.now() - 60 * 1000) return setMsg('❌ That "send at" time has already passed', 'err');
  if (mode === 'now' && !confirm('Post this to the WhatsApp channel right now?')) return;

  $('post').disabled = $('queue').disabled = true;
  try {
    const mediaId = media ? await uploadMedia() : null;
    setMsg(mode === 'now' ? 'Posting…' : 'Adding to queue…');
    const res = await fetch(mode === 'now' ? 'api/post' : 'api/queue', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ template: current, fields: values[current], mediaId, sendAt }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    store.set('pw', $('pw').value);
    if (mode === 'now') {
      setMsg(data.status === 'sent' ? `✅ Posted${data.to ? ` to ${data.to}` : ''}!` : `⚠️ ${data.status}`, data.status === 'sent' ? 'ok' : '');
    } else {
      setMsg(`✅ Queued · goes out ${fmtWhen(data.eta)}`, 'ok');
    }
    values[current] = {};
    $('sendAt').value = '';
    clearMedia();
    renderForm();
    loadHistory();
    loadQueue();
  } catch (err) {
    setMsg(`❌ ${err.message}`, 'err');
  } finally {
    $('post').disabled = $('queue').disabled = false;
  }
}

$('queue').onclick = () => submit('queue');
$('post').onclick = () => submit('now');

// ---------- Queue ----------

const INTERVALS = [30, 60, 90, 120, 180, 240, 360, 480, 720];
const fmtInterval = (m) => (m < 60 ? `${m} min` : `${m / 60} hour${m === 60 ? '' : 's'}`);
const fmtHour = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });

function fmtWhen(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (ms - Date.now() < 60 * 1000) return 'now';
  const today = new Date().toDateString() === d.toDateString();
  const tomorrow = new Date(Date.now() + 864e5).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return today ? `at ${time}` : tomorrow ? `tomorrow ${time}` : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

let queueSettingsDrawn = false;

function drawSettings(s) {
  if (!queueSettingsDrawn) {
    $('qInterval').innerHTML = INTERVALS.map((m) => `<option value="${m}">every ${fmtInterval(m)}</option>`).join('');
    const hours = [...Array(24).keys()].map((h) => `<option value="${h}">${fmtHour(h)}</option>`).join('');
    $('qStart').innerHTML = hours;
    $('qEnd').innerHTML = hours;
    queueSettingsDrawn = true;
  }
  if (!INTERVALS.includes(s.intervalMin)) {
    $('qInterval').insertAdjacentHTML('beforeend', `<option value="${s.intervalMin}">every ${fmtInterval(s.intervalMin)}</option>`);
  }
  $('qInterval').value = s.intervalMin;
  $('qStart').value = s.startHour;
  $('qEnd').value = s.endHour;
  $('qPause').textContent = s.paused ? '▶ Resume' : '⏸ Pause';
}

async function queueCall(path, method = 'GET', body) {
  const res = await fetch(path, { method, headers: headers(), body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function drawQueue(q) {
  drawSettings(q.settings);
  const n = q.items.length;
  let status = n ? `${n} post${n === 1 ? '' : 's'} waiting` : 'Queue is empty — add posts and they go out one at a time.';
  if (n && q.settings.paused) status += ' · ⏸ paused';
  else if (n) status += ` · next ${fmtWhen(q.items[0].eta)}`;
  if (q.settings.startHour !== q.settings.endHour) {
    const zone = q.timeZone?.split('/').pop().replace(/_/g, ' ');
    status += ` · only ${fmtHour(q.settings.startHour)}–${fmtHour(q.settings.endHour)}${zone ? ` ${zone} time` : ''}`;
  }
  if (q.error) status += ` · ⚠️ last send failed: ${q.error}`;
  $('qStatus').textContent = status;

  const flex = q.items.filter((it) => !it.sendAt).map((it) => it.id);
  $('qList').innerHTML = q.items.map((it, i) => {
    const label = TEMPLATES[it.template]?.label || it.template;
    const first = it.caption.split('\n').map((l) => l.replace(/[*_~]/g, '').trim()).filter(Boolean).slice(it.template === 'custom' ? 0 : 1, 4).join(' · ');
    const when = q.settings.paused ? 'paused' : fmtWhen(it.eta);
    const thumb = it.kind
      ? `<div class="thumb"><img alt="" data-src="api/queue/${it.id}/image" />${it.kind === 'video' ? `<span class="vbadge">▶ ${fmtDur(it.seconds)}</span>` : ''}</div>`
      : '<div class="noimg">Aa</div>';
    const k = flex.indexOf(it.id);
    const arrows = it.sendAt ? '' : `
          <button type="button" data-act="up" ${k === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button type="button" data-act="down" ${k === flex.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>`;
    return `<li data-id="${it.id}">
      ${thumb}
      <div class="qbody">
        <div class="qwhen">#${i + 1} · ${it.sendAt ? '📌 ' : ''}${escapeHtml(when)}${it.sendAt ? ' (set time)' : ''}</div>
        <div class="qtext"><b>${escapeHtml(label)}</b> — ${escapeHtml(first)}</div>
        <div class="qbtns">${arrows}
          <button type="button" data-act="time">⏰ ${it.sendAt ? 'Change time' : 'Set time'}</button>
          <button type="button" data-act="send">Send now</button>
          <button type="button" data-act="del" aria-label="Delete">✕</button>
        </div>
        <div class="qtime" hidden>
          <input type="datetime-local" value="${it.sendAt ? toLocalInput(it.sendAt) : ''}" aria-label="Send at" />
          <button type="button" data-act="time-save">Save</button>
          ${it.sendAt ? '<button type="button" data-act="time-clear">Use queue spacing</button>' : ''}
        </div>
      </div>
    </li>`;
  }).join('');
  // Thumbnails need the password header, so fetch them rather than <img src>.
  for (const img of $('qList').querySelectorAll('img[data-src]')) {
    fetch(img.dataset.src, { headers: headers() })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => { if (b) img.src = URL.createObjectURL(b); })
      .catch(() => {});
  }
}

const fmtDur = (sec) => (sec ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : '');

// ms → value for <input type="datetime-local"> in the viewer's own time zone.
function toLocalInput(ms) {
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

let editingTime = false; // don't redraw the list under an open time editor

async function loadQueue() {
  if (editingTime) return;
  try { drawQueue(await queueCall('api/queue')); } catch {}
}

$('qList').onclick = async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const li = btn.closest('li');
  const id = li.dataset.id;
  const act = btn.dataset.act;
  if (act === 'time') {
    const box = li.querySelector('.qtime');
    box.hidden = !box.hidden;
    editingTime = !box.hidden;
    if (!box.hidden) {
      const input = box.querySelector('input');
      const half = 30 * 60 * 1000; // default: the next :00 or :30, at least 30 min out
      if (!input.value) input.value = toLocalInput(Math.ceil((Date.now() + half) / half) * half);
      input.focus();
    }
    return;
  }
  if (act === 'time-save' || act === 'time-clear') {
    const v = li.querySelector('.qtime input').value;
    const sendAt = act === 'time-clear' ? null : v ? new Date(v).getTime() : null;
    if (act === 'time-save' && !sendAt) return setMsg('❌ Pick a date and time first', 'err');
    try {
      editingTime = false;
      drawQueue(await queueCall(`api/queue/${id}/time`, 'POST', { sendAt }));
      setMsg(sendAt ? `✅ Set to go out ${fmtWhen(sendAt)}` : '✅ Back to the queue spacing', 'ok');
    } catch (err) {
      setMsg(`❌ ${err.message}`, 'err');
    }
    return;
  }
  if (act === 'del' && !confirm('Delete this queued post?')) return;
  if (act === 'send' && !confirm('Send this post right now?')) return;
  btn.disabled = true;
  try {
    const q = act === 'del' ? await queueCall(`api/queue/${id}`, 'DELETE')
      : await queueCall(`api/queue/${id}/${act}`, 'POST');
    editingTime = false;
    drawQueue(q);
    if (act === 'send') { setMsg('✅ Sent from the queue', 'ok'); loadHistory(); }
  } catch (err) {
    setMsg(`❌ ${err.message}`, 'err');
    loadQueue();
  }
};

async function saveSettings(patch) {
  try { drawQueue(await queueCall('api/queue/settings', 'POST', patch)); }
  catch (err) { setMsg(`❌ ${err.message}`, 'err'); }
}
$('qInterval').onchange = () => saveSettings({ intervalMin: Number($('qInterval').value) });
$('qStart').onchange = () => saveSettings({ startHour: Number($('qStart').value) });
$('qEnd').onchange = () => saveSettings({ endHour: Number($('qEnd').value) });
$('qPause').onclick = () => saveSettings({ paused: $('qPause').textContent.includes('Pause') });

$('clear').onclick = () => { values[current] = {}; $('sendAt').value = ''; clearMedia(); renderForm(); setMsg(''); };

$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(currentCaption()); setMsg('Copied', 'ok'); }
  catch { setMsg('Copy failed — select the preview text manually', 'err'); }
};

async function loadHistory() {
  const res = await fetch('api/history', { headers: headers() }).catch(() => null);
  if (!res?.ok) return;
  const { history } = await res.json();
  $('history').innerHTML = history.length
    ? history.map((h) => `<li>${new Date(h.at).toLocaleString()} · ${escapeHtml(TEMPLATES[h.template]?.label || h.template)} · ${escapeHtml(h.status)}</li>`).join('')
    : '<li>Nothing yet</li>';
}

// ---------- WhatsApp link ----------

const WA_LABEL = {
  connected: '🟢 WhatsApp connected',
  connecting: '🟡 Connecting to WhatsApp…',
  needs_link: '🔴 WhatsApp not linked',
  pairing: '🟡 Waiting for pairing code…',
};

async function loadWhatsApp() {
  const res = await fetch('api/whatsapp', { headers: headers() }).catch(() => null);
  if (res?.status === 401) {
    $('waStatus').textContent = 'Enter the password to see the WhatsApp status.';
    $('status').textContent = '';
    return;
  }
  if (!res?.ok) return;
  const wa = await res.json();
  let text = WA_LABEL[wa.state] || wa.state;
  if (wa.error) text += ` · ⚠️ ${wa.error}`;
  if (wa.dryRun) text += ' · dry-run on';
  $('waStatus').textContent = text;
  $('status').textContent = WA_LABEL[wa.state] || '';
  $('waLink').hidden = !['needs_link', 'pairing'].includes(wa.state);
  drawChannel(wa);
  if (wa.pairingCode) {
    $('pairCode').hidden = false;
    $('code').textContent = wa.pairingCode.replace(/^(.{4})(.{4})$/, '$1-$2');
  } else {
    $('pairCode').hidden = true;
  }
}

function drawChannel(wa) {
  $('waChannel').hidden = wa.state !== 'connected';
  const ch = wa.channel;
  if (!ch) {
    $('chNow').innerHTML = '⚠️ <b>No channel set yet</b> — paste the link below.';
  } else {
    const name = escapeHtml(ch.name || 'checking…');
    const verdict = ch.canPost === true ? '✅ can post'
      : ch.canPost === false ? '❌ only a follower — make this account an admin'
      : '';
    $('chNow').innerHTML = `Posting to <b>${name}</b>${verdict ? ` · ${verdict}` : ''}`;
  }
  // Prefill once, but never overwrite what someone is typing.
  if (ch?.link && !$('chLink').value && document.activeElement !== $('chLink')) $('chLink').value = ch.link;
}

$('chSave').onclick = async () => {
  $('chSave').disabled = true;
  $('chNow').textContent = 'Checking channel…';
  try {
    const res = await fetch('api/whatsapp/channel', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ link: $('chLink').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setMsg(data.channel.canPost === false
      ? `⚠️ Saved "${data.channel.name}", but this account is only a follower — posts will fail until it's an admin`
      : `✅ Channel set: ${data.channel.name}`, data.channel.canPost === false ? 'err' : 'ok');
    await loadWhatsApp();
  } catch (err) {
    $('chNow').textContent = `❌ ${err.message}`;
  } finally {
    $('chSave').disabled = false;
  }
};

$('pair').onclick = async () => {
  $('pair').disabled = true;
  try {
    const res = await fetch('api/whatsapp/pair', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ phone: $('phone').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await loadWhatsApp();
  } catch (err) {
    $('waStatus').textContent = `❌ ${err.message}`;
  } finally {
    $('pair').disabled = false;
  }
};

// ---------- Boot ----------

const cfg = await fetch('api/config').then((r) => r.json()).catch(() => ({}));
footer = cfg.footer || '';
if (cfg.needsPassword) {
  $('pwWrap').hidden = false;
  $('pw').value = store.get('pw') || '';
  $('pw').onchange = () => { store.set('pw', $('pw').value); loadHistory(); loadWhatsApp(); loadQueue(); };
}
renderTabs();
renderForm();
loadHistory();
loadWhatsApp();
loadQueue();
setInterval(loadWhatsApp, 4000);
setInterval(loadQueue, 30000);
