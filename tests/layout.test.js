import { describe, expect, it } from 'vitest';
import { A4, PAGE_MARGIN, chunk, computeCutLines, computeSlots, placeInSlot } from '../src/layout.js';

describe('computeSlots', () => {
  it.each([
    [1, 1, 1],
    [2, 1, 2],
    [3, 1, 3],
    [4, 2, 2],
    [5, 2, 3],
    [6, 2, 3],
    [7, 2, 4],
    [8, 2, 4],
    [9, 3, 3],
  ])('%i per page -> %i cols x %i rows inside the margins', (n, cols, rows) => {
    const slots = computeSlots(n);
    expect(slots).toHaveLength(n);
    expect(slots[0].width).toBeCloseTo((A4.width - 2 * PAGE_MARGIN - (cols - 1) * 6) / cols);
    expect(slots[0].height).toBeCloseTo((A4.height - 2 * PAGE_MARGIN - (rows - 1) * 6) / rows);
    for (const s of slots) {
      expect(s.x).toBeGreaterThanOrEqual(PAGE_MARGIN - 1e-9);
      expect(s.y).toBeGreaterThanOrEqual(PAGE_MARGIN - 1e-9);
      expect(s.x + s.width).toBeLessThanOrEqual(A4.width - PAGE_MARGIN + 1e-9);
      expect(s.y + s.height).toBeLessThanOrEqual(A4.height - PAGE_MARGIN + 1e-9);
    }
  });

  it('orders slots left-to-right then top-to-bottom', () => {
    const [a, b, c] = computeSlots(4);
    expect(b.x).toBeGreaterThan(a.x);
    expect(b.y).toBeCloseTo(a.y);
    expect(c.y).toBeLessThan(a.y);
  });

  it('slots do not overlap', () => {
    const slots = computeSlots(6);
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i];
        const b = slots[j];
        const overlap =
          a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    }
  });

  it('rejects unsupported counts', () => {
    expect(() => computeSlots(0)).toThrow();
    expect(() => computeSlots(10)).toThrow();
  });
});

describe('computeCutLines', () => {
  it('2x2 has one vertical and one horizontal line', () => {
    expect(computeCutLines(4)).toHaveLength(2);
  });
  it('5 per page still cuts the full 2x3 grid', () => {
    expect(computeCutLines(5)).toHaveLength(3);
  });
  it('3x3 has two lines each way', () => {
    expect(computeCutLines(9)).toHaveLength(4);
  });
  it('single label has none', () => {
    expect(computeCutLines(1)).toHaveLength(0);
  });
});

// Corners of the drawn content after pdf-lib's counter-clockwise rotation about (x, y).
function drawnBounds({ x, y, width, height, rotate }) {
  const rad = (rotate * Math.PI) / 180;
  const pts = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ].map(([px, py]) => [x + px * Math.cos(rad) - py * Math.sin(rad), y + px * Math.sin(rad) + py * Math.cos(rad)]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function expectInside(slot, b) {
  const eps = 1e-6;
  expect(b.minX).toBeGreaterThanOrEqual(slot.x - eps);
  expect(b.minY).toBeGreaterThanOrEqual(slot.y - eps);
  expect(b.maxX).toBeLessThanOrEqual(slot.x + slot.width + eps);
  expect(b.maxY).toBeLessThanOrEqual(slot.y + slot.height + eps);
}

describe('placeInSlot', () => {
  const slot = { x: 10, y: 20, width: 200, height: 300 };

  it('fits a portrait label upright, keeps aspect ratio, centers it', () => {
    const p = placeInSlot(slot, 100, 200);
    expect(p.rotate).toBe(0);
    expect(p.width / p.height).toBeCloseTo(0.5);
    const b = drawnBounds(p);
    expectInside(slot, b);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(slot.x + slot.width / 2);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(slot.y + slot.height / 2);
  });

  it('turns a landscape label 90° when that makes it bigger', () => {
    const p = placeInSlot(slot, 300, 150);
    expect(p.rotate).toBe(90);
    expectInside(slot, drawnBounds(p));
    expect(p.width).toBeCloseTo(300); // limited by slot height
  });

  it.each([90, 180, 270])('handles source page /Rotate %i', (rot) => {
    const p = placeInSlot(slot, 150, 120, rot);
    const b = drawnBounds(p);
    expectInside(slot, b);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(slot.x + slot.width / 2);
    expect((b.minY + b.maxY) / 2).toBeCloseTo(slot.y + slot.height / 2);
  });
});

describe('chunk', () => {
  it('splits 9 labels into sheets of 4', () => {
    expect(chunk([1, 2, 3, 4, 5, 6, 7, 8, 9], 4).map((c) => c.length)).toEqual([4, 4, 1]);
  });
});
