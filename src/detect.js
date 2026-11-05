// Label detection. Works in "view space": points, origin top-left, y grows down
// (pdf.js viewport at scale 1), so it matches what the user sees on screen.

import { readCode128 } from './barcode.js';
import { awbId, findOrderId } from './order-id.js';
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

// Platform named by the PDF's metadata (e.g. Creator "AmazonSeller"), or null.
export function platformFromMetadata(info) {
  if (!info) return null;
  const text = [info.Creator, info.Producer, info.Title, info.Author, info.Subject].filter(Boolean).join(' ');
  const platform = detectPlatform(text);
  return platform === 'unknown' ? null : platform;
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
// page: { width, height, text, items: [{ str, top, left }], image, scale, platformHint? }
//   image is the page rendered at `scale` (RGBA ImageData-like); platformHint is the
//   platform known from the file itself (metadata / image source), used when the page's
//   own text doesn't name one.
// Returns one entry per label found: { platform, skip, reason?, crop: { x, y, w, h }, orderId, uid }
// (crop in view-space points). Invoice-only or blank pages give a single skipped entry,
// with no order ID: an invoice must never stand in for its label as the "original".
export function detectLabels(page) {
  const printed = detectPlatform(page.text);
  const platform = printed === 'unknown' ? (page.platformHint ?? 'unknown') : printed;
  // Layout presets follow only what's printed on the page: a label image hinted "amazon"
  // must not be cut to the top half like an Amazon label-plus-invoice page.
  const regions = labelRegions(page.items, printed, page.width, page.height);
  const hasText = page.items.length > 0;
  if (!regions.length) return [{ platform, skip: true, reason: 'invoice page', crop: fullPage(page), ...NO_ID }];

  const s = page.scale;
  const labels = [];
  for (const r of regions) {
    const area = { x: r.x * s, y: r.y * s, w: r.w * s, h: r.h * s };
    let box = inkBox(page.image, area);
    if (!box) continue;
    // A real label is never a thin strip. Ink like that is only a cut line, e.g. when the
    // label image didn't show up in the render (seen on iPhone): keep the whole area.
    if (box.w / s < MIN_LABEL_SIDE || box.h / s < MIN_LABEL_SIDE) box = pixelBox(page.image, area);
    const x = Math.max(r.x, box.x / s - PADDING);
    const y = Math.max(r.y, box.y / s - PADDING);
    const right = Math.min(r.x + r.w, (box.x + box.w) / s + PADDING);
    const lower = Math.min(r.y + r.h, (box.y + box.h) / s + PADDING);
    const id = hasText ? findOrderId(platform, rowText(page.items, r)) : awbId(readCode128(subImage(page.image, box)));
    labels.push({ platform, skip: false, crop: { x, y, w: right - x, h: lower - y }, ...NO_ID, ...id });
  }
  return labels.length ? labels : [{ platform, skip: true, reason: 'blank', crop: fullPage(page), ...NO_ID }];
}

const NO_ID = { orderId: null, uid: null };

// Smallest label side, in points (1 inch). Shipping labels are about 4 x 6 inches.
const MIN_LABEL_SIDE = 72;

// A view-space area scaled to pixels, as whole pixels inside the image.
function pixelBox(image, area) {
  const x = Math.max(0, Math.floor(area.x));
  const y = Math.max(0, Math.floor(area.y));
  const right = Math.min(image.width, Math.ceil(area.x + area.w));
  const lower = Math.min(image.height, Math.ceil(area.y + area.h));
  return { x, y, w: right - x, h: lower - y };
}

// Text in the label's band of the page, across the full width: the label itself, plus
// the invoice printed beside it (Amazon labels are images; the order number is only there).
export function rowText(items, region) {
  return items
    .filter((it) => it.top >= region.y && it.top < region.y + region.h)
    .map((it) => it.str)
    .join(' ');
}

// Pixel box of an RGBA image, as a new image.
export function subImage(image, box) {
  const data = new Uint8ClampedArray(box.w * box.h * 4);
  for (let row = 0; row < box.h; row++) {
    const from = ((box.y + row) * image.width + box.x) * 4;
    data.set(image.data.subarray(from, from + box.w * 4), row * box.w * 4);
  }
  return { width: box.w, height: box.h, data };
}

function fullPage(page) {
  return { x: 0, y: 0, w: page.width, h: page.height };
}
