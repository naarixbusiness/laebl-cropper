import { describe, expect, it } from 'vitest';
import {
  detectLabels,
  detectPlatform,
  findInvoiceHeadings,
  inkBox,
  isInvoiceOnlyPage,
  labelBottom,
  labelRegions,
} from '../src/detect.js';

function blankImage(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
}

function fillRect(img, x, y, w, h) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * img.width + xx) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
    }
  }
}

describe('detectPlatform', () => {
  it.each([
    ['Sold via Meesho  Customer Address', 'meesho'],
    ['FLIPKART Ordered through', 'flipkart'],
    ['E-Kart Logistics', 'flipkart'],
    ['Amazon Transportation Services', 'amazon'],
    ['Customer Address  If undelivered, return to: ACME', 'meesho'],
    ['Delhivery COD', 'unknown'],
  ])('%s -> %s', (text, platform) => {
    expect(detectPlatform(text)).toBe(platform);
  });
});

describe('findInvoiceHeadings', () => {
  it('prefers "Tax Invoice" over a bare "Invoice"', () => {
    const items = [
      { str: 'Invoice', top: 100, left: 0 },
      { str: 'TAX INVOICE', top: 420, left: 0 },
    ];
    expect(findInvoiceHeadings(items).map((h) => h.top)).toEqual([420]);
  });

  it('does not treat "Invoice No:" in the label header as the invoice', () => {
    expect(findInvoiceHeadings([{ str: 'Invoice No: FA123', top: 50, left: 0 }])).toEqual([]);
  });

  it('matches Amazon "Tax Invoice/Bill of Supply/Cash Memo", sorted top to bottom', () => {
    const str = 'Tax Invoice/Bill of Supply/Cash Memo';
    const items = [
      { str, top: 428, left: 452 },
      { str, top: 7, left: 452 },
    ];
    expect(findInvoiceHeadings(items).map((h) => h.top)).toEqual([7, 428]);
  });
});

describe('labelRegions', () => {
  const amazon = (tops) => tops.map((top) => ({ str: 'Tax Invoice/Bill of Supply/Cash Memo', top, left: 452 }));

  it('Amazon sheet: one left-column region per invoice row', () => {
    const regions = labelRegions(amazon([7, 428]), 'amazon', 595, 842);
    expect(regions).toHaveLength(2);
    expect(regions[0]).toMatchObject({ x: 0, y: 0, h: 422 });
    expect(regions[1]).toMatchObject({ x: 0, y: 422, h: 420 });
    for (const r of regions) expect(r.w).toBeLessThan(595 / 2);
  });

  it('Amazon sheet with a single label on the last page', () => {
    expect(labelRegions(amazon([7]), 'amazon', 595, 842)).toEqual([{ x: 0, y: 0, w: 595 / 2 - 6, h: 842 }]);
  });

  it('Meesho: centred "TAX INVOICE" below the label is not side-by-side', () => {
    const items = [{ str: 'TAX INVOICE', top: 351, left: 266 }];
    expect(labelRegions(items, 'meesho', 595, 842)).toEqual([{ x: 0, y: 0, w: 595, h: 347 }]);
  });

  it('invoice-only page has no regions', () => {
    expect(labelRegions([{ str: 'Tax Invoice', top: 20, left: 40 }], 'amazon', 595, 842)).toEqual([]);
  });
});

describe('isInvoiceOnlyPage', () => {
  it('heading near the top means invoice-only page', () => {
    expect(isInvoiceOnlyPage(30, 842)).toBe(true);
    expect(isInvoiceOnlyPage(420, 842)).toBe(false);
    expect(isInvoiceOnlyPage(null, 842)).toBe(false);
  });
});

describe('labelBottom', () => {
  it('cuts just above the invoice heading', () => {
    expect(labelBottom(420, 'meesho', 842)).toBe(416);
  });
  it('uses the platform preset on A4 pages without a heading', () => {
    expect(labelBottom(null, 'flipkart', 842)).toBeCloseTo(842 * 0.47);
  });
  it('keeps label-sized pages (4x6) whole', () => {
    expect(labelBottom(null, 'amazon', 432)).toBe(432);
  });
});

describe('inkBox', () => {
  const top60 = { x: 0, y: 0, w: 100, h: 60 };

  it('finds the ink bounding box inside the region', () => {
    const img = blankImage(100, 100);
    fillRect(img, 20, 10, 30, 20);
    fillRect(img, 0, 80, 100, 10); // outside the region, ignored
    expect(inkBox(img, top60)).toEqual({ x: 20, y: 10, w: 30, h: 20 });
  });

  it('drops a thin full-width cut line under the label', () => {
    const img = blankImage(100, 100);
    fillRect(img, 20, 10, 30, 20);
    fillRect(img, 0, 50, 100, 1);
    expect(inkBox(img, top60)).toEqual({ x: 20, y: 10, w: 30, h: 20 });
  });

  it('drops a thin full-height cut line beside the label', () => {
    const img = blankImage(100, 100);
    fillRect(img, 20, 10, 30, 20);
    fillRect(img, 70, 0, 1, 100);
    expect(inkBox(img, { x: 0, y: 0, w: 100, h: 100 })).toEqual({ x: 20, y: 10, w: 30, h: 20 });
  });

  it('returns null for a blank region', () => {
    expect(inkBox(blankImage(10, 10), { x: 0, y: 0, w: 10, h: 10 })).toBeNull();
  });
});

describe('detectLabels', () => {
  const scale = 0.5;
  const page = (items, text = '') => {
    const image = blankImage(300, 421); // 600 x 842 pt page at scale 0.5
    fillRect(image, 50, 20, 100, 150); // label: x 100-300pt, y 40-340pt
    fillRect(image, 50, 220, 200, 100); // invoice: y 440-640pt
    return { width: 600, height: 842, text, items, image, scale };
  };

  it('crops the label above the invoice heading', () => {
    const [r] = detectLabels(page([{ str: 'TAX INVOICE', top: 430, left: 250 }], 'Meesho'));
    expect(r.platform).toBe('meesho');
    expect(r.skip).toBe(false);
    expect(r.crop.x).toBeCloseTo(98);
    expect(r.crop.y).toBeCloseTo(38);
    expect(r.crop.x + r.crop.w).toBeCloseTo(302);
    expect(r.crop.y + r.crop.h).toBeCloseTo(342);
  });

  it('skips invoice-only pages', () => {
    const r = detectLabels(page([{ str: 'Tax Invoice', top: 20, left: 40 }], 'amazon'));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ skip: true, reason: 'invoice page' });
  });

  it('falls back to the platform preset when no heading is found', () => {
    const [r] = detectLabels(page([], 'flipkart'));
    expect(r.skip).toBe(false);
    expect(r.crop.y + r.crop.h).toBeLessThanOrEqual(842 * 0.47);
  });

  it('finds two labels on an Amazon sheet', () => {
    const image = blankImage(300, 421);
    fillRect(image, 10, 10, 120, 180); // top label: x 20-260pt, y 20-380pt
    fillRect(image, 10, 225, 120, 180); // bottom label: y 450-810pt
    fillRect(image, 160, 10, 130, 150); // invoices on the right
    fillRect(image, 160, 225, 130, 150);
    fillRect(image, 149, 0, 1, 421); // vertical cut line at x 298pt
    fillRect(image, 0, 207, 300, 1); // horizontal cut line at y 414pt
    const str = 'Tax Invoice/Bill of Supply/Cash Memo';
    const items = [
      { str, top: 7, left: 452 },
      { str, top: 428, left: 452 },
    ];
    const r = detectLabels({ width: 600, height: 842, text: 'Amazon Seller Services', items, image, scale: 0.5 });
    expect(r.map((l) => l.platform)).toEqual(['amazon', 'amazon']);
    expect(r[0].crop).toEqual({ x: 18, y: 18, w: 244, h: 364 });
    expect(r[1].crop).toEqual({ x: 18, y: 448, w: 244, h: 364 });
  });

  // Seen on iPhone: the label image didn't show up in the render, so the only ink in the
  // label column was the dashed cut line and the "label" became a thin strip.
  it('keeps the whole label area when the only ink is a cut line', () => {
    const image = blankImage(300, 421);
    fillRect(image, 160, 10, 130, 150); // invoice on the right
    for (let x = 0; x < 300; x += 6) fillRect(image, x, 207, 3, 1); // dashed cut line at y 414pt
    const items = [{ str: 'Tax Invoice/Bill of Supply/Cash Memo', top: 7, left: 452 }];
    const [r] = detectLabels({ width: 600, height: 842, text: 'Amazon', items, image, scale: 0.5 });
    expect(r.skip).toBe(false);
    expect(r.crop).toEqual({ x: 0, y: 0, w: 294, h: 842 });
  });

  it('keeps the whole label area when the only ink is a thin line in a top-half preset', () => {
    const image = blankImage(300, 421);
    fillRect(image, 0, 100, 300, 1);
    const [r] = detectLabels({ width: 600, height: 842, text: 'Meesho', items: [], image, scale: 0.5 });
    expect(r.crop).toEqual({ x: 0, y: 0, w: 600, h: 421 });
  });
});
