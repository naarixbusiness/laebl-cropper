// Live preview of one A4 sheet, drawn from the label thumbnails with the same
// layout math the PDF export uses.
import { A4, computeCutLines, computeSlots, placeInSlot } from './layout.js';

// labels: [{ thumb: canvas, crop: { w, h } }] for this sheet.
export function drawSheetPreview(canvas, labels, perPage, { cutLines = true } = {}) {
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 300;
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssWidth * (A4.height / A4.width) * ratio);
  const k = canvas.width / A4.width;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const slots = computeSlots(perPage);
  // Empty slots, so the grid is visible before any labels are added.
  ctx.fillStyle = '#f3f5f8';
  for (const slot of slots.slice(labels.length)) {
    ctx.fillRect(slot.x * k, (A4.height - slot.y - slot.height) * k, slot.width * k, slot.height * k);
  }

  if (cutLines) {
    ctx.save();
    ctx.strokeStyle = '#b4bcc6';
    ctx.lineWidth = Math.max(1, 0.5 * k);
    ctx.setLineDash([4 * k, 4 * k]);
    for (const l of computeCutLines(perPage)) {
      ctx.beginPath();
      ctx.moveTo(l.x1 * k, (A4.height - l.y1) * k);
      ctx.lineTo(l.x2 * k, (A4.height - l.y2) * k);
      ctx.stroke();
    }
    ctx.restore();
  }

  labels.forEach((label, i) => {
    const p = placeInSlot(slots[i], label.crop.w, label.crop.h, 0);
    ctx.save();
    // PDF space (y up, counter-clockwise rotation) -> canvas space (y down).
    ctx.translate(p.x * k, (A4.height - p.y) * k);
    ctx.rotate((-p.rotate * Math.PI) / 180);
    ctx.drawImage(label.thumb, 0, -p.height * k, p.width * k, p.height * k);
    ctx.restore();
  });
}
