'use strict';
/** Generates realistic drawing-set and spec-book PDFs for tests (text layers, title blocks, running headers). */
const { PDFDocument, StandardFonts, degrees } = require('pdf-lib');

async function drawingSet(sheets, { rotateLast = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const [i, s] of sheets.entries()) {
    const W = 1728; const H = 1152; // ARCH D (24x36) landscape at 48 pt/in
    // Plotters often emit portrait media with /Rotate 90 and rotated text so the sheet displays upright.
    const rotated = rotateLast && i === sheets.length - 1;
    const page = rotated ? doc.addPage([H, W]) : doc.addPage([W, H]);
    if (rotated) page.setRotation(degrees(90));
    if (s.blank) continue; // simulates a scanned sheet with no text layer
    const t = (text, x, y, size = 9, f = font) => (rotated
      ? page.drawText(text, { x: H - y, y: x, size, font: f, rotate: degrees(90) })
      : page.drawText(text, { x, y, size, font: f }));
    // Drawing area noise: notes, detail bubbles referencing other sheets, dimensions.
    t('GENERAL NOTES', 60, H - 80, 14, bold);
    t('1. ALL DIMENSIONS ARE TO FACE OF STUD UNLESS NOTED OTHERWISE.', 60, H - 100);
    t('SEE 5/A-501 FOR TYPICAL WALL SECTION', 400, 600, 10);
    t('A-501', 700, 500, 12);
    t("12'-6\"", 800, 700, 10);
    t('LEVEL 2 PLAN', 300, 220, 18, bold);
    t('SCALE: 1/8" = 1\'-0"', 300, 200, 9);
    // Title block (right strip).
    const x = W - 300;
    t('STUDIO MERIDIAN ARCHITECTS', x, 520, 11, bold);
    t('1200 HARBOR BLVD, SAN FRANCISCO CA', x, 505, 8);
    t('PROJECT', x, 460, 7);
    t('HARBORVIEW MEDICAL OFFICE BUILDING', x, 446, 10, bold);
    t('REV  DATE        DESCRIPTION', x, 400, 7);
    for (const [k, r] of (s.revs || (s.rev ? [s.rev] : [])).entries()) t(`${r}    ${s.date || '03/15/2026'}  ${k ? 'ADDENDUM ' + k : 'ISSUED FOR CONSTRUCTION'}`, x, 388 - k * 12, 7);
    t(`DATE: ${s.date || '03/15/2026'}`, x, 340, 8);
    t('DRAWN BY: DK   CHECKED BY: JB', x, 326, 8);
    if (s.labelled !== false) t('SHEET TITLE', x, 280, 7);
    s.title.split('\n').forEach((line, j) => t(line, x, 262 - j * 18, 14, bold));
    if (s.labelled !== false) t('SHEET NO.', x, 150, 7);
    t(s.number, x, 100, 40, bold);
  }
  return Buffer.from(await doc.save());
}

async function specBook(sections) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const W = 612; const H = 792;
  const add = (lines) => {
    const page = doc.addPage([W, H]);
    lines.forEach(([text, size = 11, y], j) => page.drawText(text, { x: 72, y: y ?? H - 72 - j * 18, size, font }));
  };
  add([['PROJECT MANUAL', 24, 600], ['HARBORVIEW MEDICAL OFFICE BUILDING', 14, 560]]);
  add([['TABLE OF CONTENTS', 14], ...sections.map((s) => [`SECTION ${s.number} ${s.title.toUpperCase()}`])]);
  for (const s of sections) {
    for (let p = 0; p < s.pages; p++) {
      const lines = [];
      if (p === 0) {
        lines.push(s.inlineTitle ? [`SECTION ${s.number} - ${s.title.toUpperCase()}`, 12] : [`SECTION ${s.number}`, 12]);
        if (!s.inlineTitle) lines.push([s.title.toUpperCase(), 12]);
        lines.push(['PART 1 - GENERAL'], ['1.1 SUMMARY'], ['A. Section includes work described herein.']);
      } else {
        lines.push([`Harborview MOB  ${s.number} - ${p + 1}`, 8], ['A. Continue requirements as specified.']);
      }
      if (p === s.pages - 1) lines.push(['END OF SECTION']);
      add(lines);
    }
  }
  return Buffer.from(await doc.save());
}

module.exports = { drawingSet, specBook };
