#!/usr/bin/env node
// Renders the Quarry mark (brand/quarry-mark.svg) into the raster icons the
// web app ships: PNG app icons, an apple-touch-icon, and a multi-size
// favicon.ico. Uses the Chromium that @playwright/test already installs, so
// no image-processing dependency is needed.
//
//   npm run icons
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'brand', 'quarry-mark.svg');
const outDir = path.join(root, 'web', 'public');

const PNG_TARGETS = [
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
];
const ICO_SIZES = [16, 32, 48];

async function render(page, svg, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">` +
      `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" ` +
      `width="${size}" height="${size}" style="display:block"></body></html>`,
  );
  await page.waitForFunction(() => document.images[0]?.complete);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

// ICO container with PNG-encoded entries (supported by every modern browser
// and by Windows Vista+).
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); // palette colours
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

const svg = await readFile(source, 'utf8');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { file, size } of PNG_TARGETS) {
    await writeFile(path.join(outDir, file), await render(page, svg, size));
    console.log(`  wrote web/public/${file} (${size}x${size})`);
  }
  const icoEntries = [];
  for (const size of ICO_SIZES) icoEntries.push({ size, png: await render(page, svg, size) });
  await writeFile(path.join(outDir, 'favicon.ico'), buildIco(icoEntries));
  console.log(`  wrote web/public/favicon.ico (${ICO_SIZES.join(', ')})`);
  await copyFile(source, path.join(outDir, 'favicon.svg'));
  console.log('  wrote web/public/favicon.svg');
} finally {
  await browser.close();
}
