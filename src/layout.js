// A4 sheet layout math. All values are PDF points, origin bottom-left.

export const A4 = { width: 595.28, height: 841.89 };
export const PAGE_MARGIN = 10;
export const SLOT_GAP = 6;

// Labels per sheet -> grid. 5 and 7 use the 6 and 8 grids with the last cell left empty,
// so labels stay as big as possible instead of being squeezed into thin strips.
const GRIDS = {
  1: { cols: 1, rows: 1 },
  2: { cols: 1, rows: 2 },
  3: { cols: 1, rows: 3 },
  4: { cols: 2, rows: 2 },
  5: { cols: 2, rows: 3 },
  6: { cols: 2, rows: 3 },
  7: { cols: 2, rows: 4 },
  8: { cols: 2, rows: 4 },
  9: { cols: 3, rows: 3 },
};

export const SUPPORTED_PER_PAGE = Object.keys(GRIDS).map(Number);

export function gridFor(perPage) {
  const grid = GRIDS[perPage];
  if (!grid) throw new Error(`Unsupported labels per page: ${perPage}`);
  return grid;
}

// Slots ordered left-to-right, top-to-bottom.
export function computeSlots(perPage, page = A4) {
  const { cols, rows } = gridFor(perPage);
  const width = (page.width - 2 * PAGE_MARGIN - (cols - 1) * SLOT_GAP) / cols;
  const height = (page.height - 2 * PAGE_MARGIN - (rows - 1) * SLOT_GAP) / rows;
  const slots = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      slots.push({
        x: PAGE_MARGIN + c * (width + SLOT_GAP),
        y: page.height - PAGE_MARGIN - (r + 1) * height - r * SLOT_GAP,
        width,
        height,
      });
    }
  }
  return slots.slice(0, perPage);
}

// Dashed cut lines through the middle of each gap between slots.
export function computeCutLines(perPage, page = A4) {
  const { cols, rows } = gridFor(perPage);
  const slots = computeSlots(cols * rows, page);
  const lines = [];
  for (let c = 1; c < cols; c++) {
    const x = slots[c].x - SLOT_GAP / 2;
    lines.push({ x1: x, y1: PAGE_MARGIN, x2: x, y2: page.height - PAGE_MARGIN });
  }
  for (let r = 1; r < rows; r++) {
    const y = slots[r * cols].y + slots[r * cols].height + SLOT_GAP / 2;
    lines.push({ x1: PAGE_MARGIN, y1: y, x2: page.width - PAGE_MARGIN, y2: y });
  }
  return lines;
}

// Where to draw a cropped page region inside a slot.
// contentWidth/Height: size of the crop box in the source page's own (unrotated) space.
// pageRotation: the source page's /Rotate (clockwise degrees), so the label appears
// the way a PDF viewer shows it. An extra 90° turn is added when it makes the label
// noticeably bigger in the slot.
// Returns args for pdf-lib drawPage: { x, y, width, height, rotate } where rotate is
// counter-clockwise degrees around (x, y).
export function placeInSlot(slot, contentWidth, contentHeight, pageRotation = 0) {
  const sideways = ((pageRotation % 180) + 180) % 180 === 90;
  const shownW = sideways ? contentHeight : contentWidth;
  const shownH = sideways ? contentWidth : contentHeight;

  const scaleUpright = Math.min(slot.width / shownW, slot.height / shownH);
  const scaleTurned = Math.min(slot.width / shownH, slot.height / shownW);
  const turn = scaleTurned > scaleUpright * 1.05 ? 90 : 0;
  const scale = turn ? scaleTurned : scaleUpright;

  const rotate = (((turn - pageRotation) % 360) + 360) % 360;
  const width = contentWidth * scale;
  const height = contentHeight * scale;
  const boxW = rotate % 180 === 0 ? width : height;
  const boxH = rotate % 180 === 0 ? height : width;
  const bx = slot.x + (slot.width - boxW) / 2;
  const by = slot.y + (slot.height - boxH) / 2;

  // pdf-lib rotates around the draw origin; shift the origin so the rotated
  // content lands exactly on the centered box.
  const origin = {
    0: [bx, by],
    90: [bx + height, by],
    180: [bx + width, by + height],
    270: [bx, by + width],
  }[rotate];

  return { x: origin[0], y: origin[1], width, height, rotate };
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
