/**
 * Renders the mark's raster copies from `lib/brand-mark.ts`: `app/favicon.ico`, `app/apple-icon.png`
 * and the email header's `public/mail/mark.png` and `mark-dark.png`. Drives the machine's Chrome.
 *
 * Run: pnpm brand:assets
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PALETTE } from "@/lib/brand-palette";
import { MARK_CUT_WIDTH, MARK_CUT_WIDTH_SMALL, markSvg } from "@/lib/brand-mark";
import { launchBrowser, REPO } from "./lib/shots.mjs";

const browser = await launchBrowser();
const page = await browser.newPage();

/** One PNG of `svg` at `width` by `height`, rasterized by Chrome onto a canvas of exactly that size. */
async function png(svg: string, width: number, height: number): Promise<Buffer> {
  const url = await page.evaluate(
    async ([markup, w, h]) => {
      const image = new Image(w, h);
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")!.drawImage(image, 0, 0, w, h);
      return canvas.toDataURL("image/png");
    },
    [svg, width, height] as const,
  );
  return Buffer.from(url.split(",")[1]!, "base64");
}

/** An ICO holding PNG images, which every browser since IE Vista reads. */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

const { light, dark } = PALETTE;

const favicon = await Promise.all(
  [16, 32, 48].map(async (size) => ({ size, data: await png(markSvg({ fill: light.primary, cutWidth: size <= 16 ? MARK_CUT_WIDTH_SMALL : MARK_CUT_WIDTH }), size, size) })),
);
await writeFile(join(REPO, "app/favicon.ico"), ico(favicon));

// Opaque: iOS composites transparency onto black.
const apple = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180"><rect width="180" height="180" fill="${light.primary}"/>${markSvg({ fill: light.background, attributes: 'x="30" y="30" width="120" height="120"' })}</svg>`;
// A page screenshot rather than a canvas, so the PNG carries no alpha channel at all.
const applePage = await browser.newPage({ viewport: { width: 180, height: 180 } });
await applePage.setContent(`<!doctype html><style>html,body{margin:0}svg{display:block;width:180px;height:180px}</style>${apple}`);
await writeFile(join(REPO, "app/apple-icon.png"), await applePage.screenshot());

// 26 by 20 at 2x: the body's own bounds, so the header's width and height attributes match the art.
await mkdir(join(REPO, "public/mail"), { recursive: true });
for (const [name, fill] of [["mark", light.primary], ["mark-dark", dark.primary]] as const) {
  const svg = markSvg({ fill }).replace('viewBox="0 0 32 32"', 'viewBox="3 6.5 26 20"');
  await writeFile(join(REPO, `public/mail/${name}.png`), await png(svg, 52, 40));
}

await browser.close();
console.log("wrote app/favicon.ico, app/apple-icon.png, public/mail/mark.png, public/mail/mark-dark.png");
