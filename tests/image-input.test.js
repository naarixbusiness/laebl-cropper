import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { asPdfBytes, fileKind, pngPlatform, pngText } from '../src/image-input.js';

const PNG_1x1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

// A PNG with a tEXt chunk inserted after IHDR (CRCs aren't checked by pngText).
function withText(keyword, text) {
  const enc = new TextEncoder();
  const data = new Uint8Array([...enc.encode(keyword), 0, ...enc.encode(text)]);
  const chunk = new Uint8Array(12 + data.length);
  new DataView(chunk.buffer).setUint32(0, data.length);
  chunk.set(enc.encode('tEXt'), 4);
  chunk.set(data, 8);
  const ihdrEnd = 8 + 12 + 13;
  return new Uint8Array([...PNG_1x1.subarray(0, ihdrEnd), ...chunk, ...PNG_1x1.subarray(ihdrEnd)]);
}

describe('fileKind', () => {
  it('recognises files by their bytes, not their name', () => {
    expect(fileKind(PNG_1x1)).toBe('png');
    expect(fileKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('jpeg');
    expect(fileKind(new TextEncoder().encode('%PDF-1.7\n...'))).toBe('pdf');
    expect(fileKind(new TextEncoder().encode('\n\n%PDF-1.4 after junk'))).toBe('pdf');
    expect(fileKind(new TextEncoder().encode('hello'))).toBeNull();
  });
});

describe('PNG source', () => {
  it('reads tEXt chunks and treats Labelary images as Amazon labels', () => {
    const labelary = withText('Source', 'Labelary');
    expect(pngText(labelary)).toEqual({ Source: 'Labelary' });
    expect(pngPlatform(labelary)).toBe('amazon');
    expect(pngPlatform(withText('Source', 'Photoshop'))).toBeNull();
    expect(pngPlatform(PNG_1x1)).toBeNull();
  });
});

describe('asPdfBytes', () => {
  it('leaves PDFs untouched', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4\n%%EOF');
    expect((await asPdfBytes(pdf)).bytes).toBe(pdf);
  });

  it('wraps an image in a one-page PDF of the same aspect ratio', async () => {
    const { bytes, platformHint } = await asPdfBytes(withText('Source', 'Labelary'));
    expect(platformHint).toBe('amazon');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 288, height: 288 });
  });

  it('rejects anything else', async () => {
    await expect(asPdfBytes(new TextEncoder().encode('hello'))).rejects.toThrow();
  });
});
