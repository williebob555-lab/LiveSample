// Rasterize the brand SVGs and build the app icons.
//
//   npm run brand
//
// Runs under Electron because Chromium is the one rasterizer this project
// already has — no ImageMagick, Pillow or sharp — and it renders the wordmark
// in the same bundled Inter the app uses. Same approach as LivePatch's.
//
// Outputs (all generated — edit the SVGs, never these):
//   brand/png/*.png    raster exports
//   build/icon.ico     Windows, every size from its optical variant
//   build/icon.png     Linux (AppImage / .desktop), 512 px

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BRAND = path.join(ROOT, 'brand');
const PNG_OUT = path.join(BRAND, 'png');
const BUILD = path.join(ROOT, 'build');
const FONTS = path.join(ROOT, 'node_modules', '@fontsource', 'inter', 'files');

// Pixel size must match each SVG's aspect ratio, or the render stretches.
const EXPORTS = [
  { src: 'mark-square.svg', out: 'mark-square-1024.png', w: 1024, h: 1024 },
  { src: 'mark-circle.svg', out: 'mark-circle-1024.png', w: 1024, h: 1024 },
  { src: 'wordmark.svg', out: 'wordmark-1320.png', w: 1320, h: 400 },
  { src: 'wordmark-light.svg', out: 'wordmark-light-1320.png', w: 1320, h: 400 },
  { src: 'lockup-horizontal.svg', out: 'lockup-horizontal-1800.png', w: 1800, h: 440 },
  { src: 'lockup-horizontal-light.svg', out: 'lockup-horizontal-light-1800.png', w: 1800, h: 440 },
  { src: 'banner-readme.svg', out: 'banner-readme-1280x280.png', w: 1280, h: 280 },
  { src: 'banner-social.svg', out: 'banner-social-1280x640.png', w: 1280, h: 640 },
];

// One drawing cannot serve 16 px and 256 px: the S's counters close up. Each
// size band gets its own drawing (see brand/README.md).
const ICON_SIZES = [
  { size: 256, from: 'mark-square.svg' },
  { size: 128, from: 'mark-square.svg' },
  { size: 64, from: 'mark-square.svg' },
  { size: 48, from: 'mark-square-small.svg' },
  { size: 32, from: 'mark-square-small.svg' },
  { size: 24, from: 'mark-square-tiny.svg' },
  { size: 16, from: 'mark-square-tiny.svg' },
];

const fontFaces = [400, 500, 600, 700]
  .map((w) => {
    const file = path.join(FONTS, `inter-latin-${w}-normal.woff2`);
    return `@font-face{font-family:Inter;font-weight:${w};src:url(${JSON.stringify('file://' + file)})}`;
  })
  .join('');

// An unguessable per-run directory, so nothing else can plant the page we load.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'livesample-brand-'));
const TMP_HTML = path.join(TMP_DIR, 'render.html');

let win = null;

async function render(svgFile, w, h) {
  if (!win) {
    win = new BrowserWindow({
      width: w,
      height: h,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: true },
    });
  }
  win.setContentSize(w, h);
  const svg = fs
    .readFileSync(path.join(BRAND, svgFile), 'utf8')
    .replace('<svg ', `<svg style="width:${w}px;height:${h}px;display:block" `);
  fs.writeFileSync(
    TMP_HTML,
    `<!doctype html><html><head><style>${fontFaces}html,body{margin:0;background:transparent}</style></head><body>${svg}</body></html>`,
  );
  await win.loadFile(TMP_HTML);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await new Promise((r) => setTimeout(r, 150));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
  // HiDPI displays capture at device scale; normalise to the requested size.
  return img.getSize().width === w ? img : img.resize({ width: w, height: h, quality: 'best' });
}

/** .ico with PNG-compressed entries, which Explorer, rcedit and NSIS all read. */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(PNG_OUT, { recursive: true });
    fs.mkdirSync(BUILD, { recursive: true });

    for (const e of EXPORTS) {
      fs.writeFileSync(path.join(PNG_OUT, e.out), (await render(e.src, e.w, e.h)).toPNG());
      console.log(`brand/png/${e.out}`);
    }

    const entries = [];
    for (const { size, from } of ICON_SIZES) entries.push({ size, png: (await render(from, size, size)).toPNG() });
    fs.writeFileSync(path.join(BUILD, 'icon.ico'), buildIco(entries));
    console.log('build/icon.ico');

    fs.writeFileSync(path.join(BUILD, 'icon.png'), (await render('mark-square.svg', 512, 512)).toPNG());
    console.log('build/icon.png');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
