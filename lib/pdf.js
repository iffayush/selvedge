// Render a structured resume to an ATS-friendly PDF: one column, real text, standard headings.
// By default it shrinks text and spacing step by step until the resume fits on one page.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';

const { version } = createRequire(import.meta.url)('../package.json');

// Who made the file: stored only in the PDF's document properties (Creator / Producer).
// Nothing is drawn on the page, so ATS software and recruiters reading the résumé never see it.
export const PDF_CREATOR = 'Selvedge by @iffayush';
export const PDF_PRODUCER = `Selvedge ${version}`;

const FONT_DIR = process.env.WINDIR ? path.join(process.env.WINDIR, 'Fonts') : 'C:\\Windows\\Fonts';
const FONT_SETS = [
  { regular: 'calibri.ttf', bold: 'calibrib.ttf', italic: 'calibrii.ttf' },
  { regular: 'arial.ttf', bold: 'arialbd.ttf', italic: 'ariali.ttf' },
];

/**
 * Layouts from roomiest to most compact. Margins are in points (72 pt = 1 inch).
 * The roomiest already uses narrow 0.5 inch side margins.
 */
export const LAYOUTS = [
  { base: 10.5, side: 36, top: 32, gap: 1.0 },
  { base: 10, side: 34, top: 30, gap: 0.9 },
  { base: 9.5, side: 32, top: 28, gap: 0.8 },
  { base: 9, side: 30, top: 26, gap: 0.7 },
  { base: 8.5, side: 28, top: 24, gap: 0.6 },
];

function pickFonts() {
  for (const set of FONT_SETS) {
    const files = ['regular', 'bold', 'italic'].map((k) => path.join(FONT_DIR, set[k]));
    if (files.every((f) => fs.existsSync(f))) {
      return { regular: files[0], bold: files[1], italic: files[2], embedded: true };
    }
  }
  return { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', embedded: false };
}

// The built-in Helvetica only covers WinAnsi; map common characters and drop the rest.
function winAnsiSafe(s) {
  return String(s)
    .replace(/[\u2010-\u2012]/g, '-')
    .replace(/\u2192/g, '->')
    .replace(/\u20B9/g, 'Rs. ')
    .replace(/[^\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC\u2122]/g, '');
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Where a contact item or link should point when clicked, or null for plain text. */
export function hrefFor(value) {
  const v = clean(value);
  if (!v || /\s/.test(v)) return null;
  if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(v)) return `mailto:${v}`;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^(www\.)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(v) && /[a-z]/i.test(v.split('.').pop())) return `https://${v}`;
  return null;
}

/** A link as shown on the page: no protocol or "www.", no trailing slash. */
const shownUrl = (url) => clean(url).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');

/** Render once with one layout. Resolves {pdf, pages}. */
function renderPdf(resume, layout, pageSize) {
  return new Promise((resolve, reject) => {
    const fonts = pickFonts();
    const t = fonts.embedded ? clean : (s) => winAnsiSafe(clean(s));
    const { base, side, top, gap } = layout;
    const doc = new PDFDocument({
      size: pageSize,
      margins: { top, bottom: top, left: side, right: side },
      info: {
        Title: `${clean(resume.name) || 'Resume'} - Resume`,
        Author: clean(resume.name),
        Subject: clean(resume.headline),
        Creator: PDF_CREATOR,
        Producer: PDF_PRODUCER,
      },
    });
    doc.registerFont('R', fonts.regular);
    doc.registerFont('B', fonts.bold);
    doc.registerFont('I', fonts.italic);

    let pages = 1;
    doc.on('pageAdded', () => pages++);
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve({ pdf: Buffer.concat(chunks), pages }));
    doc.on('error', reject);

    const lineGap = 1.2 * gap;
    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const ensure = (h) => {
      if (doc.y + h > bottom()) doc.addPage();
    };
    const space = (n) => doc.moveDown(n * gap);
    const textColor = '#111111';
    const muted = '#444444';

    // ----- Header -----
    doc.font('B').fontSize(base + 8).fillColor(textColor).text(t(resume.name) || 'Your Name', left, doc.y, {
      width,
      align: 'center',
    });
    if (clean(resume.headline)) {
      doc.font('R').fontSize(base + 0.5).fillColor(muted).text(t(resume.headline), { width, align: 'center' });
    }
    const contact = (resume.contact || []).map(t).filter(Boolean);
    if (contact.length) {
      // centred lines, wrapped between items; each email or web address is clickable
      doc.font('R').fontSize(base - 0.5).fillColor(muted);
      const sep = '  |  ';
      const rows = [[]];
      for (const c of contact) {
        const row = rows[rows.length - 1];
        if (row.length && doc.widthOfString([...row, c].join(sep)) > width) rows.push([c]);
        else row.push(c);
      }
      for (const row of rows) {
        const lineW = doc.widthOfString(row.join(sep));
        if (lineW > width) {
          // a single item wider than the page: let it wrap as plain text
          doc.text(row.join(sep), left, doc.y, { width, align: 'center' });
          continue;
        }
        let x = left + (width - lineW) / 2;
        const y = doc.y;
        row.forEach((c, i) => {
          doc.text(c, x, y, { lineBreak: false, link: hrefFor(c) || undefined });
          x += doc.widthOfString(c);
          if (i < row.length - 1) {
            doc.text(sep, x, y, { lineBreak: false });
            x += doc.widthOfString(sep);
          }
        });
        doc.x = left;
        doc.y = y + doc.currentLineHeight(true);
      }
    }
    space(0.4);

    // ----- Helpers -----
    const heading = (label) => {
      ensure(base * 4);
      space(0.3);
      doc.font('B').fontSize(base + 1).fillColor(textColor).text(label.toUpperCase(), left, doc.y, {
        width,
        characterSpacing: 0.5,
      });
      const y = doc.y + 1;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.6).strokeColor('#888888').stroke();
      doc.y = y + 3 * gap;
    };

    const paragraph = (text) => {
      doc.font('R').fontSize(base).fillColor(textColor).text(t(text), left, doc.y, { width, lineGap });
    };

    const bullet = (text) => {
      const indent = base + 1;
      const body = t(text);
      if (!body) return;
      doc.font('R').fontSize(base);
      const h = doc.heightOfString(body, { width: width - indent, lineGap });
      ensure(Math.min(h, base * 3));
      const y = doc.y;
      doc.fillColor(textColor).text('•', left + 1, y, { width: indent, lineBreak: false });
      doc.text(body, left + indent, y, { width: width - indent, lineGap });
      space(0.08);
    };

    // A bold title on the left with dates (or a link) right-aligned on the same line.
    const entryHeader = (titleText, dates, subText, link) => {
      ensure(base * 4);
      const y = doc.y;
      const href = link ? hrefFor(link) : null;
      const rightStr = t(dates) || (link ? t(shownUrl(link)) : '');
      doc.font('R').fontSize(base);
      const rightW = rightStr ? Math.min(doc.widthOfString(rightStr) + 8, width * 0.55) : 0;
      doc.font('B').fontSize(base + 0.5).fillColor(textColor).text(t(titleText), left, y, { width: width - rightW });
      const afterTitle = doc.y;
      if (rightStr) {
        doc.font('R').fontSize(base).fillColor(href && !dates ? '#1f4e9c' : muted).text(rightStr, left + width - rightW, y + 0.5, {
          width: rightW,
          align: 'right',
          lineBreak: false,
          ellipsis: true,
          link: href && !dates ? href : undefined,
        });
      }
      doc.y = afterTitle;
      if (clean(subText)) {
        doc.font('I').fontSize(base).fillColor(muted).text(t(subText), left, doc.y, { width });
      }
      space(0.1);
    };

    const range = (a, b) => [clean(a), clean(b)].filter(Boolean).join(' – ');

    // ----- Sections -----
    if (clean(resume.summary)) {
      heading('Summary');
      paragraph(resume.summary);
    }

    const skills = (resume.skills || []).filter((g) => g.items?.length);
    if (skills.length) {
      heading('Skills');
      for (const g of skills) {
        const items = g.items.map(t).filter(Boolean).join(', ');
        if (clean(g.category)) {
          doc.font('B').fontSize(base).fillColor(textColor).text(`${t(g.category)}: `, left, doc.y, {
            width,
            continued: true,
            lineGap,
          });
          doc.font('R').text(items, { lineGap });
        } else {
          paragraph(items);
        }
        space(0.05);
      }
    }

    if (resume.experience?.length) {
      heading('Experience');
      resume.experience.forEach((e, i) => {
        if (i > 0) space(0.3);
        const title = [clean(e.title), clean(e.company)].filter(Boolean).join(', ');
        entryHeader(title, range(e.start, e.end), e.location);
        for (const b of e.bullets || []) bullet(b);
      });
    }

    if (resume.projects?.length) {
      heading('Projects');
      resume.projects.forEach((p, i) => {
        if (i > 0) space(0.25);
        entryHeader(p.name, '', p.context, p.link);
        for (const b of p.bullets || []) bullet(b);
      });
    }

    if (resume.education?.length) {
      heading('Education');
      resume.education.forEach((e, i) => {
        if (i > 0) space(0.25);
        const title = [clean(e.degree), clean(e.institution)].filter(Boolean).join(', ');
        entryHeader(title, range(e.start, e.end), e.location);
        for (const d of e.details || []) bullet(d);
      });
    }

    const certs = (resume.certifications || []).filter((c) => clean(c));
    if (certs.length) {
      heading('Certifications');
      for (const c of certs) bullet(c);
    }

    for (const x of resume.extras || []) {
      const items = (x.items || []).filter((i) => clean(i));
      if (!items.length) continue;
      heading(clean(x.heading) || 'Additional');
      for (const i of items) bullet(i);
    }

    doc.end();
  });
}

/**
 * Lay out the resume. With fitOnePage (the default) it tries each layout in LAYOUTS until the
 * resume fits on one page; if even the most compact one needs more, that one is used.
 * @returns {Promise<{pdf: Buffer, pages: number, fontSize: number, fits: boolean}>}
 */
export async function layoutResumePdf(resume, { pageSize = 'A4', fitOnePage = true } = {}) {
  const layouts = fitOnePage ? LAYOUTS : [LAYOUTS[0]];
  let last;
  for (const layout of layouts) {
    last = { ...(await renderPdf(resume, layout, pageSize)), fontSize: layout.base };
    if (last.pages === 1) return { ...last, fits: true };
  }
  return { ...last, fits: false };
}

export async function buildResumePdf(resume, opts) {
  return (await layoutResumePdf(resume, opts)).pdf;
}

/** File-name friendly version of the candidate name and role, e.g. Jane_Doe_Data_Analyst_Resume.pdf */
export function resumeFileName(name, role) {
  const part = (s) =>
    String(s || '')
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s-]+/g, '_')
      .slice(0, 50);
  return [part(name) || 'Resume', part(role)].filter(Boolean).join('_') + '_Resume.pdf';
}
