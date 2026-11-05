// Label images (PNG / JPEG) are turned into a one-page PDF so the rest of the app only
// ever deals with PDFs. The Amazon Seller app hands out labels as PNG images (often with
// no file extension), and as PDFs that only wrap such an image.

import { PDFDocument } from 'pdf-lib';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const LABEL_SHORT_SIDE = 288; // pt: 4 in, like a 4x6 in label

// 'pdf' | 'png' | 'jpeg' | null — from the bytes, never the name (files may have none).
export function fileKind(bytes) {
  if (PNG_MAGIC.every((b, i) => bytes[i] === b)) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  // Some PDFs carry a few junk bytes before the header.
  if (latin1(bytes.subarray(0, 1024)).includes('%PDF-')) return 'pdf';
  return null;
}

// PDF bytes stay as they are; images become a PDF page of the same aspect ratio.
// platformHint: a platform known from the file itself (not its contents), or null.
export async function asPdfBytes(bytes) {
  const kind = fileKind(bytes);
  if (kind === 'pdf') return { bytes, platformHint: null };
  if (!kind) throw new Error('not a PDF or label image');
  const doc = await PDFDocument.create();
  const image = kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const scale = LABEL_SHORT_SIDE / Math.min(image.width, image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  doc.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  return { bytes: await doc.save(), platformHint: kind === 'png' ? pngPlatform(bytes) : null };
}

// Amazon renders its shipping labels with Labelary (a ZPL renderer), which signs the PNG
// with a "Source: Labelary" text chunk. Meesho and Flipkart labels arrive as PDFs.
export function pngPlatform(bytes) {
  return pngText(bytes).Source === 'Labelary' ? 'amazon' : null;
}

// tEXt chunks of a PNG: { keyword: text }.
export function pngText(bytes) {
  const out = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = PNG_MAGIC.length;
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos);
    const type = latin1(bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, Math.min(pos + 8 + length, bytes.length));
    if (type === 'tEXt') {
      const sep = data.indexOf(0);
      if (sep > 0) out[latin1(data.subarray(0, sep))] = latin1(data.subarray(sep + 1));
    }
    if (type === 'IEND') break;
    pos += 12 + length;
  }
  return out;
}

function latin1(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
