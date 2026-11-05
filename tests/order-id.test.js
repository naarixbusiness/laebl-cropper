import { describe, expect, it } from 'vitest';
import { detectLabels, rowText } from '../src/detect.js';
import { findOrderId } from '../src/order-id.js';

describe('findOrderId', () => {
  it('Meesho: uses the per-label sub-order, not the shared purchase order', () => {
    const text = 'Order No. | ANE-STY-B2-048 | Free Size | 1 | Grey | 347811017375157440_1 | Purchase Order No. 347811017375157440';
    expect(findOrderId('meesho', text)).toEqual({ orderId: '347811017375157440_1', uid: 'meesho:347811017375157440_1' });
  });

  it('Meesho: two sub-orders of one order stay different labels', () => {
    const a = findOrderId('meesho', 'Order No. 347811017375157440_1');
    const b = findOrderId('meesho', 'Order No. 347811017375157440_2');
    expect(a.uid).not.toBe(b.uid);
  });

  it('Meesho: AWB numbers and codes are not taken for the order', () => {
    expect(findOrderId('meesho', 'VL0085963779858 | 380059,5080931 | 1490843287279673 | Bhanupratappur_Nay')).toBeNull();
  });

  it('Flipkart: order ID repeated on the label counts once, AWB is part of the key', () => {
    const text = 'E-Kart | OD339022321741841100 | FMPC6704572730 | Order Id: OD339022321741841100 | AWB No. FMPC6704572730';
    expect(findOrderId('flipkart', text)).toEqual({
      orderId: 'OD339022321741841100',
      uid: 'flipkart:OD339022321741841100:FMPC6704572730',
    });
  });

  it('Flipkart: two packages of one order (different AWB) are different labels', () => {
    const a = findOrderId('flipkart', 'OD339022321741841100 AWB No. FMPC6704572730');
    const b = findOrderId('flipkart', 'OD339022321741841100 AWB No. FMPC6704572999');
    expect(a.uid).not.toBe(b.uid);
  });

  it('Flipkart: works without an AWB', () => {
    expect(findOrderId('flipkart', 'Order Id: OD339022321741841100').uid).toBe('flipkart:OD339022321741841100');
  });

  it('Amazon: order number from the invoice row', () => {
    const text = 'Order Number: | 405-0096731-2268357 | Invoice Details : | GJ-943856953-2627';
    expect(findOrderId('amazon', text)).toEqual({ orderId: '405-0096731-2268357', uid: 'amazon:405-0096731-2268357' });
  });

  it('gives no ID when two different orders are found (ambiguous)', () => {
    expect(findOrderId('amazon', '405-0096731-2268357 407-0388000-3337108')).toBeNull();
    expect(findOrderId('meesho', '347811017375157440_1 347760745837561344_1')).toBeNull();
    expect(findOrderId('flipkart', 'OD339022321741841100 AWB No. FMPC1111111111 AWB No. FMPC2222222222')).toBeNull();
  });

  it('gives no ID for unknown platforms or empty text', () => {
    expect(findOrderId('unknown', '405-0096731-2268357')).toBeNull();
    expect(findOrderId('amazon', '')).toBeNull();
  });

  it('does not match numbers embedded in longer tokens', () => {
    expect(findOrderId('amazon', 'X405-0096731-2268357')).toBeNull();
    expect(findOrderId('amazon', '1405-0096731-2268357')).toBeNull();
    expect(findOrderId('flipkart', 'XOD339022321741841100')).toBeNull();
  });
});

describe('rowText', () => {
  it('takes the whole width of the label band and nothing outside it', () => {
    const items = [
      { str: 'top label', top: 10, left: 0 },
      { str: '405-0096731-2268357', top: 176, left: 358 },
      { str: '407-0388000-3337108', top: 610, left: 358 },
    ];
    expect(rowText(items, { x: 0, y: 0, w: 292, h: 422 })).toBe('top label 405-0096731-2268357');
    expect(rowText(items, { x: 0, y: 422, w: 292, h: 420 })).toBe('407-0388000-3337108');
  });
});

function blankImage(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
}
function ink(img, x, y, w, h) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) img.data[(yy * img.width + xx) * 4] = 0;
}

describe('detectLabels order IDs', () => {
  it('Amazon side-by-side page: each label gets the order of its own row', () => {
    const image = blankImage(595, 842);
    ink(image, 20, 20, 200, 300);
    ink(image, 20, 450, 200, 300);
    const heading = 'Tax Invoice/Bill of Supply/Cash Memo';
    const items = [
      { str: heading, top: 7, left: 452 },
      { str: 'Order Number:', top: 176, left: 318 },
      { str: '405-0096731-2268357', top: 176, left: 358 },
      { str: heading, top: 428, left: 452 },
      { str: 'Order Number:', top: 610, left: 318 },
      { str: '407-0388000-3337108', top: 610, left: 358 },
    ];
    const page = { width: 595, height: 842, text: 'amazon ' + items.map((i) => i.str).join(' '), items, image, scale: 1 };
    expect(detectLabels(page).map((l) => l.orderId)).toEqual(['405-0096731-2268357', '407-0388000-3337108']);
  });

  it('invoice-only pages never get an order ID', () => {
    const items = [
      { str: 'Tax Invoice', top: 20, left: 40 },
      { str: 'Order Id: OD339022321741841100', top: 60, left: 40 },
    ];
    const page = { width: 595, height: 842, text: 'Flipkart ' + items.map((i) => i.str).join(' '), items, image: blankImage(595, 842), scale: 1 };
    const [only] = detectLabels(page);
    expect(only).toMatchObject({ skip: true, reason: 'invoice page', orderId: null, uid: null });
  });
});
