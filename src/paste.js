// Files pasted as base64 text. iPhone (WebKit) never hands a copied PDF *file* to a web
// page — only images — but text pastes fine, so an iOS Shortcut copies the file as base64
// and the app turns it back into the exact original file.

import { fileKind } from './image-input.js';

// base64 of the first bytes of a PDF ("%PDF-"), PNG and JPEG file.
const FILE_STARTS = ['JVBERi0', 'iVBORw0KGgo', '/9j/'];

// All PDFs and label images found in the text, as bytes. One file per line, or one file
// wrapped over several lines (Shortcuts can break base64 every 64/76 characters) — a line
// starting like a file header begins the next file. Anything else is skipped.
export function filesFromText(text) {
  if (!text) return [];
  const blocks = [];
  for (let token of text.split(/\s+/)) {
    token = token.replace(/^data:[^,]*;base64,/i, '');
    if (!token) continue;
    if (FILE_STARTS.some((start) => token.startsWith(start))) blocks.push(token);
    else if (blocks.length) blocks[blocks.length - 1] += token;
  }
  return blocks.map(decode).filter(Boolean);
}

function decode(b64) {
  try {
    const standard = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    const binary = atob(standard + '='.repeat((4 - (standard.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return fileKind(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

// Name for a pasted file, from its contents. Files are deduped by name + size, so a fixed
// name would wrongly call two different files of equal size "already added".
export function contentName(bytes) {
  let hash = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  const ext = { pdf: 'pdf', png: 'png', jpeg: 'jpg' }[fileKind(bytes)] ?? 'bin';
  return `Pasted label ${(hash >>> 0).toString(16).padStart(8, '0')}.${ext}`;
}
