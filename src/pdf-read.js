import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// pdf.js takes ownership of the buffer it is given, so hand it a copy and keep
// the original bytes for pdf-lib.
export function openPdf(bytes) {
  return pdfjs.getDocument({ data: bytes.slice() }).promise;
}

// pdf.js 6 has no doc.destroy(); the loading task owns the worker-side document.
export function closePdf(doc) {
  return doc.loadingTask.destroy();
}

export function isPasswordError(err) {
  return err?.name === 'PasswordException';
}

export async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

// Everything detectLabel() needs, in view space (points, top-left origin).
export async function readPage(page, scale) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = content.items
    .filter((it) => it.str?.trim())
    .map((it) => {
      const [, , c, d, e, f] = pdfjs.Util.transform(viewport.transform, it.transform);
      return { str: it.str, top: f - Math.hypot(c, d), left: e };
    });
  const canvas = await renderPage(page, scale);
  const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  return {
    width: viewport.width,
    height: viewport.height,
    text: items.map((it) => it.str).join(' '),
    items,
    image,
    scale,
    canvas,
  };
}

// View-space crop -> PDF user-space box for pdf-lib embedPage.
export function viewCropToPdfBox(page, crop) {
  const viewport = page.getViewport({ scale: 1 });
  const [ax, ay] = viewport.convertToPdfPoint(crop.x, crop.y);
  const [bx, by] = viewport.convertToPdfPoint(crop.x + crop.w, crop.y + crop.h);
  return {
    left: Math.min(ax, bx),
    right: Math.max(ax, bx),
    bottom: Math.min(ay, by),
    top: Math.max(ay, by),
  };
}

// Copy the cropped part of a rendered page into a small canvas for the preview grid.
export function cropCanvas(source, crop, scale) {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(crop.w * scale));
  out.height = Math.max(1, Math.round(crop.h * scale));
  out
    .getContext('2d')
    .drawImage(source, crop.x * scale, crop.y * scale, crop.w * scale, crop.h * scale, 0, 0, out.width, out.height);
  return out;
}
