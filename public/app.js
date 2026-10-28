import { TEMPLATES, buildCaption, missingFields } from './templates.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

let footer = '';
let imageData = null; // resized JPEG data URL
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
    (imageData ? `<img src="${imageData}" alt="Post image" />` : '') +
    `<div class="cap">${waFormat(caption) || '<span style="opacity:.5">Your post…</span>'}</div>` +
    `<div class="time">${time}</div>`;
  $('count').textContent = `${caption.length} characters`;
}

// ---------- Image: pick / drop / paste, resized client-side ----------

async function loadImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  imageData = canvas.toDataURL('image/jpeg', 0.88);
  $('dropInner').innerHTML =
    `<img src="${imageData}" alt="Selected image" /><small>Tap to change · </small>` +
    `<small><a href="#" id="rmImg">remove</a></small>`;
  $('rmImg').onclick = (e) => { e.preventDefault(); e.stopPropagation(); clearImage(); };
  renderPreview();
}

function clearImage() {
  imageData = null;
  $('file').value = '';
  $('dropInner').innerHTML = '📷 Tap to add an image, or drop / paste one here<br><small>Optional</small>';
  renderPreview();
}

$('file').onchange = (e) => loadImage(e.target.files[0]);
const drop = $('drop');
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); loadImage(e.dataTransfer.files[0]); };
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) loadImage(item.getAsFile());
});

// ---------- Posting ----------

function setMsg(text, kind = '') {
  $('msg').textContent = text;
  $('msg').className = `msg ${kind}`;
}

function headers() {
  return { 'content-type': 'application/json', 'x-poster-password': $('pw').value };
}

async function submit(mode) {
  const missing = missingFields(current, values[current]);
  if (missing.length) return setMsg(`Fill in: ${missing.join(', ')}`, 'err');
  if (mode === 'now' && !confirm('Post this to the WhatsApp channel right now?')) return;

  $('post').disabled = $('queue').disabled = true;
  setMsg(mode === 'now' ? 'Posting…' : 'Adding to queue…');
  try {
    const res = await fetch(mode === 'now' ? 'api/post' : 'api/queue', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ template: current, fields: values[current], image: imageData }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    store.set('pw', $('pw').value);
    if (mode === 'now') {
      setMsg(data.status === 'sent' ? `✅ Posted${data.to ? ` to ${data.to}` : ''}!` : `⚠️ ${data.status}`, data.status === 'sent' ? 'ok' : '');
    } else {
      setMsg(`✅ Queued as #${data.position} · goes out ${fmtWhen(data.eta)}`, 'ok');
    }
    values[current] = {};
    clearImage();
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

  $('qList').innerHTML = q.items.map((it, i) => {
    const label = TEMPLATES[it.template]?.label || it.template;
    const first = it.caption.split('\n').map((l) => l.replace(/[*_~]/g, '').trim()).filter(Boolean).slice(it.template === 'custom' ? 0 : 1, 4).join(' · ');
    return `<li data-id="${it.id}">
      ${it.hasImage ? `<img alt="" data-src="api/queue/${it.id}/image" />` : '<div class="noimg">Aa</div>'}
      <div class="qbody">
        <div class="qwhen">#${i + 1} · ${q.settings.paused ? 'paused' : escapeHtml(fmtWhen(it.eta))}</div>
        <div class="qtext"><b>${escapeHtml(label)}</b> — ${escapeHtml(first)}</div>
        <div class="qbtns">
          <button type="button" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button type="button" data-act="down" ${i === n - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          <button type="button" data-act="send">Send now</button>
          <button type="button" data-act="del" aria-label="Delete">✕</button>
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

async function loadQueue() {
  try { drawQueue(await queueCall('api/queue')); } catch {}
}

$('qList').onclick = async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  const act = btn.dataset.act;
  if (act === 'del' && !confirm('Delete this queued post?')) return;
  if (act === 'send' && !confirm('Send this post right now?')) return;
  btn.disabled = true;
  try {
    const q = act === 'del' ? await queueCall(`api/queue/${id}`, 'DELETE')
      : await queueCall(`api/queue/${id}/${act}`, 'POST');
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

$('clear').onclick = () => { values[current] = {}; clearImage(); renderForm(); setMsg(''); };

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
  if (wa.state === 'connected' && wa.target) text += ` · posting to ${wa.target}`;
  if (wa.state === 'connected' && !wa.channelSet) text += ' · ⚠️ WHATSAPP_CHANNEL not set';
  if (wa.error) text += ` · ⚠️ ${wa.error}`;
  if (wa.dryRun) text += ' · dry-run on';
  $('waStatus').textContent = text;
  $('status').textContent = WA_LABEL[wa.state] || '';
  $('waLink').hidden = !['needs_link', 'pairing'].includes(wa.state);
  if (wa.pairingCode) {
    $('pairCode').hidden = false;
    $('code').textContent = wa.pairingCode.replace(/^(.{4})(.{4})$/, '$1-$2');
  } else {
    $('pairCode').hidden = true;
  }
}

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
