// Label detection. Works in "view space": points, origin top-left, y grows down
// (pdf.js viewport at scale 1), so it matches what the user sees on screen.

import { LABEL_HEIGHT_FRACTION } from './presets.js';

// Checked in order. Meesho label PDFs often don't contain the word "Meesho",
// so its address-block wording is a last-resort match.
const PLATFORM_KEYWORDS = [
  ['meesho', /meesho/i],
  ['flipkart', /flipkart|e-?kart/i],
  ['amazon', /amazon/i],
  ['meesho', /if undelivered,?\s*return to/i],
];

// Strongest match first: a "Tax Invoice" heading beats a bare "Invoice".
const INVOICE_HEADINGS = [/tax\s*invoice/i, /bill\s*of\s*supply/i, /^\s*invoice\s*$/i];

// A heading this close to the top means the whole page is the invoice.
const INVOICE_ONLY_TOP_FRACTION = 0.15;
// Headings starting right of this are invoices printed beside their labels
// (Amazon: labels in the left column, invoices in the right column).
const SIDE_BY_SIDE_MIN_LEFT = 0.6;
// Headings closer than this belong to the same row.
const SAME_ROW = 30;
// The cut line between rows sits a little above the next row's invoice heading.
const ROW_LEAD = 6;
// Keep the label column clear of the vertical cut line at the page centre.
const COLUMN_GAP = 6;
const BOUNDARY_GAP = 4;
const PADDING = 2;
// Pages no taller than this are already label-sized (4x6 in = 432pt), never half-cut.
const LABEL_PAGE_MAX_HEIGHT = 500;

export function detectPlatform(text) {
  for (const [platform, re] of PLATFORM_KEYWORDS) if (re.test(text)) return platform;
  return 'unknown';
}

// items: [{ str, top, left }] in view space. Returns the invoice headings, top to bottom.
export function findInvoiceHeadings(items) {
  for (const re of INVOICE_HEADINGS) {
    const found = items.filter((it) => re.test(it.str));
    if (found.length) return found.sort((a, b) => a.top - b.top);
  }
  return [];
}

export function isInvoiceOnlyPage(invoiceTop, pageHeight) {
  return invoiceTop !== null && invoiceTop < pageHeight * INVOICE_ONLY_TOP_FRACTION;
}

// Where the label region ends (view-space y).
export function labelBottom(invoiceTop, platform, pageHeight) {
  if (invoiceTop !== null) return Math.max(0, invoiceTop - BOUNDARY_GAP);
  if (pageHeight <= LABEL_PAGE_MAX_HEIGHT) return pageHeight;
  return pageHeight * (LABEL_HEIGHT_FRACTION[platform] ?? 1);
}

// Areas of the page that may hold a label, in reading order (view-space boxes).
// An empty list means the page is only an invoice.
export function labelRegions(items, platform, width, height) {
  const headings = findInvoiceHeadings(items);

  if (headings.length && headings.every((h) => h.left > width * SIDE_BY_SIDE_MIN_LEFT)) {
    const rowTops = [];
    for (const h of headings) {
      if (!rowTops.length || h.top - rowTops[rowTops.length - 1] > SAME_ROW) rowTops.push(h.top);
    }
    const starts = rowTops.map((top, i) => (i === 0 ? 0 : Math.max(0, top - ROW_LEAD)));
    return starts.map((y, i) => ({
      x: 0,
      y,
      w: width / 2 - COLUMN_GAP,
      h: (i + 1 < starts.length ? starts[i + 1] : height) - y,
    }));
  }

  const invoiceTop = headings.length ? headings[0].top : null;
  if (isInvoiceOnlyPage(invoiceTop, height)) return [];
  return [{ x: 0, y: 0, w: width, h: labelBottom(invoiceTop, platform, height) }];
}

// Group indices where flags[i] is true into runs separated by >= gap false entries,
// then drop thin runs at either end (dashed cut lines).
function inkSpan(flags, gap, thin) {
  const runs = [];
  let blank = Infinity;
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i]) {
      blank++;
      continue;
    }
    if (blank >= gap || !runs.length) runs.push({ start: i, end: i });
    else runs[runs.length - 1].end = i;
    blank = 0;
  }
  const isThin = (r) => r.end - r.start + 1 <= thin;
  while (runs.length > 1 && isThin(runs[runs.length - 1])) runs.pop();
  while (runs.length > 1 && isThin(runs[0])) runs.shift();
  if (!runs.length) return null;
  return { start: runs[0].start, end: runs[runs.length - 1].end };
}

// Bounding box of "ink" (non-white pixels) inside a pixel region of an RGBA image.
// Thin isolated runs at the edges (cut lines like "- - - -") are dropped so they
// don't stretch the box. Returns pixel box { x, y, w, h } or null when blank.
export function inkBox(image, region, { threshold = 235, gap = 4, thin = 3 } = {}) {
  const { data, width } = image;
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(image.width, Math.ceil(region.x + region.w));
  const y1 = Math.min(image.height, Math.ceil(region.y + region.h));
  const isInk = (x, y) => {
    const i = (y * width + x) * 4;
    return (data[i] + data[i + 1] + data[i + 2]) / 3 < threshold && data[i + 3] > 0;
  };
  const rowsWithInk = (cx0, cx1) =>
    Array.from({ length: y1 - y0 }, (_, r) => {
      for (let x = cx0; x < cx1; x++) if (isInk(x, y0 + r)) return true;
      return false;
    });
  const colsWithInk = (ry0, ry1) =>
    Array.from({ length: x1 - x0 }, (_, c) => {
      for (let y = ry0; y < ry1; y++) if (isInk(x0 + c, y)) return true;
      return false;
    });

  const rows = inkSpan(rowsWithInk(x0, x1), gap, thin);
  if (!rows) return null;
  const cols = inkSpan(colsWithInk(y0 + rows.start, y0 + rows.end + 1), gap, thin);
  if (!cols) return null;
  // Rows again, now ignoring any cut line that was dropped from the columns.
  const rows2 = inkSpan(rowsWithInk(x0 + cols.start, x0 + cols.end + 1), gap, thin) ?? rows;
  return { x: x0 + cols.start, y: y0 + rows2.start, w: cols.end - cols.start + 1, h: rows2.end - rows2.start + 1 };
}

// Full detection for one page.
// page: { width, height, text, items: [{ str, top, left }], image, scale }
//   image is the page rendered at `scale` (RGBA ImageData-like).
// Returns one entry per label found: { platform, skip, reason?, crop: { x, y, w, h } }
// (crop in view-space points). Invoice-only or blank pages give a single skipped entry.
export function detectLabels(page) {
  const platform = detectPlatform(page.text);
  const regions = labelRegions(page.items, platform, page.width, page.height);
  if (!regions.length) return [{ platform, skip: true, reason: 'invoice page', crop: fullPage(page) }];

  const s = page.scale;
  const labels = [];
  for (const r of regions) {
    const box = inkBox(page.image, { x: r.x * s, y: r.y * s, w: r.w * s, h: r.h * s });
    if (!box) continue;
    const x = Math.max(r.x, box.x / s - PADDING);
    const y = Math.max(r.y, box.y / s - PADDING);
    const right = Math.min(r.x + r.w, (box.x + box.w) / s + PADDING);
    const lower = Math.min(r.y + r.h, (box.y + box.h) / s + PADDING);
    labels.push({ platform, skip: false, crop: { x, y, w: right - x, h: lower - y } });
  }
  return labels.length ? labels : [{ platform, skip: true, reason: 'blank', crop: fullPage(page) }];
}

function fullPage(page) {
  return { x: 0, y: 0, w: page.width, h: page.height };
}
