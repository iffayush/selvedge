// Renders the example tailored résumé (docs/example/*_Resume.pdf) to docs/screenshots/pdf.png,
// on a soft backdrop, for the README. Uses pdf.js with @napi-rs/canvas (installed with pdf.js).
//   node scripts/pdf-preview.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = path.join(ROOT, 'docs', 'example');
const pdfFile = fs.readdirSync(example).find((f) => f.endsWith('_Resume.pdf'));
if (!pdfFile) throw new Error('No example PDF found in docs/example. Run scripts/make-demo-data.mjs first.');

const { createCanvas } = await import('@napi-rs/canvas');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(example, pdfFile))), verbosity: 0 }).promise;
const page = await doc.getPage(1);
const vp = page.getViewport({ scale: 2 });
const pageCanvas = createCanvas(Math.round(vp.width), Math.round(vp.height));
await page.render({ canvasContext: pageCanvas.getContext('2d'), viewport: vp, canvas: pageCanvas }).promise;

const padX = 140;
const padY = 110;
const out = createCanvas(pageCanvas.width + padX * 2, pageCanvas.height + padY * 2);
const ctx = out.getContext('2d');
ctx.fillStyle = '#E9EEE6';
ctx.fillRect(0, 0, out.width, out.height);
ctx.shadowColor = 'rgba(41, 58, 48, 0.22)';
ctx.shadowBlur = 60;
ctx.shadowOffsetY = 24;
ctx.fillStyle = '#FFFFFF';
ctx.fillRect(padX, padY, pageCanvas.width, pageCanvas.height);
ctx.shadowColor = 'transparent';
ctx.drawImage(pageCanvas, padX, padY);

const outDir = path.join(ROOT, 'docs', 'screenshots');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'pdf.png'), await out.encode('png'));
console.log(`pdf.png  ${out.width}×${out.height}`);
