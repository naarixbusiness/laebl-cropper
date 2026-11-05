// Reads the AWB barcode of labels that are pure images (no text to read the order ID
// from), e.g. Amazon Seller app labels. Code 128 has a checksum, so a successful read
// is exact — a wrong ID would wrongly merge labels or mark them printed.

import { BinaryBitmap, Code128Reader, DecodeHintType, HybridBinarizer, RGBLuminanceSource } from '@zxing/library';

const BANDS = 6; // the image is scanned in overlapping horizontal bands

// image: { width, height, data: RGBA }. Returns every distinct Code 128 value found.
export function readCode128(image) {
  const { width, height, data } = image;
  const lum = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
    // Transparent pixels count as white paper.
    lum[i] = data[p + 3] < 128 ? 255 : (data[p] + 2 * data[p + 1] + data[p + 2]) >> 2;
  }
  const hints = new Map([[DecodeHintType.TRY_HARDER, true]]);
  const found = new Set();
  const step = Math.ceil(height / BANDS);
  // Each band is two steps tall, so a barcode on a band edge is still whole in one band.
  for (let y = 0; y < height; y += step) {
    const bandHeight = Math.min(2 * step, height - y);
    if (bandHeight < 16) break;
    const source = new RGBLuminanceSource(lum.subarray(y * width, (y + bandHeight) * width), width, bandHeight);
    try {
      found.add(new Code128Reader().decode(new BinaryBitmap(new HybridBinarizer(source)), hints)?.getText());
    } catch {
      // nothing in this band
    }
  }
  found.delete(undefined);
  return [...found];
}
