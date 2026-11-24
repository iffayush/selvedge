// Turn an uploaded PDF or DOCX into plain text plus layout facts that matter for ATS.
import path from 'node:path';
import { createRequire } from 'node:module';
import mammoth from 'mammoth';

const require = createRequire(import.meta.url);

export class ParseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let pdfjsPromise;
function loadPdfjs() {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

function standardFontsUrl() {
  const pkg = path.dirname(require.resolve('pdfjs-dist/package.json'));
  // pdf.js insists on a trailing "/" and reads the path with fs, so forward slashes work on Windows too
  return path.join(pkg, 'standard_fonts').replace(/\\/g, '/') + '/';
}

// Private-use glyphs (icon fonts), emoji, and the replacement character.
const ODD_CHAR_RE = /[-�]|\p{Extended_Pictographic}/gu;

export function countOddChars(text) {
  return (String(text).match(ODD_CHAR_RE) || []).length;
}

export function tidyText(text) {
  return String(text)
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function detectKind(buffer, filename = '') {
  const ext = path.extname(filename).toLowerCase();
  const head = buffer.subarray(0, 5).toString('latin1');
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith('PK')) {
    if (ext === '.docx' || ext === '') return 'docx';
    return 'docx';
  }
  if (ext === '.doc') {
    throw new ParseError('unsupported', 'Old .doc files are not supported. Save it as .docx or PDF and upload again.');
  }
  throw new ParseError('unsupported', 'Please upload a PDF or a Word (.docx) file.');
}

// ---------- PDF ----------

/** Group text items into lines by their y-position; returns lines of segments. */
function buildLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.transform) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const size = Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || 10;
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, size * 0.35));
    if (!row) {
      row = { y, size, items: [] };
      rows.push(row);
    }
    row.items.push({ x, w: it.width || 0, str: it.str, size });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((row) => {
    row.items.sort((a, b) => a.x - b.x);
    // merge items into segments; a large gap starts a new segment
    const segments = [];
    let cur = null;
    for (const it of row.items) {
      if (!cur) {
        cur = { x: it.x, end: it.x + it.w, text: it.str };
        segments.push(cur);
        continue;
      }
      const gap = it.x - cur.end;
      if (gap > it.size * 3) {
        cur = { x: it.x, end: it.x + it.w, text: it.str };
        segments.push(cur);
      } else {
        const needsSpace = gap > it.size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str);
        cur.text += (needsSpace ? ' ' : '') + it.str;
        cur.end = Math.max(cur.end, it.x + it.w);
      }
    }
    return { y: row.y, segments };
  });
}

/**
 * Multi-column heuristic: many lines whose second segment holds real text (not a short date)
 * and starts at roughly the same x position.
 */
function looksMultiColumn(lines, pageWidth) {
  const starts = [];
  for (const l of lines) {
    if (l.segments.length < 2) continue;
    for (const seg of l.segments.slice(1)) {
      const text = seg.text.trim();
      if (text.length >= 25 && seg.x > pageWidth * 0.25) starts.push(seg.x);
    }
  }
  if (starts.length < 6) return false;
  starts.sort((a, b) => a - b);
  // biggest cluster within 10 units
  let best = 0;
  for (let i = 0, j = 0; i < starts.length; i++) {
    while (starts[i] - starts[j] > 10) j++;
    best = Math.max(best, i - j + 1);
  }
  return best >= 6;
}

/** A URL the way it is usually shown: no protocol, no "www.", no trailing slash. */
export function displayUrl(url) {
  return String(url || '')
    .trim()
    .replace(/^mailto:/i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');
}

/**
 * Clickable words like "GitHub" or "Live demo" hide their address. Append each hidden link's
 * address to the line it sits on, so the AI can keep it. Links already visible are left alone.
 */
export function addLinkTargets(lines, lineTexts, annotations = []) {
  for (const a of annotations) {
    const url = a?.subtype === 'Link' ? a.url || a.unsafeUrl : null;
    if (!url || !Array.isArray(a.rect) || /^#|^javascript:/i.test(url)) continue;
    const [, y1, , y2] = a.rect;
    let best = -1;
    let bestDist = Infinity;
    lines.forEach((l, i) => {
      const dist = l.y < Math.min(y1, y2) ? Math.min(y1, y2) - l.y : l.y > Math.max(y1, y2) ? l.y - Math.max(y1, y2) : 0;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    if (best < 0 || bestDist > 6) continue;
    const shown = displayUrl(url).toLowerCase();
    if (!shown || lineTexts[best].toLowerCase().includes(shown)) continue;
    lineTexts[best] += ` (${displayUrl(url)})`;
  }
}

export async function parsePdf(buffer) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: standardFontsUrl(),
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => {});
    if (err?.name === 'PasswordException') {
      throw new ParseError('password', 'This PDF is password-protected. Remove the password and upload it again.');
    }
    throw new ParseError('corrupt', "This PDF couldn't be read. Try exporting it again from Word or Google Docs.");
  }

  const pageTexts = [];
  let multiColumn = false;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const lines = buildLines(content.items);
      if (looksMultiColumn(lines, viewport.width)) multiColumn = true;
      const lineTexts = lines.map((l) => l.segments.map((s) => s.text.trim()).join('   '));
      let annotations = [];
      try {
        annotations = await page.getAnnotations();
      } catch {}
      addLinkTargets(lines, lineTexts, annotations);
      pageTexts.push(lineTexts.join('\n'));
      page.cleanup();
    }
  } finally {
    await task.destroy().catch(() => {});
  }

  const text = tidyText(pageTexts.join('\n\n'));
  if (text.replace(/\s/g, '').length < 50) {
    throw new ParseError(
      'scanned',
      "This PDF has no readable text. It's probably a scanned image, and ATS systems can't read it either. Export your resume from Word or Google Docs as a PDF and upload that.",
    );
  }
  return {
    text,
    meta: {
      kind: 'pdf',
      pages: pageTexts.length,
      multiColumn,
      hasTables: false,
      oddChars: countOddChars(text),
    },
  };
}

// ---------- DOCX ----------

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function htmlToText(html) {
  return tidyText(
    decodeEntities(
      html
        // keep a hyperlink's address when the visible text doesn't already show it
        .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
          const label = inner.replace(/<[^>]+>/g, '');
          const url = decodeEntities(href);
          if (/^#|^javascript:/i.test(url)) return inner;
          const shown = displayUrl(url);
          return decodeEntities(label).toLowerCase().includes(shown.toLowerCase()) ? inner : `${inner} (${shown})`;
        })
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<\/(p|h[1-6]|li|tr|div)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/t[dh]>/gi, '   ')
        .replace(/<[^>]+>/g, ''),
    )
      .split('\n')
      .map((l) => l.trim())
      .join('\n'),
  );
}

export async function parseDocx(buffer) {
  let html;
  try {
    ({ value: html } = await mammoth.convertToHtml({ buffer }));
  } catch {
    throw new ParseError('corrupt', "This Word file couldn't be read. Re-save it as .docx and try again.");
  }
  const text = htmlToText(html);
  if (text.replace(/\s/g, '').length < 50) {
    throw new ParseError(
      'empty',
      'No readable text was found in this Word file. If your resume is built from text boxes or images, ATS systems may not read it either.',
    );
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  return {
    text,
    meta: {
      kind: 'docx',
      pages: Math.max(1, Math.ceil(words / 550)),
      multiColumn: false,
      hasTables: /<table/i.test(html),
      oddChars: countOddChars(text),
    },
  };
}

export async function parseResume(buffer, filename) {
  const kind = detectKind(buffer, filename);
  return kind === 'pdf' ? parsePdf(buffer) : parseDocx(buffer);
}
