// Auto-rig the mouth on a character SVG. Heuristic: find a small,
// wide-≫-tall, dark-filled path in the lower half of the figure, delete
// it, drop in a <g> with the 9 Preston Blair mouth shapes at its centroid.
//
// Approximate path bboxes are computed by extracting all numeric pairs
// from the `d` attribute. Recraft outputs are absolute paths so this
// trades precision for simplicity (worst case the centroid is off by a
// few units, well within the mouth-shape size).

// Rig template phonemes are drawn relative to (0,0) and span ~180 units
// at their widest (the D shape: rx=90 ⇒ 180-wide ellipse). The template
// gets translated to the mouth center and scaled so its phonemes match
// the actual mouth size — see `replaceMouthRegion` for how scale is
// computed. RIG_TEMPLATE_REFERENCE_WIDTH is the design width that scale
// 1.0 corresponds to.
export const RIG_TEMPLATE_REFERENCE_WIDTH = 180;

const MOUTH_RIG_TEMPLATE = `<style>.mouth-group{opacity:0}.mouth-group.mouth-X{opacity:1}</style>
<g class="mouth-rig" transform="translate(__CX__ __CY__) scale(__SCALE__)">
<g class="mouth-wrap">
<g class="mouth-group mouth-X"><path d="M -75 0 L 75 0" fill="none" stroke="#0c0c0c" stroke-width="22" stroke-linecap="round"/></g>
<g class="mouth-group mouth-A"><path d="M -80 0 Q 0 18 80 0" fill="none" stroke="#0c0c0c" stroke-width="22" stroke-linecap="round"/></g>
<g class="mouth-group mouth-B"><ellipse cx="0" cy="0" rx="75" ry="12" fill="#3B1414"/></g>
<g class="mouth-group mouth-C"><ellipse cx="0" cy="8" rx="70" ry="38" fill="#3B1414" stroke="#0c0c0c" stroke-width="7"/></g>
<g class="mouth-group mouth-D"><ellipse cx="0" cy="0" rx="90" ry="60" fill="#3B1414" stroke="#0c0c0c" stroke-width="7"/></g>
<g class="mouth-group mouth-E"><ellipse cx="0" cy="0" rx="55" ry="40" fill="#3B1414" stroke="#0c0c0c" stroke-width="7"/></g>
<g class="mouth-group mouth-F"><ellipse cx="0" cy="0" rx="32" ry="36" fill="#3B1414" stroke="#0c0c0c" stroke-width="7"/></g>
<g class="mouth-group mouth-G"><path d="M -80 -8 L 80 -8 L 70 22 L -70 22 Z" fill="#3B1414" stroke="#0c0c0c" stroke-width="7"/></g>
<g class="mouth-group mouth-H"><ellipse cx="0" cy="0" rx="72" ry="42" fill="#3B1414" stroke="#0c0c0c" stroke-width="7"/><ellipse cx="0" cy="0" rx="32" ry="22" fill="#D47272"/></g>
</g>
</g>`;

function parseViewBox(svg: string): { w: number; h: number } | null {
  const m = svg.match(/viewBox="([^"]+)"/);
  if (!m) return null;
  const parts = m[1].split(/[ ,]+/).map(Number);
  if (parts.length < 4) return null;
  return { w: parts[2], h: parts[3] };
}

function pathBbox(d: string): { x: number; y: number; w: number; h: number } | null {
  const nums = d.match(/-?\d*\.?\d+/g);
  if (!nums || nums.length < 4) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = parseFloat(nums[i]);
    const y = parseFloat(nums[i + 1]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function fillIsDark(fill: string): boolean {
  const m = fill.match(/rgb\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)\)/i);
  if (!m) return /^#?(0|1|2)/i.test(fill);
  const [, r, g, b] = m;
  return parseInt(r) + parseInt(g) + parseInt(b) < 150;
}

type PathHit = {
  full: string;
  d: string;
  bbox: { x: number; y: number; w: number; h: number };
};

function findMouthPath(svg: string): PathHit | null {
  const vb = parseViewBox(svg) ?? { w: 2048, h: 2048 };
  // Walk every <path ...> tag; pick one matching the mouth heuristics.
  const pathRe = /<path[^>]*\bd="([^"]+)"[^>]*\bfill="([^"]+)"[^>]*\/?>(?:\s*<\/path>)?/g;
  let best: { hit: PathHit; score: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(svg)) !== null) {
    const [full, d, fill] = m;
    if (!fillIsDark(fill)) continue;
    const bb = pathBbox(d);
    if (!bb) continue;
    const aspect = bb.w / Math.max(1, bb.h);
    if (aspect < 1.5) continue;
    if (bb.w > vb.w * 0.18) continue;
    if (bb.w < vb.w * 0.02) continue;
    const cy = bb.y + bb.h / 2;
    const cx = bb.x + bb.w / 2;
    if (cy < vb.h * 0.4) continue;
    // Score: prefer wider-than-tall, centered, in the lower-mid face.
    const horizCenter = Math.abs(cx - vb.w / 2) / vb.w;
    const targetY = vb.h * 0.6;
    const verticalDist = Math.abs(cy - targetY) / vb.h;
    const score = aspect - horizCenter * 4 - verticalDist * 4;
    if (!best || score > best.score) {
      best = { hit: { full, d, bbox: bb }, score };
    }
  }
  return best?.hit ?? null;
}

export function rigSvg(svg: string): { svg: string; rigged: boolean } {
  if (svg.includes('class="mouth-group')) {
    return { svg, rigged: true };
  }

  // First try eye-anchored structural detection. This works on any
  // character with two visible eyes by finding paired roughly-circular
  // paths and looking for a mouth path BELOW those eyes — without any
  // assumption about where on the canvas the face lives. Tall characters
  // (small head, big body) work as well as canvas-filling close-ups.
  const eyeAnchored = findMouthByEyes(svg);
  if (eyeAnchored) {
    const cx = eyeAnchored.bbox.x + eyeAnchored.bbox.w / 2;
    const cy = eyeAnchored.bbox.y + eyeAnchored.bbox.h / 2;
    const scale = clamp(eyeAnchored.bbox.w / RIG_TEMPLATE_REFERENCE_WIDTH, 0.5, 2.0);
    const rig = renderRig(cx, cy, scale);
    return { svg: svg.replace(eyeAnchored.full, rig), rigged: true };
  }

  // Fallback to the original position-based heuristic — useful for
  // close-up portraits where the face fills the canvas but the eyes
  // aren't a clean matched pair (3/4 view, sunglasses, etc.).
  const hit = findMouthPath(svg);
  if (!hit) return { svg, rigged: false };
  const cx = hit.bbox.x + hit.bbox.w / 2;
  const cy = hit.bbox.y + hit.bbox.h / 2;
  const scale = clamp(hit.bbox.w / RIG_TEMPLATE_REFERENCE_WIDTH, 0.5, 2.0);
  const rig = renderRig(cx, cy, scale);
  return { svg: svg.replace(hit.full, rig), rigged: true };
}

type ParsedPath = {
  full: string;
  d: string;
  fill: string;
  bbox: { x: number; y: number; w: number; h: number };
  cx: number;
  cy: number;
  nw: number; // normalized width
  nh: number; // normalized height
  aspect: number;
  offset: number; // index of the tag in the SVG source (paint order)
};

function parsePaths(svg: string, vb: { w: number; h: number }): ParsedPath[] {
  const all: ParsedPath[] = [];
  const pathRe = /<path\b[^>]*\bd="([^"]+)"[^>]*\/?>(?:\s*<\/path>)?/g;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(svg)) !== null) {
    const full = m[0];
    const d = m[1];
    const bb = pathBbox(d);
    if (!bb) continue;
    const fill = full.match(/\bfill="([^"]+)"/)?.[1] ?? '';
    all.push({
      full,
      d,
      fill,
      bbox: bb,
      cx: (bb.x + bb.w / 2) / vb.w,
      cy: (bb.y + bb.h / 2) / vb.h,
      nw: bb.w / vb.w,
      nh: bb.h / vb.h,
      aspect: bb.h > 0 ? bb.w / bb.h : 999,
      offset: m.index,
    });
  }
  return all;
}

// Best pair of eye-like paths. `accept` can veto a pair (tagEyes uses it to
// insist the eyes sit above the rigged mouth).
function findEyePair(
  all: ParsedPath[],
  accept?: (a: ParsedPath, b: ParsedPath) => boolean,
): [ParsedPath, ParsedPath] | null {
  // Eye candidates: roughly circular, sensible size, in the upper 70%
  // of the canvas (eyes are above the chin no matter how tall).
  const eyeCandidates = all.filter(
    (p) =>
      p.aspect >= 0.6 &&
      p.aspect <= 1.8 &&
      p.nw >= 0.025 &&
      p.nw <= 0.20 &&
      p.cy < 0.70,
  );

  // Score every pair: similar size, same y line, horizontally separated.
  let bestPair: [ParsedPath, ParsedPath] | null = null;
  let bestPairScore = -Infinity;
  for (let i = 0; i < eyeCandidates.length; i++) {
    for (let j = i + 1; j < eyeCandidates.length; j++) {
      const a = eyeCandidates[i];
      const b = eyeCandidates[j];
      const sizeRatio = Math.min(a.nw, b.nw) / Math.max(a.nw, b.nw);
      const yDiff = Math.abs(a.cy - b.cy);
      const xDist = Math.abs(a.cx - b.cx);
      if (sizeRatio < 0.7) continue;
      if (yDiff > 0.05) continue;
      if (xDist < 0.04) continue;
      if (xDist > 0.40) continue;
      if (accept && !accept(a, b)) continue;
      // Bigger eyes are more reliable signals; closer-y is better; less
      // important: minor x-distance preference (typical eye separation
      // is ~1× eye width).
      const score = sizeRatio + Math.min(a.nw, b.nw) * 5 - yDiff * 20;
      if (score > bestPairScore) {
        bestPairScore = score;
        bestPair = [a, b];
      }
    }
  }
  return bestPair;
}

// Eye-anchored mouth detection. Walks every <path>, scores pairs as
// candidate eyes (similar size, similar y, separated horizontally by a
// reasonable amount), then finds the best mouth candidate below the eye
// midpoint. Pure geometry — the SVG itself encodes everything we need.
function findMouthByEyes(svg: string): PathHit | null {
  const vb = parseViewBox(svg) ?? { w: 2048, h: 2048 };
  const all = parsePaths(svg, vb);
  const bestPair = findEyePair(all);
  if (!bestPair) return null;

  const [eyeA, eyeB] = bestPair;
  const eyeMidX = (eyeA.cx + eyeB.cx) / 2;
  const eyeMidY = (eyeA.cy + eyeB.cy) / 2;
  const eyeSpan = Math.abs(eyeA.cx - eyeB.cx);

  // Mouth candidates: BELOW eye midpoint, dark fill, wider than tall,
  // horizontally near the eye axis, and within ~3 eye-spans below the
  // eye line (any further is the body, not the face).
  const mouthCandidates = all.filter((p) => {
    if (!fillIsDark(p.fill)) return false;
    if (p.aspect < 1.5) return false;
    if (p.cy <= eyeMidY + 0.005) return false;
    if (p.cy > eyeMidY + eyeSpan * 3) return false;
    if (Math.abs(p.cx - eyeMidX) > eyeSpan * 2) return false;
    if (p.nw > 0.30) return false;
    return true;
  });

  if (mouthCandidates.length === 0) return null;

  // Score: prefer the mouth at the typical position (~0.7-1.2 eye-spans
  // below eyes), prefer wider-than-tall, prefer center-aligned.
  const targetY = eyeMidY + eyeSpan * 0.95;
  let best: { p: ParsedPath; score: number } | null = null;
  for (const p of mouthCandidates) {
    const yDist = Math.abs(p.cy - targetY);
    const xDist = Math.abs(p.cx - eyeMidX);
    const score = p.aspect - yDist * 10 - xDist * 8;
    if (!best || score > best.score) best = { p, score };
  }
  if (!best) return null;
  return { full: best.p.full, d: best.p.d, bbox: best.p.bbox };
}

// ---------------------------------------------------------------------------
// Eye rig for blinking and gaze (used by the motion layer, see motion.ts).
//
// Character art is usually a black silhouette with flat colour shapes on
// top, so squashing an eye white would expose black. Instead each eye gets
// a pair of lids (face-coloured shapes with a lash line) clipped to the eye
// white's own path; the runtime slides them in to blink. Pupils get a class
// and their allowed travel so the runtime can shift them to look around.
//
//   <g class="cs-lids" clip-path="url(#<prefix>-eye0)">
//     <g class="cs-lid-up"   data-cs-open="-dy">...</g>   open = slid out
//     <g class="cs-lid-down" data-cs-open="+dy">...</g>
//   </g>
//   <path class="cs-pupil" data-cs-gaze="left right up down" .../>
//
// Only paths with no transform or an identity transform take part, so the
// coordinates from pathBbox are the ones the browser draws.

export type EyeRigResult = { svg: string; eyes: number; pupils: number };

function fillLuma(fill: string): number | null {
  const f = fill.trim().toLowerCase();
  const rgb = f.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) return 0.299 * +rgb[1] + 0.587 * +rgb[2] + 0.114 * +rgb[3];
  const hex = f.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
    const n = parseInt(h, 16);
    return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  }
  if (f === 'white') return 255;
  if (f === 'black') return 0;
  return null;
}

function hasIdentityTransform(tag: string): boolean {
  const t = tag.match(/\btransform="([^"]*)"/)?.[1];
  return t === undefined || /^\s*translate\(\s*0(?:\.0+)?[\s,]+0(?:\.0+)?\s*\)\s*$/.test(t);
}

// Centre of the rigged mouth: the translate on <g class="mouth-rig">, or on
// the plain <g> wrapping <g class="mouth-wrap"> (older rigs, e.g. bill.svg).
function mouthRigCenter(svg: string): { x: number; y: number } | null {
  const num = '(-?[\\d.]+)[\\s,]+(-?[\\d.]+)';
  const m =
    svg.match(new RegExp(`class="mouth-rig"[^>]*transform="translate\\(\\s*${num}`)) ??
    svg.match(new RegExp(`<g\\b[^>]*transform="translate\\(\\s*${num}[^"]*"[^>]*>\\s*<g class="mouth-wrap"`));
  return m ? { x: +m[1], y: +m[2] } : null;
}

function contains(bb: ParsedPath['bbox'], x: number, y: number): boolean {
  return x >= bb.x && x <= bb.x + bb.w && y >= bb.y && y <= bb.y + bb.h;
}

function center(p: ParsedPath): { x: number; y: number } {
  return { x: p.bbox.x + p.bbox.w / 2, y: p.bbox.y + p.bbox.h / 2 };
}

const n2 = (v: number): string => (Math.round(v * 100) / 100).toString();

export function tagEyes(svg: string, prefix: string): EyeRigResult {
  const none = { svg, eyes: 0, pupils: 0 };
  if (svg.includes('class="cs-lids"')) return none;
  const vb = parseViewBox(svg) ?? { w: 2048, h: 2048 };
  const all = parsePaths(svg, vb).filter((p) => hasIdentityTransform(p.full));
  const mouth = mouthRigCenter(svg);
  const luma = (p: ParsedPath): number | null => fillLuma(p.fill);
  const isLight = (p: ParsedPath): boolean => (luma(p) ?? 0) >= 110;
  const isDark = (p: ParsedPath): boolean => {
    const l = luma(p);
    return l !== null && l < 80;
  };

  // When the mouth is rigged, the eyes must sit above it and near its x.
  const pair = findEyePair(all, (a, b) => {
    if (!mouth) return true;
    const midX = ((a.cx + b.cx) / 2) * vb.w;
    const midY = ((a.cy + b.cy) / 2) * vb.h;
    const span = Math.abs(a.cx - b.cx) * vb.w;
    return midY < mouth.y && Math.abs(midX - mouth.x) < span * 1.5 && mouth.y - midY < span * 4;
  });
  if (!pair) return none;

  // Each eye is a light "container" (the eye white, whose path becomes the
  // clip) and the dark pupils inside it. The detected pair is either the
  // whites themselves or the pupils (when the whites are one merged shape).
  type Eye = { container: ParsedPath; box: ParsedPath['bbox']; pupils: ParsedPath[] };
  const eyes: Eye[] = [];
  for (const e of pair) {
    if (isLight(e)) {
      const pupils = all.filter((p) => {
        if (!isDark(p) || p.offset <= e.offset) return false;
        if (p.bbox.w > e.bbox.w * 0.5 || p.bbox.h > e.bbox.h * 0.5) return false;
        const c = center(p);
        const dx = (c.x - (e.bbox.x + e.bbox.w / 2)) / (e.bbox.w / 2);
        const dy = (c.y - (e.bbox.y + e.bbox.h / 2)) / (e.bbox.h / 2);
        return dx * dx + dy * dy < 0.72;
      });
      eyes.push({ container: e, box: e.bbox, pupils });
    } else if (isDark(e)) {
      const c = center(e);
      const container = all
        .filter(
          (p) =>
            isLight(p) &&
            p.offset < e.offset &&
            contains(p.bbox, c.x, c.y) &&
            p.nw <= 0.4 &&
            p.nh <= 0.3 &&
            !(mouth && contains(p.bbox, mouth.x, mouth.y)),
        )
        .sort((a, b) => a.bbox.w * a.bbox.h - b.bbox.w * b.bbox.h)[0];
      if (container) eyes.push({ container, box: container.bbox, pupils: [e] });
    }
  }
  if (eyes.length === 0) return none;

  // Two pupils in one merged white: split the white's box between them.
  if (eyes.length === 2 && eyes[0].container === eyes[1].container) {
    const [a, b] = eyes[0].pupils[0].cx < eyes[1].pupils[0].cx ? eyes : [eyes[1], eyes[0]];
    const bb = a.container.bbox;
    const split = (center(a.pupils[0]).x + center(b.pupils[0]).x) / 2;
    a.box = { x: bb.x, y: bb.y, w: split - bb.x, h: bb.h };
    b.box = { x: split, y: bb.y, w: bb.x + bb.w - split, h: bb.h };
  }

  // Lid colour: the face, i.e. the smallest light shape under the mouth.
  const containers = new Set(eyes.map((e) => e.container));
  const face = mouth
    ? all
        .filter(
          (p) =>
            isLight(p) &&
            !containers.has(p) &&
            contains(p.bbox, mouth.x, mouth.y) &&
            p.nw > 0.1,
        )
        .sort((a, b) => a.bbox.w * a.bbox.h - b.bbox.w * b.bbox.h)[0]
    : undefined;
  const lidFill = face?.fill ?? eyes[0].container.fill;
  const outline = all
    .filter(isDark)
    .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)[0];
  const lashFill = outline?.fill ?? '#111111';

  // Build the lid markup per container (one clip, one lid pair per eye box)
  // and insert it after the last pupil drawn on that container.
  const inserts = new Map<number, string>();
  const groups = new Map<ParsedPath, Eye[]>();
  for (const e of eyes) groups.set(e.container, [...(groups.get(e.container) ?? []), e]);
  let n = 0;
  for (const [container, list] of groups) {
    const clipId = `${prefix}-eye${n++}`;
    const lids = list
      .map(({ box: b }) => {
        const pad = Math.max(b.w, b.h) * 0.06;
        const x0 = b.x - pad;
        const x1 = b.x + b.w + pad;
        const y0 = b.y - pad;
        const y1 = b.y + b.h + pad;
        const m = b.y + b.h * 0.55;
        const sag = b.h * 0.1;
        const lash = Math.max(b.h * 0.05, 4);
        const cx = b.x + b.w / 2;
        const curve = `Q ${n2(cx)} ${n2(m + sag)} `;
        const upOpen = -(m + sag - y0 + lash);
        const downOpen = y1 - m;
        return (
          `<g class="cs-lid-up" data-cs-open="${n2(upOpen)}" transform="translate(0 ${n2(upOpen)})">` +
          `<path d="M ${n2(x0)} ${n2(y0)} H ${n2(x1)} V ${n2(m)} ${curve}${n2(x0)} ${n2(m)} Z" fill="${lidFill}"/>` +
          `<path d="M ${n2(x0)} ${n2(m)} ${curve}${n2(x1)} ${n2(m)}" fill="none" stroke="${lashFill}" stroke-width="${n2(lash)}" stroke-linecap="round"/>` +
          `</g>` +
          `<g class="cs-lid-down" data-cs-open="${n2(downOpen)}" transform="translate(0 ${n2(downOpen)})">` +
          `<path d="M ${n2(x0)} ${n2(m)} ${curve}${n2(x1)} ${n2(m)} V ${n2(y1)} H ${n2(x0)} Z" fill="${lidFill}"/>` +
          `</g>`
        );
      })
      .join('');
    const markup =
      `<clipPath id="${clipId}"><path d="${container.d}"/></clipPath>` +
      `<g class="cs-lids" clip-path="url(#${clipId})" visibility="hidden">${lids}</g>`;
    const tag = [container, ...list.flatMap((e) => e.pupils)].sort((a, b) => b.offset - a.offset)[0];
    inserts.set(tag.offset + tag.full.length, markup);
  }

  // Pupils: allowed travel (in path units) to look fully left/right/up/down,
  // ending at the same spot in each eye so the gaze stays coherent.
  const edits = [...inserts].map(([at, text]) => ({ at, text }));
  let pupils = 0;
  for (const { box: b, pupils: list } of eyes) {
    for (const p of list) {
      const c = center(p);
      const rx = Math.max(0, Math.min(b.w * 0.26, b.w / 2 - p.bbox.w / 2 - b.w * 0.1));
      const ry = Math.max(0, Math.min(b.h * 0.2, b.h / 2 - p.bbox.h / 2 - b.h * 0.12));
      const bx = b.x + b.w / 2;
      const by = b.y + b.h / 2;
      const gaze = [bx - rx - c.x, bx + rx - c.x, by - ry - c.y, by + ry - c.y].map(n2).join(' ');
      const cls = p.full.search(/\sclass="/);
      edits.push({
        at: p.offset + '<path'.length,
        text: `${cls >= 0 ? '' : ' class="cs-pupil"'} data-cs-gaze="${gaze}"`,
      });
      if (cls >= 0) edits.push({ at: p.offset + cls + ' class="'.length, text: 'cs-pupil ' });
      pupils++;
    }
  }

  // Splice from the end so earlier offsets stay valid.
  edits.sort((a, b) => b.at - a.at);
  let out = svg;
  for (const { at, text } of edits) out = out.slice(0, at) + text + out.slice(at);
  return { svg: out, eyes: eyes.length, pupils };
}

export type ReplaceMouthOptions = {
  /** Expand the mouth bbox by this multiplier before scoring paths for
   *  removal. Slack so paths whose bbox extends slightly past the LLM's
   *  bbox (lip outlines, teeth that poke past the mouth corners) still
   *  get caught. Default 1.3. */
  paddingFactor?: number;
  /** Remove a path if more than this fraction of its bbox area lies
   *  inside the (padded) mouth bbox. 0.4 catches multi-path mouths
   *  (outline + tongue + teeth) while leaving the face shape intact. */
  removalThreshold?: number;
  /** Clamp the rig scale factor — protects against pathological LLM
   *  bboxes (1px mouth or full-canvas mouth). */
  scaleClamp?: [number, number];
};

export type ReplaceMouthResult = {
  svg: string;
  rigged: boolean;
  removedCount: number;
  scale: number;
  cx: number;
  cy: number;
};

// Drop the rig at a known mouth bbox (typically from the vision LLM) and
// remove every path whose bbox is mostly inside that bbox. Unlike the
// previous "find one centroid-inside path" approach, this catches
// multi-path mouths (outline + tongue + teeth + lips) and tolerates
// LLM bboxes that are a few percent off — the padding factor + bbox
// intersection (vs centroid-inside) test gives ~10% slack on each side.
export function replaceMouthRegion(
  svg: string,
  mouthBbox: { x: number; y: number; width: number; height: number },
  options?: ReplaceMouthOptions,
): ReplaceMouthResult {
  const padding = options?.paddingFactor ?? 1.3;
  const threshold = options?.removalThreshold ?? 0.4;
  const [scaleMin, scaleMax] = options?.scaleClamp ?? [0.4, 2.5];

  if (svg.includes('class="mouth-group')) {
    return { svg, rigged: true, removedCount: 0, scale: 1, cx: 0, cy: 0 };
  }
  const vb = parseViewBox(svg);
  if (!vb) {
    return { svg, rigged: false, removedCount: 0, scale: 1, cx: 0, cy: 0 };
  }

  // Mouth bbox in SVG units.
  const mw = vb.w * mouthBbox.width;
  const mh = vb.h * mouthBbox.height;
  const cx = vb.w * (mouthBbox.x + mouthBbox.width / 2);
  const cy = vb.h * (mouthBbox.y + mouthBbox.height / 2);

  // Expanded bbox for path-removal scoring.
  const padW = mw * padding;
  const padH = mh * padding;
  const removalBox = {
    x: cx - padW / 2,
    y: cy - padH / 2,
    w: padW,
    h: padH,
  };

  const pathRe =
    /<path\b[^>]*\bd="([^"]+)"[^>]*\/?>(?:\s*<\/path>)?/g;
  const toRemove: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(svg)) !== null) {
    const full = m[0];
    const d = m[1];
    const bb = pathBbox(d);
    if (!bb) continue;
    const overlap = bboxIntersectionArea(bb, removalBox);
    if (overlap <= 0) continue;
    const pathArea = Math.max(1, bb.w * bb.h);
    const score = overlap / pathArea;
    if (score > threshold) toRemove.push(full);
  }

  let out = svg;
  for (const p of toRemove) {
    out = out.replace(p, '');
  }

  const scale = clamp(mw / RIG_TEMPLATE_REFERENCE_WIDTH, scaleMin, scaleMax);
  const rig = renderRig(cx, cy, scale);
  out = out.replace('</svg>', `${rig}</svg>`);

  return {
    svg: out,
    rigged: true,
    removedCount: toRemove.length,
    scale,
    cx,
    cy,
  };
}

function renderRig(cx: number, cy: number, scale: number): string {
  return MOUTH_RIG_TEMPLATE.replace('__CX__', cx.toFixed(2))
    .replace('__CY__', cy.toFixed(2))
    .replace('__SCALE__', scale.toFixed(4));
}

// Crop an SVG to a bbox by rewriting its viewBox attribute. Returns a
// SQUARE crop centered on the bbox (with side = max(w,h) * paddingFactor)
// so renderers can produce a square PNG without letterboxing — keeps the
// pass-2 mouth-detection coord conversion straightforward.
//
// `bbox` is normalized 0-1 against the original SVG. The returned SVG
// has the same content; only the viewBox attribute is changed.
export function cropSvgToBbox(
  svg: string,
  bbox: { x: number; y: number; width: number; height: number },
  paddingFactor = 1.1,
): { svg: string; cropBbox: { x: number; y: number; width: number; height: number } } {
  const vb = parseViewBox(svg);
  if (!vb) return { svg, cropBbox: bbox };

  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const sideNorm = Math.max(bbox.width, bbox.height) * paddingFactor;

  // Crop region in normalized coords (may extend slightly outside [0,1]
  // for faces near the edge — that's fine; the renderer just paints
  // background into those pixels).
  const cropBbox = {
    x: cx - sideNorm / 2,
    y: cy - sideNorm / 2,
    width: sideNorm,
    height: sideNorm,
  };

  // Convert to SVG units for the viewBox.
  const x = vb.w * cropBbox.x;
  const y = vb.h * cropBbox.y;
  const w = vb.w * cropBbox.width;
  const h = vb.h * cropBbox.height;

  const newSvg = svg.replace(
    /viewBox="[^"]+"/,
    `viewBox="${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}"`,
  );
  return { svg: newSvg, cropBbox };
}

function bboxIntersectionArea(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  return (x2 - x1) * (y2 - y1);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function stripMagenta(svg: string): string {
  // Recraft sometimes emits a <rect ... fill="rgb(255,0,255)"> covering the
  // canvas. Drop any rect with that exact fill — leaves true foreground
  // whites and structural fills alone.
  return svg
    .replace(
      /<rect\b[^>]*fill="rgb\(\s*255\s*,\s*0\s*,\s*255\s*\)"[^>]*\/?>(?:\s*<\/rect>)?/g,
      '',
    )
    .replace(
      /<path\b[^>]*fill="rgb\(\s*255\s*,\s*0\s*,\s*255\s*\)"[^>]*\/?>(?:\s*<\/path>)?/g,
      '',
    );
}

// Strip any path/rect whose bbox covers ≥95% of the viewBox, regardless
// of color. Recraft V4 ignores the `background_color: magenta` request
// roughly 1 in 10 character generations and paints a white (or other)
// full-canvas rect instead. This catches all of those — magenta, white,
// or anything else — by geometry, not color, so it doesn't touch real
// foreground whites (teeth, eyes, hair highlights) which never extend
// edge-to-edge. Apply to characters; do not apply to scenes (they want
// a background by definition).
export function stripBackgroundFill(svg: string): string {
  const vb = parseViewBox(svg);
  if (!vb) return svg;
  const fullCovers = (w: number, h: number): boolean =>
    w >= vb.w * 0.95 && h >= vb.h * 0.95;

  let out = svg.replace(
    /<rect\b([^>]*)\/?>(?:\s*<\/rect>)?/g,
    (full, attrs: string) => {
      const w = parseFloat(attrs.match(/\bwidth="([^"]+)"/)?.[1] ?? '0');
      const h = parseFloat(attrs.match(/\bheight="([^"]+)"/)?.[1] ?? '0');
      return fullCovers(w, h) ? '' : full;
    },
  );
  out = out.replace(
    /<path\b[^>]*\bd="([^"]+)"[^>]*\/?>(?:\s*<\/path>)?/g,
    (full, d: string) => {
      const bb = pathBbox(d);
      if (!bb) return full;
      return fullCovers(bb.w, bb.h) ? '' : full;
    },
  );
  return out;
}

export function normalizeViewBox(svg: string, target = 2432): string {
  const vb = parseViewBox(svg);
  if (!vb) return svg;
  if (Math.abs(vb.w - target) < 1 && Math.abs(vb.h - target) < 1) return svg;
  // Wrap the existing inner content in a <g transform="..."> that scales
  // and centers the original viewBox into the target.
  const scale = target / Math.max(vb.w, vb.h);
  const tx = (target - vb.w * scale) / 2;
  const ty = (target - vb.h * scale) / 2;
  const innerMatch = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  if (!innerMatch) return svg;
  const inner = innerMatch[1];
  const newInner = `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})">${inner}</g>`;
  const newOpen = svg.match(/<svg[^>]*>/)![0]
    .replace(/viewBox="[^"]+"/, `viewBox="0 0 ${target} ${target}"`);
  return `${newOpen}${newInner}</svg>`;
}
