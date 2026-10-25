// Compose the existing approved mark with a neutral STAFF label; do not redraw the logo.
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
const logo = readFileSync(new URL('../public/icon-maskable-512.png', import.meta.url)).toString('base64');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="white"/><image x="40" y="-8" width="432" height="432" xlink:href="data:image/png;base64,${logo}"/><text x="256" y="370" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="36" letter-spacing="4" fill="#102a38">STAFF</text></svg>`;
for (const [name,size] of [['staff-icon-192.png',192],['staff-icon-512.png',512],['staff-apple-icon.png',180]]) {
  writeFileSync(new URL(`../public/${name}`, import.meta.url), await sharp(Buffer.from(svg)).resize(size,size).png().toBuffer());
}
