import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { A4, chunk, computeCutLines, computeSlots, placeInSlot } from './layout.js';

// Can pdf-lib copy pages out of this PDF? Encrypted PDFs (common for marketplace
// labels, owner-password only) can't be decoded by pdf-lib; those get rasterised.
export async function canEmbedVector(bytes) {
  try {
    await PDFDocument.load(bytes);
    return true;
  } catch {
    return false;
  }
}

// labels: [{ fileId, pageIndex, pdfBox: { left, bottom, right, top }, rotation, vector }]
// files: Map fileId -> Uint8Array (original PDF bytes)
// renderPng(label): PNG bytes of the cropped label, upright — used when !label.vector.
export async function buildSheets(labels, files, perPage, renderPng, { cutLines: withCutLines = true } = {}) {
  const out = await PDFDocument.create();
  const sources = new Map();
  const sourceFor = async (fileId) => {
    if (!sources.has(fileId)) sources.set(fileId, await PDFDocument.load(files.get(fileId)));
    return sources.get(fileId);
  };

  const slots = computeSlots(perPage);
  const cutLines = withCutLines ? computeCutLines(perPage) : [];

  for (const sheetLabels of chunk(labels, perPage)) {
    const sheet = out.addPage([A4.width, A4.height]);
    for (const line of cutLines) {
      sheet.drawLine({
        start: { x: line.x1, y: line.y1 },
        end: { x: line.x2, y: line.y2 },
        thickness: 0.5,
        color: rgb(0.7, 0.7, 0.7),
        dashArray: [4, 4],
      });
    }
    for (const [i, label] of sheetLabels.entries()) {
      const box = label.pdfBox;
      if (label.vector) {
        const src = await sourceFor(label.fileId);
        const embedded = await out.embedPage(src.getPage(label.pageIndex), box);
        const p = placeInSlot(slots[i], box.right - box.left, box.top - box.bottom, label.rotation);
        sheet.drawPage(embedded, { x: p.x, y: p.y, width: p.width, height: p.height, rotate: degrees(p.rotate) });
      } else {
        const image = await out.embedPng(await renderPng(label));
        const p = placeInSlot(slots[i], image.width, image.height, 0);
        sheet.drawImage(image, { x: p.x, y: p.y, width: p.width, height: p.height, rotate: degrees(p.rotate) });
      }
    }
  }
  return out.save();
}
