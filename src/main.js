import './style.css';
import { buildSheets, canEmbedVector } from './compose.js';
import { editCrop } from './crop-editor.js';
import { detectLabels, platformFromMetadata } from './detect.js';
import { clearHistory, loadHistory, recordPrinted } from './history.js';
import { SUPPORTED_PER_PAGE, chunk, gridFor } from './layout.js';
import { closePdf, cropCanvas, isPasswordError, openPdf, readPage, renderPage, viewCropToPdfBox } from './pdf-read.js';
import { asPdfBytes, fileKind } from './image-input.js';
import { contentName, filesFromText } from './paste.js';
import { drawSheetPreview } from './preview.js';
import * as store from './store.js';

const PREVIEW_SCALE = 1.5;
const PRINT_SCALE = 300 / 72;
const PLATFORMS = ['amazon', 'meesho', 'flipkart', 'unknown'];
const SETTINGS_KEY = 'label-cropper-settings';

const files = new Map(); // fileKey -> { name, bytes, doc, vector }
// { key, fileId, pageIndex, index, perPage, platform, crop, skip, reason, thumb,
//   orderId, uid, duplicate, reprint }
let labels = [];
const printHistory = new Map(); // uid -> print record (see history.js)
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
const includePrintedInput = $('#include-printed');
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
includePrintedInput.checked = saved.includePrinted ?? false;

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
  } catch {
    return {};
  }
}
function saveSettings() {
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ perPage: perPage(), cutLines: cutLinesInput.checked, includePrinted: includePrintedInput.checked }),
  );
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
includePrintedInput.addEventListener('change', () => {
  saveSettings();
  sheetIndex = 0;
  render();
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

// ---------- pasting a PDF ----------
// iPhone (Safari, Chrome and home-screen apps are all WebKit) never gives a web page a
// copied PDF file, only images. So on iPhone an iOS Shortcut in WhatsApp's share menu
// copies the PDF as base64 text, and "Paste PDF" turns it back into the original file.
// Label images (Amazon Seller app) paste directly. Desktop: Ctrl/⌘+V works too.

if (isIOS) {
  $('#share-hint-text').innerHTML =
    'From WhatsApp: PDF → <b>Share</b> → <b>Label Cropper</b> shortcut, then tap <b>Paste PDF</b>';
}
for (const el of $$('.js-paste-help')) el.addEventListener('click', () => showPasteHelp());

const IMAGE_TYPES = ['image/png', 'image/jpeg'];

$('#paste-btn').addEventListener('click', async () => {
  try {
    // iOS shows its "Paste" bubble before either call returns.
    if (navigator.clipboard?.read) {
      const images = [];
      let text = '';
      for (const item of await navigator.clipboard.read()) {
        const type = IMAGE_TYPES.find((t) => item.types.includes(t));
        if (type) images.push(await item.getType(type));
        else if (item.types.includes('text/plain')) text += `\n${await (await item.getType('text/plain')).text()}`;
      }
      if (images.length) addFiles(await Promise.all(images.map((blob) => pastedFile(new File([blob], '')))));
      else addPastedText(text);
    } else if (navigator.clipboard?.readText) {
      addPastedText(await navigator.clipboard.readText());
    } else {
      showPasteHelp('This browser can’t read the clipboard here — press Ctrl+V (⌘+V) instead.');
    }
  } catch (err) {
    // NotAllowedError: the "Paste" bubble was dismissed (or permission refused).
    if (err.name !== 'NotAllowedError') showPasteHelp(`Could not read the clipboard (${err.message}).`);
  }
});

document.addEventListener('paste', async (e) => {
  if (e.target.closest?.('input, textarea, [contenteditable]')) return;
  // clipboardData is only readable during the event, so take everything before awaiting.
  const pasted = clipboardFiles(e.clipboardData);
  const text = pasted.length ? '' : (e.clipboardData?.getData('text/plain') ?? '');
  e.preventDefault();
  if (pasted.length) addFiles(await Promise.all(pasted.map(pastedFile)));
  else addPastedText(text);
});

function addPastedText(text) {
  const found = filesFromText(text);
  if (found.length) addFiles(found.map((bytes) => new File([bytes], contentName(bytes))));
  else showPasteHelp('No PDF or label image on the clipboard.');
}

function clipboardFiles(data) {
  if (!data) return [];
  if (data.files?.length) return [...data.files];
  return [...(data.items ?? [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
}

// Pasted files often have no name or a generic one ("image.png"). Files are deduped by
// name + size, so those get a name from their contents instead.
async function pastedFile(f) {
  if (f.name && !/^image\.\w+$/i.test(f.name)) return f;
  const bytes = new Uint8Array(await f.arrayBuffer());
  return new File([bytes], contentName(bytes), { type: f.type });
}

// What a file really is, from its first bytes (Amazon label PNGs often have no extension).
async function kindOf(f) {
  return fileKind(new Uint8Array(await f.slice(0, 1024).arrayBuffer()));
}

// New files are appended to what's already loaded — nothing is ever replaced.
async function addFiles(list) {
  const kinds = await Promise.all(list.map(kindOf));
  const supported = list.filter((_, i) => kinds[i]);
  const fresh = [];
  let duplicates = 0;
  for (const f of supported) {
    const key = store.fileKey(f.name, f.size);
    if (files.has(key) || fresh.some((r) => r.key === key)) duplicates++;
    else fresh.push({ key, name: f.name, size: f.size, blob: f, addedAt: Date.now() + fresh.length });
  }
  if (list.length > supported.length) toast('Only PDFs and label images (PNG / JPG) are supported');
  if (duplicates) toast(`${duplicates} file${duplicates > 1 ? 's are' : ' is'} already added`);
  if (!fresh.length) return;
  await Promise.all(fresh.map((r) => store.saveFile(r)));
  toast(addedMessage(await processRecords(fresh, new Map())));
}

// e.g. "3 new labels added · 2 already printed · 1 duplicate"
function addedMessage(added) {
  const found = added.filter((l) => !l.skip);
  const dup = found.filter((l) => l.duplicate).length;
  const printed = found.filter((l) => !l.duplicate && isPrinted(l)).length;
  const fresh = found.length - dup - printed;
  const parts = [fresh ? `${fresh} new label${fresh > 1 ? 's' : ''} added` : 'No new labels'];
  if (printed) parts.push(`${printed} already printed`);
  if (dup) parts.push(`${dup} duplicate${dup > 1 ? 's' : ''}`);
  return parts.join(' · ');
}

// Restores everything saved earlier (including files shared from WhatsApp by the
// service worker while the app was closed). Returns the labels it added.
async function restore() {
  const [records, overrides] = await Promise.all([store.listFiles(), store.listOverrides()]);
  const pending = records.filter((r) => !files.has(r.key));
  return pending.length ? processRecords(pending, overrides) : [];
}

async function processRecords(records, overrides) {
  busy = true;
  updateSummary();
  const added = [];
  for (const [i, record] of records.entries()) {
    try {
      added.push(
        ...(await addFile(record, overrides, (page, total) =>
          showProgress(record.name, i, records.length, page, total),
        )),
      );
    } catch (err) {
      const msg = isPasswordError(err) ? 'PDF is password-protected' : `could not read (${err.message})`;
      showError(`${record.name}: ${msg}`);
      files.delete(record.key);
      // Drop labels from pages read before the error, or they'd point at a missing file.
      labels = labels.filter((l) => l.fileId !== record.key);
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
  // Stored as received; label images become a PDF here, so restores work the same way.
  const converted = await asPdfBytes(new Uint8Array(await record.blob.arrayBuffer()));
  const { bytes } = converted;
  const doc = await openPdf(bytes);
  const platformHint = converted.platformHint ?? platformFromMetadata(await pdfInfo(doc));
  const fileId = record.key;
  files.set(fileId, { name: record.name, bytes, doc, vector: await canEmbedVector(bytes) });

  const added = [];
  for (let i = 0; i < doc.numPages; i++) {
    onPage(i, doc.numPages);
    const page = await doc.getPage(i + 1);
    const info = await readPage(page, PREVIEW_SCALE);
    const found = detectLabels({ ...info, platformHint });
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
        platform: saved.platform ?? result.platform,
        detectedPlatform: result.platform, // 'unknown' ones can be set by hand
        crop,
        cropEdited: !!saved.crop,
        skip: saved.skip ?? result.skip,
        reason: saved.skip === undefined ? result.reason : undefined,
        thumb: cropCanvas(info.canvas, crop, PREVIEW_SCALE),
        orderId: result.orderId,
        uid: result.uid,
        duplicate: false, // set by markDuplicates()
        reprint: saved.reprint ?? false,
      };
      labels.push(label);
      added.push(label);
    }
    page.cleanup();
  }
  return added;
}

async function pdfInfo(doc) {
  try {
    return (await doc.getMetadata()).info;
  } catch {
    return null;
  }
}

function persistLabel(label) {
  const value = { skip: label.skip };
  if (label.platform !== label.detectedPlatform) value.platform = label.platform;
  if (label.cropEdited) value.crop = label.crop;
  if (label.reprint) value.reprint = true;
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

// ---------- order IDs: duplicates + print history ----------

// The same order loaded twice (from one PDF or several) is printed once: the first copy
// in load order is kept, later copies become duplicates. Labels without an order ID are
// never merged.
function markDuplicates() {
  const seen = new Set();
  for (const l of labels) {
    l.duplicate = !!l.uid && seen.has(l.uid);
    if (l.uid) seen.add(l.uid);
  }
}

const isPrinted = (l) => !!l.uid && printHistory.has(l.uid);
const includePrinted = () => includePrintedInput.checked;

// Whether a label goes into the PDF (before the platform filter is applied).
function isIncluded(l) {
  if (l.skip || l.duplicate) return false;
  return !isPrinted(l) || includePrinted() || l.reprint;
}

function printedText(l) {
  const r = printHistory.get(l.uid);
  const date = new Date(r.lastPrintedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return `Printed${r.count > 1 ? ` ${r.count}×` : ''} · ${date}`;
}

// ---------- label grid ----------

const FILTER_TESTS = {
  all: () => true,
  printed: (l) => isPrinted(l) && !l.duplicate,
  duplicate: (l) => l.duplicate,
  skipped: (l) => l.skip,
};
const matchesFilter = (l, key) => (FILTER_TESTS[key] ?? ((x) => x.platform === key))(l);

function visibleLabels() {
  return labels.filter((l) => matchesFilter(l, filter));
}

function renderFilters() {
  const counts = {};
  for (const key of [...Object.keys(FILTER_TESTS), ...PLATFORMS]) {
    counts[key] = labels.filter((l) => matchesFilter(l, key)).length;
  }
  if (filter !== 'all' && !counts[filter]) filter = 'all';

  const chips = [
    ['all', 'All'],
    ...PLATFORMS.filter((p) => counts[p]).map((p) => [p, capitalize(p)]),
    ...[
      ['printed', 'Printed'],
      ['duplicate', 'Duplicate'],
      ['skipped', 'Skipped'],
    ].filter(([key]) => counts[key]),
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
  markDuplicates();
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
  const included = isIncluded(label);
  card.className = `label-card ${label.platform}${included ? '' : ' skipped'}`;
  const where = `p${label.pageIndex + 1}${label.perPage > 1 ? ` · ${label.index + 1}/${label.perPage}` : ''}`;
  const tags = [];
  if (label.duplicate) tags.push(['dup', 'Duplicate']);
  else if (isPrinted(label)) tags.push(['printed', printedText(label)]);
  if (label.skip) tags.push(['skip', label.reason ?? 'Skipped']);
  const order = label.orderId
    ? `<span class="card-order">${label.uid?.startsWith('awb:') ? '' : '#'}${escapeHtml(label.orderId)}</span>`
    : label.reason
      ? ''
      : '<span class="card-order missing">No order ID found</span>';
  const switchTitle = label.duplicate ? 'Duplicate — the first copy is printed instead' : 'Include in print';
  card.innerHTML = `
    <div class="thumb">
      ${platformBadge(label)}
      <span class="tags">${tags.map(([cls, text]) => `<span class="tag ${cls}">${escapeHtml(text)}</span>`).join('')}</span>
      <button class="btn small edit-btn">✎ Crop</button>
    </div>
    <div class="card-foot">
      <span class="card-info">
        <span class="card-name" title="${escapeHtml(file.name)}"><b>${where}</b> · ${escapeHtml(file.name)}</span>
        ${order}
      </span>
      <input type="checkbox" class="switch" title="${switchTitle}" aria-label="${switchTitle}"
        ${included ? 'checked' : ''} ${label.duplicate ? 'disabled' : ''} />
    </div>`;
  card.querySelector('.thumb').prepend(label.thumb);
  card.querySelector('.switch').addEventListener('change', (e) => {
    const on = e.target.checked;
    label.skip = !on;
    label.reason = undefined;
    // Turning on an already-printed label while printed ones are left out = reprint it.
    label.reprint = on && isPrinted(label) && !includePrinted();
    persistLabel(label);
    if (filter === 'skipped') render();
    else {
      card.replaceWith(renderCard(label));
      renderFilters();
      updateSummary();
    }
  });
  card.querySelector('.edit-btn').addEventListener('click', () => onEdit(label));
  card.querySelector('.platform-pick')?.addEventListener('change', (e) => {
    label.platform = e.target.value;
    persistLabel(label);
    render();
  });
  return card;
}

// Labels whose platform couldn't be read (e.g. a pasted label image) get a picker.
function platformBadge(label) {
  if (label.detectedPlatform !== 'unknown') return `<span class="badge">${label.platform}</span>`;
  const options = PLATFORMS.map(
    (p) => `<option value="${p}"${p === label.platform ? ' selected' : ''}>${p === 'unknown' ? 'Platform?' : capitalize(p)}</option>`,
  ).join('');
  return `<select class="badge platform-pick" aria-label="Platform">${options}</select>`;
}

function setSkipForVisible(skip) {
  for (const l of visibleLabels()) {
    l.skip = skip;
    l.reason = undefined;
    // "Print all" on the Printed filter means reprint them.
    if (skip) l.reprint = false;
    else if (filter === 'printed') l.reprint = isPrinted(l);
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
const inPrintScope = (l) => !printFilter() || l.platform === printFilter();
function activeLabels() {
  return labels.filter((l) => isIncluded(l) && inPrintScope(l));
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
  // Printed labels left out by the "include printed" switch (not skipped by hand).
  const leftOut = labels.filter((l) => inPrintScope(l) && !l.skip && !l.duplicate && !isIncluded(l)).length;
  const scope = [
    platform ? `Printing ${capitalize(platform)} labels only` : skipped ? `${skipped} skipped` : '',
    leftOut ? `${leftOut} already printed not included` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  for (const el of $$('.js-scope')) el.textContent = scope;
  $('#history-count').textContent = `${printHistory.size} order${printHistory.size === 1 ? '' : 's'} saved as printed`;
  $('#clear-history').disabled = printHistory.size === 0;
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
    const chosen = activeLabels();
    const items = [];
    for (const label of chosen) {
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
    let shared = false;
    if (mode === 'share') {
      try {
        await navigator.share({ files: [new File([bytes], name, { type: 'application/pdf' })], title: name });
        shared = true;
      } catch (err) {
        if (err.name === 'AbortError') return;
        // Share may be refused (e.g. took too long after the tap) — fall back to a download.
      }
    }
    if (!shared) downloadFile(bytes, name);
    const saved = await markPrinted(chosen);
    toast(`✓ ${shared ? 'PDF shared' : `${name} downloaded`}${saved ? ` · ${saved} order${saved > 1 ? 's' : ''} saved as printed` : ''}`);
  } catch (err) {
    showError(`Could not create PDF: ${err.message}`);
  } finally {
    busy = false;
    updateSummary();
  }
}

// Remembers what went into the PDF; reprint requests are done once it's printed.
async function markPrinted(chosen) {
  try {
    const saved = await recordPrinted(printHistory, chosen);
    for (const l of chosen) {
      if (!l.reprint) continue;
      l.reprint = false;
      persistLabel(l);
    }
    render();
    return saved;
  } catch (err) {
    showError(`PDF is ready, but print history could not be saved (${err.message})`);
    return 0;
  }
}

$('#clear-history').addEventListener('click', async () => {
  if (!confirm(`Forget all ${printHistory.size} printed orders? Their labels will count as new again.`)) return;
  try {
    await clearHistory(printHistory);
    toast('Print history cleared');
  } catch (err) {
    showError(`Could not clear print history (${err.message})`);
  }
  render();
});

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
    ? '<p class="install-note">iPhone does not let web apps appear in the WhatsApp share menu. <a href="#" class="js-paste-help">Set up the Label Cropper shortcut</a> to send PDFs here instead.</p>'
    : '';
  showModal('Install Label Cropper', `${stepList(steps)}${note}`);
}

// problem: optional line explaining why the help opened (e.g. nothing to paste).
function showPasteHelp(problem) {
  const intro = problem ? `<p class="install-note warn">${escapeHtml(problem)}</p>` : '';
  // Two shortcuts: one in the share sheet collects labels into a file (so many labels can
  // be sent without opening this app), one copies them all at once for "Paste PDF".
  const body = isIOS
    ? `${intro}
      <h3>Shortcut 1 — “Label Cropper” (share menu)</h3>
      ${stepList([
        'Shortcuts app → <b>+</b> → name it <b>Label Cropper</b>.',
        'Add <b>Base64 Encode</b> → tap <b>Input</b> → <b>Shortcut Input</b> → in the new top block tap <b>Nowhere</b> → <b>Share Sheet</b>. Set <b>Line Breaks: None</b>.',
        'Add <b>Combine Text</b> → <b>New Lines</b>.',
        'Add <b>Append to Text File</b> → file path <b>labels.txt</b>, <b>Make New Line</b> on.',
      ])}
      <h3>Shortcut 2 — “Labels Paste”</h3>
      ${stepList([
        'Shortcuts app → <b>+</b> → name it <b>Labels Paste</b>.',
        'Add <b>Get File from Folder</b> → path <b>labels.txt</b>.',
        'Add <b>Copy to Clipboard</b>.',
        'Add <b>Delete Files</b> → turn off <b>Confirm Before Deleting</b>.',
        'Name at the top → <b>Add to Home Screen</b>.',
      ])}
      <h3>Every day</h3>
      ${stepList([
        'Each label: Amazon / WhatsApp → <b>Share</b> → <b>Label Cropper</b>. Stay in that app and do the next one.',
        'When all are sent: tap <b>Labels Paste</b> on the home screen.',
        'Open this app → <b>Paste PDF</b> → <b>Paste</b>. All labels come in at once.',
      ])}
      <p class="install-note">No shortcut? WhatsApp → <b>Share</b> → <b>Save to Files</b>, then tap <b>Select label PDFs</b> here → <b>Recents</b>. Amazon Seller app labels are images: <b>Share</b> → <b>Copy</b> → <b>Paste PDF</b> works too.</p>`
    : `${intro}
      ${stepList([
        'Copy a PDF file (Files / Explorer / Finder), then press <b>Ctrl+V</b> (<b>⌘+V</b>) anywhere on this page.',
        isAndroid
          ? 'From WhatsApp: install this app, then PDF → <b>Share</b> → <b>Label Cropper</b>.'
          : 'Or drop PDF files on the <b>Select label PDFs</b> box.',
      ])}`;
  showModal(isIOS ? 'Send labels from Amazon / WhatsApp (iPhone)' : 'Paste a PDF', body);
}

function stepList(steps) {
  return `<ol class="install-steps">${steps.map((s) => `<li><span>${s}</span></li>`).join('')}</ol>`;
}

function showModal(title, bodyHtml) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-box install-box" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <h2 id="help-title">${escapeHtml(title)}</h2>
      ${bodyHtml}
      <div class="modal-actions"><span class="spacer"></span><button class="primary">Got it</button></div>
    </div>`;
  const close = () => modal.remove();
  modal.querySelector('.modal-actions button').addEventListener('click', close);
  modal.addEventListener('click', (e) => e.target === modal && close());
  for (const link of modal.querySelectorAll('.js-paste-help')) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      close();
      showPasteHelp();
    });
  }
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
start();

async function start() {
  // History first, so restored labels show their "Printed" tags straight away.
  try {
    for (const [uid, r] of await loadHistory()) printHistory.set(uid, r);
  } catch (err) {
    showError(`Print history unavailable (${err.message})`);
  }
  render();
  await restore();
  if (shared === null) return;
  if (Number(shared)) toast(`${shared} shared PDF${Number(shared) > 1 ? 's' : ''} added`);
  else if (ignored) toast('This PDF is already added');
}
