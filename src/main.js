import './style.css';
import { buildSheets, canEmbedVector } from './compose.js';
import { editCrop } from './crop-editor.js';
import { detectLabels } from './detect.js';
import { SUPPORTED_PER_PAGE, chunk, gridFor } from './layout.js';
import { closePdf, cropCanvas, isPasswordError, openPdf, readPage, renderPage, viewCropToPdfBox } from './pdf-read.js';
import { drawSheetPreview } from './preview.js';
import * as store from './store.js';

const PREVIEW_SCALE = 1.5;
const PRINT_SCALE = 300 / 72;
const PLATFORMS = ['amazon', 'meesho', 'flipkart', 'unknown'];
const SETTINGS_KEY = 'label-cropper-settings';

const files = new Map(); // fileKey -> { name, bytes, doc, vector }
let labels = []; // { key, fileId, pageIndex, index, perPage, platform, crop, skip, reason, thumb }
let filter = 'all';
let sheetIndex = 0;
let busy = false;

const $ = (sel) => document.querySelector(sel);
const dropZone = $('#drop');
const fileInput = $('#file-input');
const grid = $('#grid');
const errors = $('#errors');
const perPageSelect = $('#per-page');
const cutLinesInput = $('#cut-lines');
const previewCanvas = $('#preview');
const $$ = (sel) => [...document.querySelectorAll(sel)];
const isIOS =
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /android/i.test(navigator.userAgent);
// Mobile action bar and desktop panel each have their own copy of these.
const downloadButtons = $$('.js-download');
const shareButtons = $$('.js-share');

// ---------- settings ----------

for (const n of SUPPORTED_PER_PAGE) {
  const { cols, rows } = gridFor(n);
  const empty = cols * rows - n;
  perPageSelect.append(new Option(`${n} label${n > 1 ? 's' : ''}  ·  ${cols} × ${rows}${empty ? ` (${empty} empty)` : ''}`, n));
}
const saved = loadSettings();
perPageSelect.value = String(saved.perPage ?? 4);
cutLinesInput.checked = saved.cutLines ?? true;

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
  } catch {
    return {};
  }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ perPage: perPage(), cutLines: cutLinesInput.checked }));
}
const perPage = () => Number(perPageSelect.value);

perPageSelect.addEventListener('change', () => {
  saveSettings();
  sheetIndex = 0;
  updateSummary();
});
cutLinesInput.addEventListener('change', () => {
  saveSettings();
  updatePreview();
});

// ---------- adding files ----------

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  addFiles([...fileInput.files]);
  fileInput.value = '';
});
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('over');
  addFiles([...e.dataTransfer.files]);
});

// ---------- pasting a copied PDF ----------
// iPhone can't put a web app in WhatsApp's share menu, but WhatsApp → Share → Copy puts
// the PDF on the clipboard. Long-pressing the paste box brings up iOS's "Paste" menu.

const pasteBox = $('#paste-box');
pasteBox.dataset.placeholder = isIOS || isAndroid ? 'Copied a PDF? Long-press here → Paste' : 'Copied a PDF? Click here and press Ctrl+V';
if (isIOS) {
  $('#share-hint-text').innerHTML = 'From WhatsApp: PDF → <b>Share</b> → <b>Copy</b>, then paste it above';
}
// Nothing may be typed or dropped in; it only exists to receive a paste.
pasteBox.addEventListener('beforeinput', (e) => e.preventDefault());
pasteBox.addEventListener('drop', (e) => e.preventDefault());

document.addEventListener('paste', async (e) => {
  const pasted = clipboardFiles(e.clipboardData);
  // Text pasted anywhere but the paste box is left alone.
  if (!pasted.length && e.target !== pasteBox && !pasteBox.contains(e.target)) return;
  e.preventDefault();
  pasteBox.textContent = '';
  pasteBox.blur();
  const pdfs = (await Promise.all(pasted.map(asPdf))).filter(Boolean);
  if (pdfs.length) addFiles(pdfs);
  else if (pasted.length) toast('Only PDF files are supported');
  else toast('No PDF copied — in WhatsApp tap Share → Copy first');
});

function clipboardFiles(data) {
  if (!data) return [];
  if (data.files?.length) return [...data.files];
  return [...(data.items ?? [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
}

// Pasted files can arrive without a name or type, so check the bytes themselves.
async function asPdf(f) {
  const head = new Uint8Array(await f.slice(0, 1024).arrayBuffer());
  if (!new TextDecoder('latin1').decode(head).includes('%PDF-')) return null;
  const name = f.name && f.name.toLowerCase().endsWith('.pdf') ? f.name : `${f.name?.replace(/\.[^.]*$/, '') || 'Pasted label'}.pdf`;
  return new File([f], name, { type: 'application/pdf' });
}

const isPdf = (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');

// New files are appended to what's already loaded — nothing is ever replaced.
async function addFiles(list) {
  const pdfs = list.filter(isPdf);
  const fresh = [];
  let duplicates = 0;
  for (const f of pdfs) {
    const key = store.fileKey(f.name, f.size);
    if (files.has(key) || fresh.some((r) => r.key === key)) duplicates++;
    else fresh.push({ key, name: f.name, size: f.size, blob: f, addedAt: Date.now() + fresh.length });
  }
  if (list.length > pdfs.length) toast('Only PDF files are supported');
  if (duplicates) toast(`${duplicates} file${duplicates > 1 ? 's are' : ' is'} already added`);
  if (!fresh.length) return;
  await Promise.all(fresh.map((r) => store.saveFile(r)));
  const added = await processRecords(fresh, new Map());
  if (added) toast(`${added} label${added > 1 ? 's' : ''} added`);
}

// Restores everything saved earlier (including files shared from WhatsApp by the
// service worker while the app was closed).
async function restore() {
  const [records, overrides] = await Promise.all([store.listFiles(), store.listOverrides()]);
  const pending = records.filter((r) => !files.has(r.key));
  if (pending.length) await processRecords(pending, overrides);
}

async function processRecords(records, overrides) {
  busy = true;
  updateSummary();
  let added = 0;
  for (const [i, record] of records.entries()) {
    try {
      added += await addFile(record, overrides, (page, total) =>
        showProgress(record.name, i, records.length, page, total),
      );
    } catch (err) {
      const msg = isPasswordError(err) ? 'PDF is password-protected' : `could not read (${err.message})`;
      showError(`${record.name}: ${msg}`);
      files.delete(record.key);
      await store.deleteFile(record.key);
    }
    render();
  }
  $('#progress').hidden = true;
  busy = false;
  updateSummary();
  return added;
}

async function addFile(record, overrides, onPage) {
  const bytes = new Uint8Array(await record.blob.arrayBuffer());
  const doc = await openPdf(bytes);
  const fileId = record.key;
  files.set(fileId, { name: record.name, bytes, doc, vector: await canEmbedVector(bytes) });

  let added = 0;
  for (let i = 0; i < doc.numPages; i++) {
    onPage(i, doc.numPages);
    const page = await doc.getPage(i + 1);
    const info = await readPage(page, PREVIEW_SCALE);
    const found = detectLabels(info);
    for (const [index, result] of found.entries()) {
      const key = store.labelKey(fileId, i, index);
      const saved = overrides.get(key) ?? {};
      const crop = saved.crop ?? result.crop;
      const label = {
        key,
        fileId,
        pageIndex: i,
        index, // position on the page, for pages holding several labels
        perPage: found.length,
        platform: result.platform,
        crop,
        cropEdited: !!saved.crop,
        skip: saved.skip ?? result.skip,
        reason: saved.skip === undefined ? result.reason : undefined,
        thumb: cropCanvas(info.canvas, crop, PREVIEW_SCALE),
      };
      labels.push(label);
      if (!label.skip) added++;
    }
    page.cleanup();
  }
  return added;
}

function persistLabel(label) {
  const value = { skip: label.skip };
  if (label.cropEdited) value.crop = label.crop;
  store.saveOverride(label.key, value);
}

function showProgress(name, fileIndex, fileCount, page, pageCount) {
  $('#progress').hidden = false;
  $('#progress-label').textContent = `${name} — page ${page + 1} / ${pageCount}`;
  $('#progress-count').textContent = fileCount > 1 ? `${fileIndex + 1} / ${fileCount}` : '';
  $('#progress-bar').style.width = `${((fileIndex + page / pageCount) / fileCount) * 100}%`;
}

function showError(text) {
  const li = document.createElement('li');
  li.textContent = text;
  errors.append(li);
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ---------- label grid ----------

function visibleLabels() {
  if (filter === 'all') return labels;
  if (filter === 'skipped') return labels.filter((l) => l.skip);
  return labels.filter((l) => l.platform === filter);
}

function renderFilters() {
  const counts = { all: labels.length, skipped: labels.filter((l) => l.skip).length };
  for (const p of PLATFORMS) counts[p] = labels.filter((l) => l.platform === p).length;
  if (filter !== 'all' && !counts[filter]) filter = 'all';

  const chips = [
    ['all', 'All'],
    ...PLATFORMS.filter((p) => counts[p]).map((p) => [p, capitalize(p)]),
    ...(counts.skipped ? [['skipped', 'Skipped']] : []),
  ];
  const box = $('#filters');
  box.innerHTML = '';
  for (const [key, text] of chips) {
    const chip = document.createElement('button');
    chip.className = `chip${filter === key ? ' active' : ''}`;
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', filter === key);
    chip.innerHTML = `${PLATFORMS.includes(key) ? `<span class="dot ${key}"></span>` : ''}${text}<span class="count">${counts[key]}</span>`;
    chip.addEventListener('click', () => {
      filter = key;
      sheetIndex = 0;
      render();
    });
    box.append(chip);
  }
}

function render() {
  renderFilters();
  $('#toolbar').hidden = labels.length === 0;
  grid.innerHTML = '';
  const shown = visibleLabels();
  $('#empty-filter').hidden = shown.length > 0 || labels.length === 0;
  for (const label of shown) grid.append(renderCard(label));
  updateSummary();
}

function renderCard(label) {
  const file = files.get(label.fileId);
  const card = document.createElement('div');
  card.className = `label-card ${label.platform}${label.skip ? ' skipped' : ''}`;
  const where = `p${label.pageIndex + 1}${label.perPage > 1 ? ` · ${label.index + 1}/${label.perPage}` : ''}`;
  card.innerHTML = `
    <div class="thumb">
      <span class="badge">${label.platform}</span>
      ${label.skip ? `<span class="skip-tag">${label.reason ? escapeHtml(label.reason) : 'Skipped'}</span>` : ''}
      <button class="btn small edit-btn">✎ Crop</button>
    </div>
    <div class="card-foot">
      <span class="card-name" title="${escapeHtml(file.name)}"><b>${where}</b> · ${escapeHtml(file.name)}</span>
      <input type="checkbox" class="switch" title="Include in print" aria-label="Include in print" ${label.skip ? '' : 'checked'} />
    </div>`;
  card.querySelector('.thumb').prepend(label.thumb);
  card.querySelector('.switch').addEventListener('change', (e) => {
    label.skip = !e.target.checked;
    label.reason = undefined;
    persistLabel(label);
    if (filter === 'skipped') render();
    else {
      card.replaceWith(renderCard(label));
      renderFilters();
      updateSummary();
    }
  });
  card.querySelector('.edit-btn').addEventListener('click', () => onEdit(label));
  return card;
}

function setSkipForVisible(skip) {
  for (const l of visibleLabels()) {
    l.skip = skip;
    l.reason = undefined;
    persistLabel(l);
  }
  render();
}
$('#include-all').addEventListener('click', () => setSkipForVisible(false));
$('#skip-all').addEventListener('click', () => setSkipForVisible(true));

$('#clear').addEventListener('click', async () => {
  if (!confirm('Remove all labels?')) return;
  await Promise.all([...files.values()].map((f) => closePdf(f.doc)));
  files.clear();
  labels = [];
  errors.innerHTML = '';
  filter = 'all';
  sheetIndex = 0;
  await store.clearAll();
  render();
  toast('Everything cleared');
});

async function onEdit(label) {
  const doc = files.get(label.fileId).doc;
  const result = await editCrop(await doc.getPage(label.pageIndex + 1), label.crop, label.platform);
  if (!result) return;
  const targets = result.applyToPlatform
    ? labels.filter(
        (l) =>
          l === label ||
          // Same spot on the page: on Amazon sheets the top and bottom labels need different crops.
          (l.platform === label.platform && l.index === label.index && l.reason !== 'invoice page'),
      )
    : [label];
  toast('Updating previews…');
  for (const target of targets) {
    const page = await files.get(target.fileId).doc.getPage(target.pageIndex + 1);
    const { width, height } = page.getViewport({ scale: 1 });
    target.crop = clampCrop(result.crop, width, height);
    target.cropEdited = true;
    target.skip = false;
    target.reason = undefined;
    target.thumb = cropCanvas(await renderPage(page, PREVIEW_SCALE), target.crop, PREVIEW_SCALE);
    persistLabel(target);
  }
  render();
}

function clampCrop(c, width, height) {
  const x = Math.min(Math.max(c.x, 0), width - 1);
  const y = Math.min(Math.max(c.y, 0), height - 1);
  return { x, y, w: Math.min(c.w, width - x), h: Math.min(c.h, height - y) };
}

// ---------- summary + preview ----------

// What gets previewed and downloaded: the labels of the selected platform filter
// ("All" and "Skipped" print every platform), minus skipped ones.
function printFilter() {
  return PLATFORMS.includes(filter) ? filter : null;
}
function activeLabels() {
  const platform = printFilter();
  return labels.filter((l) => !l.skip && (!platform || l.platform === platform));
}

function updateSummary() {
  const active = activeLabels().length;
  const sheetCount = Math.ceil(active / perPage());
  const skipped = labels.filter((l) => l.skip).length;
  const platform = printFilter();
  for (const el of $$('.js-labels')) el.textContent = active;
  for (const el of $$('.js-sheets')) el.textContent = sheetCount;
  for (const el of $$('.js-labels-word')) el.textContent = active === 1 ? 'label' : 'labels';
  for (const el of $$('.js-sheets-word')) el.textContent = sheetCount === 1 ? 'sheet' : 'sheets';
  $('#stat-skipped').textContent = skipped;
  const scope = platform ? `Printing ${capitalize(platform)} labels only` : skipped ? `${skipped} skipped` : '';
  for (const el of $$('.js-scope')) el.textContent = scope;
  for (const b of [...downloadButtons, ...shareButtons]) b.disabled = busy || active === 0;
  $('#clear').hidden = labels.length === 0;
  $('#clear').disabled = busy;
  dropZone.classList.toggle('compact', labels.length > 0);
  $('#share-hint').hidden = labels.length > 0;
  updatePreview();
}

function updatePreview() {
  const all = chunk(activeLabels(), perPage());
  sheetIndex = Math.min(sheetIndex, Math.max(0, all.length - 1));
  drawSheetPreview(previewCanvas, all[sheetIndex] ?? [], perPage(), { cutLines: cutLinesInput.checked });
  $('#sheet-index').textContent = `${all.length ? sheetIndex + 1 : 0} / ${all.length}`;
  $('#prev-sheet').disabled = sheetIndex === 0;
  $('#next-sheet').disabled = sheetIndex >= all.length - 1;
}

$('#prev-sheet').addEventListener('click', () => {
  sheetIndex--;
  updatePreview();
});
$('#next-sheet').addEventListener('click', () => {
  sheetIndex++;
  updatePreview();
});
window.addEventListener('resize', updatePreview);

// ---------- export ----------

for (const b of downloadButtons) b.addEventListener('click', () => exportPdf('download'));
for (const b of shareButtons) b.addEventListener('click', () => exportPdf('share'));

const canShareFiles = () =>
  !!navigator.canShare?.({ files: [new File([''], 'x.pdf', { type: 'application/pdf' })] });
for (const b of shareButtons) b.hidden = !canShareFiles();

async function exportPdf(mode) {
  busy = true;
  updateSummary();
  toast('Creating PDF…');
  try {
    const items = [];
    for (const label of activeLabels()) {
      const file = files.get(label.fileId);
      const page = await file.doc.getPage(label.pageIndex + 1);
      items.push({ ...label, vector: file.vector, rotation: page.rotate, pdfBox: viewCropToPdfBox(page, label.crop) });
    }
    const bytes = await buildSheets(
      items,
      new Map([...files].map(([id, f]) => [id, f.bytes])),
      perPage(),
      renderLabelPng,
      { cutLines: cutLinesInput.checked },
    );
    const platform = printFilter();
    const name = `labels-${platform ? `${platform}-` : ''}${new Date().toISOString().slice(0, 10)}.pdf`;
    if (mode === 'share') {
      try {
        await navigator.share({ files: [new File([bytes], name, { type: 'application/pdf' })], title: name });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
        // Share may be refused (e.g. took too long after the tap) — fall back to a download.
      }
    }
    downloadFile(bytes, name);
    toast(`✓ ${name} downloaded`);
  } catch (err) {
    showError(`Could not create PDF: ${err.message}`);
  } finally {
    busy = false;
    updateSummary();
  }
}

// High-resolution image of one label, for PDFs pdf-lib can't copy from.
async function renderLabelPng(label) {
  const page = await files.get(label.fileId).doc.getPage(label.pageIndex + 1);
  const canvas = cropCanvas(await renderPage(page, PRINT_SCALE), label.crop, PRINT_SCALE);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

function downloadFile(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function capitalize(s) {
  return s[0].toUpperCase() + s.slice(1);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- install app / share target ----------

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

// Chrome/Edge offer a real install prompt. iPhone (Safari and every iOS browser) never
// does, so phones always get the button and fall back to step-by-step instructions.
let installPrompt = null;
$('#install').hidden = isStandalone() || !(isIOS || isAndroid);
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#install').hidden = false;
});
$('#install').addEventListener('click', async () => {
  if (!installPrompt) {
    showInstallHelp();
    return;
  }
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  if (outcome === 'accepted') $('#install').hidden = true;
});

const SHARE_ICON =
  '<svg viewBox="0 0 24 24" class="inline-icon" aria-hidden="true"><path d="M12 15V3m0 0L8 7m4-4 4 4"/><path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/></svg>';

function showInstallHelp() {
  const steps = isIOS
    ? [
        `Tap the <b>Share</b> button ${SHARE_ICON} — at the bottom in Safari, top-right in Chrome.`,
        'Scroll down and tap <b>Add to Home Screen</b>.',
        'Tap <b>Add</b>. Label Cropper now opens from your home screen like an app.',
      ]
    : [
        'Tap the browser menu <b>⋮</b> (top-right).',
        'Tap <b>Install app</b> or <b>Add to Home screen</b>.',
        'Tap <b>Install</b>. Then share PDFs from WhatsApp → <b>Share</b> → <b>Label Cropper</b>.',
      ];
  const note = isIOS
    ? '<p class="install-note">iPhone does not let web apps appear in the WhatsApp share menu. Instead tap the PDF in WhatsApp → <b>Share</b> → <b>Copy</b>, then long-press the paste box here → <b>Paste</b>.</p>'
    : '';
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-box install-box" role="dialog" aria-modal="true" aria-labelledby="install-title">
      <h2 id="install-title">Install Label Cropper</h2>
      <ol class="install-steps">${steps.map((s) => `<li><span>${s}</span></li>`).join('')}</ol>
      ${note}
      <div class="modal-actions"><span class="spacer"></span><button class="primary">Got it</button></div>
    </div>`;
  const close = () => modal.remove();
  modal.querySelector('button').addEventListener('click', close);
  modal.addEventListener('click', (e) => e.target === modal && close());
  document.body.append(modal);
}
window.addEventListener('appinstalled', () => {
  $('#install').hidden = true;
  toast('App installed — you can now share PDFs to it from WhatsApp');
});

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}
navigator.storage?.persist?.();

// Opened from a WhatsApp share: the service worker already saved the files.
const params = new URLSearchParams(location.search);
const shared = params.get('shared');
const ignored = Number(params.get('ignored') || 0);
if (shared !== null) history.replaceState(null, '', location.pathname);

render();
restore().then(() => {
  if (shared === null) return;
  if (Number(shared)) toast(`${shared} shared PDF${Number(shared) > 1 ? 's' : ''} added`);
  else if (ignored) toast('This PDF is already added');
});
