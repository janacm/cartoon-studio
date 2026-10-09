// Check whether svgRig can rig third-party character SVGs, without the
// vision fallback. For each input: strip a full-canvas background, normalise
// the viewBox, run the mouth heuristic (rigSvg) and the eye rig (tagEyes),
// then write <out-dir>/<name>.rigged.svg and a PNG preview.
//
//   [MOUTH_BBOX=x,y,w,h] node --no-warnings --import ./agent/hooks.mjs agent/tools/rig-check.ts <out-dir> <a.svg> [b.svg ...]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { rigSvg, replaceMouthRegion, tagEyes, stripBackgroundFill, stripMagenta, normalizeViewBox } from '../../src/main/svgRig';

const [outDir, ...inputs] = process.argv.slice(2);
if (!outDir || inputs.length === 0) {
  console.error('usage: rig-check.ts <out-dir> <a.svg> [b.svg ...]');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

for (const input of inputs) {
  const name = path.basename(input, '.svg');
  const raw = fs.readFileSync(input, 'utf8');
  const svg = normalizeViewBox(stripBackgroundFill(stripMagenta(raw)));
  // MOUTH_BBOX="x,y,w,h" (fractions of the viewBox) stands in for the vision
  // fallback: drop the rig on top at that box, removing paths inside it.
  const box = process.env.MOUTH_BBOX?.split(',').map(Number);
  const mouth = box
    ? replaceMouthRegion(svg, { x: box[0], y: box[1], width: box[2], height: box[3] })
    : rigSvg(svg);
  const eyes = tagEyes(mouth.svg, 'chk');
  const out = path.join(outDir, `${name}.rigged.svg`);
  fs.writeFileSync(out, mouth.svg);
  // Preview with the open-mouth shape (D) and the lids shown half-closed so
  // the rig placement is visible in a still.
  const preview = eyes.svg
    .replace('.mouth-group.mouth-X{opacity:1}', '.mouth-group.mouth-D{opacity:1}')
    .replace(/visibility="hidden"/g, '');
  try {
    execFileSync('rsvg-convert', ['-w', '600', '-h', '600', '-a', '-b', 'white', '-o', path.join(outDir, `${name}.preview.png`)], {
      input: preview,
    });
  } catch {
    /* preview is best-effort */
  }
  console.log(`${name}: mouth=${mouth.rigged ? 'rigged' : 'MISS'} eyes=${eyes.eyes} pupils=${eyes.pupils}`);
}
