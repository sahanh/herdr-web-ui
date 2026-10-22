/** Mission control's app icon: the brand mark in lilac on a night tile, filling the tile so it
 * reads at Dock size. Overwrites the app icons generate-brand.ts makes; the favicon and badge
 * keep the brand art. Requires ffmpeg. */
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const source = join(root, "docs/brand/icon-source.png");
const tile = "0x17181c";
const [r, g, b] = [0xc7, 0xa6, 0xf4];

function exportIcon(path: string, size: number, markShare: number): void {
  const mark = Math.round(size * markShare);
  const filter = [
    `color=c=${tile}:s=${size}x${size}[bg]`,
    `[0]crop=1040:1040:145:127,scale=${mark}:${mark}:flags=lanczos,format=rgba,` +
      `geq=r=${r}:g=${g}:b=${b}:a='clip((200-r(X,Y))*2.5,0,255)'[mark]`,
    "[bg][mark]overlay=(W-w)/2:(H-h)/2,format=rgb24",
  ].join(";");
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", source,
    "-filter_complex", filter, "-frames:v", "1", join(root, path),
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not export ${path}`);
  console.log(path);
}

exportIcon("public/apple-touch-icon.png", 180, 0.86);
for (const size of [192, 512]) {
  exportIcon(`public/icons/icon-${size}.png`, size, 0.86);
  // Maskable icons are cropped to a circle as small as 80% of the tile.
  exportIcon(`public/icons/icon-maskable-${size}.png`, size, 0.66);
}
