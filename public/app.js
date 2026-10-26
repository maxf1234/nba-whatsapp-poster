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

function currentCaption() {
  return buildCaption(current, values[current] || {}, { footer });
}

function renderPreview() {
  const caption = currentCaption();
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

$('post').onclick = async () => {
  const missing = missingFields(current, values[current]);
  if (missing.length) return setMsg(`Fill in: ${missing.join(', ')}`, 'err');
  if (!confirm('Post this to the WhatsApp channel?')) return;

  $('post').disabled = true;
  setMsg('Posting…');
  try {
    const res = await fetch('api/post', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ template: current, fields: values[current], image: imageData }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    store.set('pw', $('pw').value);
    setMsg(data.status === 'sent' ? '✅ Posted!' : `⚠️ ${data.status}`, data.status === 'sent' ? 'ok' : '');
    values[current] = {};
    clearImage();
    renderForm();
    loadHistory();
  } catch (err) {
    setMsg(`❌ ${err.message}`, 'err');
  } finally {
    $('post').disabled = false;
  }
};

$('clear').onclick = () => { values[current] = {}; clearImage(); renderForm(); setMsg(''); };

$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(currentCaption()); setMsg('Copied', 'ok'); }
  catch { setMsg('Copy failed — select the preview text manually', 'err'); }
};

async function loadHistory() {
  const res = await fetch('api/history', { headers: headers() }).catch(() => null);
  if (!res?.ok) return;
  const { history, botConnected } = await res.json();
  $('status').textContent = botConnected ? '🟢 Bot connected' : '🟡 Dry-run (no bot URL)';
  $('history').innerHTML = history.length
    ? history.map((h) => `<li>${new Date(h.at).toLocaleString()} · ${escapeHtml(TEMPLATES[h.template]?.label || h.template)} · ${escapeHtml(h.status)}</li>`).join('')
    : '<li>Nothing yet</li>';
}

// ---------- Boot ----------

const cfg = await fetch('api/config').then((r) => r.json()).catch(() => ({}));
footer = cfg.footer || '';
if (cfg.needsPassword) {
  $('pwWrap').hidden = false;
  $('pw').value = store.get('pw') || '';
  $('pw').onchange = loadHistory;
}
renderTabs();
renderForm();
loadHistory();
