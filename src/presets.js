// Fallback when no invoice heading is found on a page: keep the top part of the
// page (fraction of page height). Whitespace trimming then tightens the box.
// Rough values — calibrate against real sample PDFs.
export const LABEL_HEIGHT_FRACTION = {
  meesho: 0.5,
  flipkart: 0.47,
  amazon: 0.5,
  unknown: 1,
};
