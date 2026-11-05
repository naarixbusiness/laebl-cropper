// PDFs pasted as base64 text. iPhone (WebKit) never hands a copied PDF *file* to a web
// page — only images — but text pastes fine, so an iOS Shortcut copies the PDF as base64
// and the app turns it back into the exact original file.

const PDF_START = 'JVBERi0'; // base64 of "%PDF-"
const PDF_MAGIC = '%PDF-';

// All PDFs found in the text, as bytes. One PDF per line, or one PDF wrapped over
// several lines (Shortcuts can break base64 every 64/76 characters) — a line starting
// with "%PDF-" in base64 begins the next PDF. Anything that isn't a valid PDF is skipped.
export function pdfsFromText(text) {
  if (!text) return [];
  const blocks = [];
  for (let token of text.split(/\s+/)) {
    token = token.replace(/^data:[^,]*;base64,/i, '');
    if (!token) continue;
    if (token.startsWith(PDF_START)) blocks.push(token);
    else if (blocks.length) blocks[blocks.length - 1] += token;
  }
  return blocks.map(decode).filter(Boolean);
}

function decode(b64) {
  try {
    const standard = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    const binary = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4));
    if (!binary.startsWith(PDF_MAGIC)) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// Name for a pasted PDF, from its contents. Files are deduped by name + size, so a fixed
// name would wrongly call two different PDFs of equal size "already added".
export function contentName(bytes) {
  let hash = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return `Pasted label ${(hash >>> 0).toString(16).padStart(8, '0')}.pdf`;
}
