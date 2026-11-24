// Copies the Latin variable-font files the UI uses into public/fonts, plus their OFL licences,
// so the app works offline and loads no fonts from a CDN. Run after `npm install`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'fonts');
const fonts = [
  ['dm-sans', ['dm-sans-latin-wght-normal.woff2']],
  ['inter', ['inter-latin-wght-normal.woff2', 'inter-latin-wght-italic.woff2']],
  ['cormorant-garamond', ['cormorant-garamond-latin-wght-normal.woff2', 'cormorant-garamond-latin-wght-italic.woff2']],
];

fs.mkdirSync(path.join(out, 'licenses'), { recursive: true });
for (const [pkg, files] of fonts) {
  const dir = path.join(root, 'node_modules', '@fontsource-variable', pkg);
  for (const f of files) fs.copyFileSync(path.join(dir, 'files', f), path.join(out, f));
  fs.copyFileSync(path.join(dir, 'LICENSE'), path.join(out, 'licenses', `${pkg}-OFL.txt`));
}
console.log(`Copied fonts to ${path.relative(root, out)}`);
