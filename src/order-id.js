// Order IDs identify a label across PDFs: the same order sent twice is printed once,
// and print history remembers which orders were already printed.
//
// A label only gets an ID when exactly one distinct order number is found for it.
// Anything ambiguous gets none — such a label is never merged or marked printed,
// because a wrong match would silently drop a real label from the print.

const ORDER_PATTERNS = {
  // Sub-order number on the label ("347811017375157440_1"): unique per label, unlike
  // the invoice's "Purchase Order No.", which several labels of one order share.
  meesho: /(?<![\w-])\d{10,22}_\d{1,3}(?![\w-])/g,
  flipkart: /(?<![\w-])OD\d{12,24}(?![\w-])/g,
  amazon: /(?<![\w-])\d{3}-\d{7}-\d{7}(?![\w-])/g,
};

// One Flipkart order can ship in several packages; the AWB tells them apart.
const AWB_PATTERNS = {
  flipkart: /AWB\s*No\.?\s*:?\s*([A-Z0-9]{8,25})(?![\w-])/gi,
};

function distinct(text, re, group = 0) {
  return [...new Set([...text.matchAll(re)].map((m) => m[group].toUpperCase()))];
}

// text: everything printed on the label (and, for Amazon, the invoice beside it).
// Returns { orderId, uid } or null. uid is what duplicates and print history match on.
export function findOrderId(platform, text) {
  const pattern = ORDER_PATTERNS[platform];
  if (!pattern || !text) return null;
  const orders = distinct(text, pattern);
  if (orders.length !== 1) return null;
  const [orderId] = orders;
  const awbs = AWB_PATTERNS[platform] ? distinct(text, AWB_PATTERNS[platform], 1) : [];
  if (awbs.length > 1) return null;
  return { orderId, uid: [platform, orderId, ...awbs].join(':') };
}

// Labels that are pure images have no text to read; their AWB barcode identifies the
// shipment instead. Exactly one distinct barcode is required, as with order numbers.
export function awbId(codes) {
  const valid = [...new Set(codes.map((c) => c.trim().toUpperCase()))].filter((c) => /^[A-Z0-9]{8,30}$/.test(c));
  if (valid.length !== 1) return null;
  return { orderId: `AWB ${valid[0]}`, uid: `awb:${valid[0]}` };
}
