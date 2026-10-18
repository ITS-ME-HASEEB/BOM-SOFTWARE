// make-invoice-template.mjs — regenerate app/template.pdf (the invoice the
// print system fills in) with the current demo branding.
//
// The old template was a Word export that had the previous company's logo,
// name, address, phone and website baked into every page. This script builds
// the same 4-page "Sales Receipt" layout from scratch with pdf-lib so the
// geometry the renderer draws into (see printInvoice() in app/app.js) stays
// identical while the branding stays generic:
//
//   * page size A4 portrait (595.32 x 841.92 pt), 4 copies:
//     pages 1-3 "Office Copy", page 4 "Customer Copy"
//   * logo top-left, brand block under it (name + placeholder contact lines)
//   * right-hand label column at x=318.43 (Customer Name / Address / Ph no /
//     Date) — the renderer erases and redraws "Ph no:"/"Date:" at exactly
//     (318.43, 581.71) / (318.43, 561.79) in HelveticaBold 14.04
//   * 3-column table (S.No / Description / Qty) with the row grid the
//     renderer's calibrated row Y positions (image units 1241x1754) map onto
//
// Run: npm run build:invoice   (needs `npm install` first, pdf-lib devDep)
import fs from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const here = new URL('.', import.meta.url);
const logoPath = new URL('../app/logo.png', here);
const outPath = new URL('../app/template.pdf', here);

const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.35, 0.35, 0.35);
const LINK = rgb(0.275, 0.471, 0.525);   // same blue the old template used
const BAND = rgb(0.93, 0.93, 0.93);

const doc = await PDFDocument.create();
doc.setTitle('Demo — Sales Receipt');
doc.setAuthor('Demo');
doc.setSubject('BOM & Production demo invoice template');
doc.setCreator('Demo BOM & Production');
doc.setProducer('Demo BOM & Production');

const helv = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const logo = await doc.embedPng(fs.readFileSync(logoPath));

// ---- table geometry (points, bottom-left origin) ----
const LEFT = 25.92, RIGHT = 569.64;
const COLS = [90.384, 495.7];                       // vertical separators
const ROWS = [494.35, 474.31, 439.51, 404.55, 369.51, 334.47, 299.55, 264.51, 226.7];
const HEADER_SIZE = 17.04, HEADER_Y = 478.63;

for (let pageIdx = 0; pageIdx < 4; pageIdx++) {
  const page = doc.addPage([595.32, 841.92]);
  const copyLabel = pageIdx < 3 ? 'Office Copy' : 'Customer Copy';

  // ---- logo (square, same footprint as the old 125.4 x 111.72 image box) ----
  const LOGO = 111.72;
  page.drawImage(logo, { x: 107.34 - LOGO / 2, y: 658.2, width: LOGO, height: LOGO });

  // ---- brand block (demo name + generic placeholder contact lines) ----
  page.drawText('Demo', { x: 42.12, y: 617.02, size: 16, font: bold, color: BLACK });
  page.drawText('BOM & Production', { x: 42.12, y: 602.5, size: 10.5, font: helv, color: GRAY });
  page.drawText('123 Demo Street, Demo City 00000', { x: 42.12, y: 587, size: 10.5, font: helv, color: BLACK });
  const site = 'www.demo.example';
  page.drawText(site, { x: 42.12, y: 571.5, size: 10.5, font: helv, color: LINK });
  page.drawRectangle({ x: 42.12, y: 568.9, width: helv.widthOfTextAtSize(site, 10.5), height: 0.9, color: LINK });
  page.drawText('(000) 000-0000', { x: 42.12, y: 553, size: 10.5, font: helv, color: BLACK });

  // ---- title ----
  page.drawText('Sales Receipt', { x: 324.07, y: 706.66, size: 26.04, font: bold, color: BLACK });

  // ---- right-hand labels (renderer overwrites the last two) ----
  for (const [text, y] of [
    ['Customer Name:', 620.38],
    ['Address:', 601.06],
    ['Ph no:', 581.71],
    ['Date:', 561.79],
  ]) page.drawText(text, { x: 318.43, y, size: 14.04, font: bold, color: BLACK });

  // ---- table ----
  page.drawRectangle({ x: LEFT, y: ROWS[1], width: RIGHT - LEFT, height: ROWS[0] - ROWS[1], color: BAND });
  for (const y of ROWS) {
    page.drawLine({ start: { x: LEFT, y }, end: { x: RIGHT, y }, thickness: 0.48, color: BLACK });
  }
  for (const x of [LEFT, ...COLS, RIGHT]) {
    page.drawLine({ start: { x, y: ROWS[ROWS.length - 1] }, end: { x, y: ROWS[0] }, thickness: 0.48, color: BLACK });
  }
  page.drawText('S.No', { x: 38.88, y: HEADER_Y, size: HEADER_SIZE, font: bold, color: BLACK });
  page.drawText('Description', { x: 246.29, y: HEADER_Y, size: HEADER_SIZE, font: bold, color: BLACK });
  page.drawText('Qty', { x: 518.26, y: HEADER_Y, size: HEADER_SIZE, font: bold, color: BLACK });

  // ---- footer copy label ----
  page.drawText(copyLabel, { x: 72.024, y: 85.344, size: 15.96, font: helv, color: BLACK });
}

const bytes = await doc.save();
fs.writeFileSync(outPath, bytes);
console.log(`template.pdf written: ${bytes.length} bytes, ${doc.getPageCount()} pages`);
