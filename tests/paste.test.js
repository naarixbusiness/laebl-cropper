import { describe, expect, it } from 'vitest';
import { contentName, filesFromText } from '../src/paste.js';

const pdf = (body) => new TextEncoder().encode(`%PDF-1.4\n${body}\n%%EOF`);
const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const wrap = (s, n) => s.match(new RegExp(`.{1,${n}}`, 'g')).join('\n');
const text = (bytes) => new TextDecoder().decode(bytes);

describe('filesFromText', () => {
  const a = pdf('first label '.repeat(20));
  const b = pdf('second label '.repeat(30));

  it('decodes a single PDF on one line', () => {
    expect(filesFromText(b64(a)).map(text)).toEqual([text(a)]);
  });

  it('decodes a PDF wrapped every 76 or 64 characters', () => {
    expect(filesFromText(wrap(b64(a), 76)).map(text)).toEqual([text(a)]);
    expect(filesFromText(wrap(b64(a), 64)).map(text)).toEqual([text(a)]);
  });

  it('splits several PDFs, one per line or each wrapped', () => {
    expect(filesFromText(`${b64(a)}\n${b64(b)}`).map(text)).toEqual([text(a), text(b)]);
    expect(filesFromText(`${wrap(b64(a), 76)}\n${wrap(b64(b), 76)}\n`).map(text)).toEqual([text(a), text(b)]);
  });

  it('accepts a data: URL and the URL-safe alphabet', () => {
    expect(filesFromText(`data:application/pdf;base64,${b64(a)}`).map(text)).toEqual([text(a)]);
    const urlSafe = b64(a).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(filesFromText(urlSafe).map(text)).toEqual([text(a)]);
  });

  it('returns nothing for text that is not a PDF', () => {
    expect(filesFromText('')).toEqual([]);
    expect(filesFromText('hello world')).toEqual([]);
    expect(filesFromText(btoa('just some text, not a pdf'))).toEqual([]);
  });

  it('skips a corrupt block but keeps the valid ones', () => {
    expect(filesFromText(`${b64(a)}\nJVBERi0x!!!broken\n${b64(b)}`).map(text)).toEqual([text(a), text(b)]);
  });
});

describe('contentName', () => {
  it('is stable for the same bytes and differs for different bytes of the same size', () => {
    const x = pdf('aaaa');
    const y = pdf('aaab');
    expect(contentName(x)).toBe(contentName(pdf('aaaa')));
    expect(contentName(x)).not.toBe(contentName(y));
    expect(contentName(x)).toMatch(/^Pasted label [0-9a-f]{8}\.pdf$/);
  });
});

describe('filesFromText with images', () => {
  // 1x1 PNG
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  it('decodes a base64 PNG next to a PDF', () => {
    const pdfBytes = new TextEncoder().encode('%PDF-1.4\nx\n%%EOF');
    const found = filesFromText(`${png}\n${btoa(String.fromCharCode(...pdfBytes))}`);
    expect(found).toHaveLength(2);
    expect(found[0][1]).toBe(0x50); // "P" of the PNG signature
    expect(contentName(found[0])).toMatch(/\.png$/);
    expect(contentName(found[1])).toMatch(/\.pdf$/);
  });
});
