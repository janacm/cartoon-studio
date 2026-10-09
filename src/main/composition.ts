import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { Show } from '../shared/show';
import { showWorkingDir } from './showStore';
import { readLineMeta } from './tts';
import { buildMouthCues, type Cue } from './cues';
import {
  MOTION_CSS,
  actorHtml,
  buildMotionPlan,
  motionIntro,
  motionScript,
  prepareCharacterSvg,
  propsHtml,
  type MotionInput,
} from './motion';

const STAGE_W = 1920;
const STAGE_H = 1080;
const GAP_S = 0.35;
// Portrait pan timing — shared between the live preview camera and the
// render-time baked timeline so what the user previews matches the final
// MP4 frame-for-frame. Duration is the tween length; lead is how far
// before a segment's start the pan begins so it lands roughly on the
// first beat of the new line.
const PORTRAIT_PAN_DURATION = 0.4;
const PORTRAIT_PAN_LEAD = 0.15;
const PORTRAIT_PAN_EASE = 'power2.out';

// Resolve the bundled GSAP so we can serve it locally. Loading from a CDN
// works in the Electron preview (it has network), but HyperFrames' headless
// Chrome during render can't reach cdn.jsdelivr.net — the inline timeline
// script then throws `gsap is not defined` and window.__timelines never gets
// registered, so the rendered MP4 has no lip sync.
//
// fs handles asar paths transparently, so app.getAppPath() works in both
// dev and packaged builds.
function gsapSource(): string {
  return path.join(app.getAppPath(), 'node_modules', 'gsap', 'dist', 'gsap.min.js');
}

type Segment = {
  id: string;
  speaker: string;
  audioUrl: string;
  startAt: number;
  duration: number;
  text: string;
  words: Array<{ text: string; start: number; end: number }>;
  cues: Cue[];
};

export type BuildResult = {
  outDir: string;
  composition: string;
  scene: string;
  duration: number;
  missingLines: string[];
};

export type ViewMode = 'landscape' | 'portrait';

export type BuildOptions = {
  // Default 'landscape' matches the preview iframe. 'portrait' is used
  // when exporting a 9:16 MP4 — the HTML is rebuilt with a 1080x1920
  // viewport and camera tweens baked into the GSAP timeline so the
  // render pipeline (which seeks the timeline per frame) captures the
  // speaker-follow pans.
  viewMode?: ViewMode;
  // Character motion, props and camera moves (see ./motion.ts). Unset means
  // no motion layer at all, which is what the desktop app builds today.
  motion?: MotionInput;
};

export async function buildComposition(
  show: Show,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const viewMode: ViewMode = options.viewMode ?? 'landscape';
  const dir = showWorkingDir(show.id);
  await fs.mkdir(dir, { recursive: true });

  const segments: Segment[] = [];
  const missing: string[] = [];
  const motion = options.motion;
  let cursor = motion ? motionIntro(motion, show) : 0;

  for (const line of show.dialogue) {
    const meta = await readLineMeta(show.id, line.id);
    if (!meta) {
      missing.push(line.id);
      continue;
    }
    const duration = +(meta.durationMs / 1000).toFixed(3);
    const words = meta.words;
    // Prefer cues computed from the audio itself (Rhubarb, written by
    // agent/render-episode.ts); fall back to the word-timing heuristic.
    const cues =
      (meta as { cues?: Cue[] }).cues ?? buildMouthCues(words, duration);
    segments.push({
      id: line.id,
      speaker: line.speakerId,
      audioUrl: meta.audioFile,
      startAt: +cursor.toFixed(3),
      duration,
      text: line.text,
      words,
      cues,
    });
    cursor += duration + GAP_S;
  }

  const audioDuration = +Math.max(0, cursor - GAP_S + 0.5).toFixed(3);
  const motionPlan = motion
    ? buildMotionPlan(show, segments, motion, audioDuration)
    : null;
  const totalDuration = motionPlan ? motionPlan.duration : audioDuration;
  const speakers = [...new Set(segments.map((s) => s.speaker))];
  // Character positions (normalized 0..1) are needed in the iframe so the
  // portrait-mode camera can look up the active speaker's stage coordinates
  // without another round-trip to the main process.
  const characters = show.characters.map((c) => ({
    id: c.id,
    x: c.x,
    y: c.y,
    scale: c.scale,
  }));
  const sceneData = {
    scene: show.id,
    duration: totalDuration,
    speakers,
    characters,
    segments,
  };
  const sceneJsPath = path.join(dir, 'scene.js');
  await fs.writeFile(
    sceneJsPath,
    `window.SCENE_DATA = ${JSON.stringify(sceneData, null, 2)};\n` +
      (motionPlan ? `window.MOTION_PLAN = ${JSON.stringify(motionPlan)};\n` : ''),
  );

  // Copy GSAP into the show dir so both the in-app preview and the
  // HyperFrames render path can load it locally (no CDN dependency).
  await fs.copyFile(gsapSource(), path.join(dir, 'gsap.min.js'));
  // Write the interactive-preview player as an external file. HyperFrames'
  // inline-script scanner flags `requestAnimationFrame`/`performance.now()`
  // and switches to screenshot capture mode, which breaks our render.
  // External <script src="..."> files are NOT scanned, so keeping the RAF
  // player off the inline path lets HyperFrames stay in normal mode (where
  // it seeks the registered timeline per frame) and the mouth animates.
  await fs.writeFile(path.join(dir, 'player.js'), PLAYER_JS, 'utf8');

  const html = renderHtml(show, segments, totalDuration, viewMode, motion);
  // Write as index.html so hyperframes render auto-discovers the composition
  // when we point it at the show working dir.
  const compPath = path.join(dir, 'index.html');
  await fs.writeFile(compPath, html, 'utf8');

  return {
    outDir: dir,
    composition: compPath,
    scene: sceneJsPath,
    duration: totalDuration,
    missingLines: missing,
  };
}

function renderHtml(
  show: Show,
  segments: Segment[],
  totalDuration: number,
  viewMode: ViewMode,
  motion?: MotionInput,
): string {
  // The output viewport is what HyperFrames renders. The stage inside is
  // always 1920x1080 — character positions (normalized 0..1) resolve against
  // stage coords regardless of the output aspect. Portrait just means the
  // camera crops the stage to a 1080x1920 window centered on the speaker.
  const outW = viewMode === 'portrait' ? STAGE_H : STAGE_W; // 1080 vs 1920
  const outH = viewMode === 'portrait' ? STAGE_W : STAGE_H; // 1920 vs 1080

  const bgImg = show.scene
    ? `<img class="scene-bg" src="${svgDataUri(show.scene.svg)}" alt="" />`
    : '';

  const characters = show.characters
    .map((c) => {
      const left = (c.x * 100).toFixed(2);
      const top = (c.y * 100).toFixed(2);
      const baseW = STAGE_W * 0.2;
      const svg = motion ? prepareCharacterSvg(c.svg, c.id, motion) : c.svg;
      const inlineSvg = ensureSvgId(svg, `${c.id}-rig`);
      return `
        <div class="slot" style="left:${left}%;top:${top}%;width:${baseW}px;transform:translate(-50%,-100%) scale(${c.scale.toFixed(2)});z-index:${Math.round(c.y * 1000)};">
          ${motion ? actorHtml(c.id, inlineSvg) : inlineSvg}
        </div>`;
    })
    .join('\n');
  // With motion, the stage contents sit in a .cam wrapper for push-ins.
  const camOpen = motion ? '<div class="cam">' : '';
  const camClose = motion ? `${propsHtml(motion)}\n        </div>` : '';

  const audioTags = segments
    .map(
      (s) =>
        `      <audio id="aud-${s.id}" data-start="${s.startAt}" data-duration="${s.duration.toFixed(2)}" data-track-index="0" data-volume="1" src="${s.audioUrl}"></audio>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(show.name)}</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      html, body {
        width: 100%; height: 100%; overflow: hidden; background: #111;
      }
      /* Viewport is the output frame — 1920x1080 (landscape) or 1080x1920
         (portrait). HyperFrames reads data-width/data-height off this
         element to size the render. In preview, the script below scales
         it to fit the iframe; in render the body matches viewport size
         so the fit-scale is 1. */
      .viewport[data-composition-id="${show.id}"] {
        position: absolute; top: 50%; left: 50%;
        width: ${outW}px; height: ${outH}px;
        background: #111; color: #1a1a1a; overflow: hidden;
        transform-origin: center center;
        transform: translate(-50%, -50%) scale(1);
      }
      /* Stage is the 1920x1080 world where characters live. The camera
         transform on this element (scale + translate) is what pans to
         the active speaker in portrait mode; in landscape it's identity
         and the stage fills the viewport exactly. */
      .stage {
        position: absolute;
        top: 50%; left: 50%;
        width: ${STAGE_W}px; height: ${STAGE_H}px;
        margin-top: ${-STAGE_H / 2}px;
        margin-left: ${-STAGE_W / 2}px;
        transform-origin: center center;
        /* transform is managed by GSAP (camera script + baked timeline) */
      }
      .scene-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 0; }
      .slot { position: absolute; transform-origin: bottom center; }
      .slot svg { width: 100%; height: auto; display: block; }
      .mouth-group { opacity: 0; }
      .mouth-group.mouth-X { opacity: 1; }${motion ? MOTION_CSS : ''}
    </style>
  </head>
  <body>
    <div class="viewport" data-composition-id="${show.id}" data-width="${outW}" data-height="${outH}" data-start="0" data-duration="${totalDuration}" data-view-mode="${viewMode}">
      <div class="stage">${camOpen}
        ${bgImg}
        ${characters}${camClose}
      </div>
${audioTags}
      <script src="scene.js"></script>
      <script src="gsap.min.js"></script>
      <script>
        // Viewport fit: scales the output frame (.viewport) down to fit
        // the iframe/body. In the render path the body matches the
        // viewport size exactly, so the fit scale resolves to 1 and this
        // is effectively a no-op. Re-reads outW/outH from the dataset on
        // every fit so the preview mode-toggle (which mutates the dataset
        // + style) flows through without a separate handshake.
        (function () {
          var vp = document.querySelector('.viewport');
          if (!vp) return;
          function fit() {
            var outW = parseInt(vp.dataset.width, 10) || 1920;
            var outH = parseInt(vp.dataset.height, 10) || 1080;
            var w = document.documentElement.clientWidth || window.innerWidth;
            var h = document.documentElement.clientHeight || window.innerHeight;
            var s = Math.min(w / outW, h / outH);
            if (Math.abs(s - 1) < 0.01) s = 1;
            vp.style.transform = 'translate(-50%, -50%) scale(' + s + ')';
          }
          fit();
          window.addEventListener('resize', fit);
          window.addEventListener('load', fit);
        })();
      </script>
      <script>
        // Camera manager. Targets .stage (the 1920x1080 inner frame) and
        // applies a GSAP transform (x/y/scale) that positions the stage
        // inside the viewport. Two modes:
        //   landscape — identity (stage fills viewport 1:1).
        //   portrait  — cover the viewport by height, translate the stage
        //               so the active speaker's face sits at viewport
        //               centre, clamped to stage edges.
        //
        // Initial mode is read from the viewport's data-view-mode, which
        // is baked at build time. Preview can switch modes at runtime via
        // a parent postMessage; render has the mode baked and the timeline
        // below also bakes per-segment camera tweens so HyperFrames' per-
        // frame seek captures the pans.
        (function () {
          var STAGE_W = ${STAGE_W};
          var STAGE_H = ${STAGE_H};
          // Vertical offset from character feet to face centre, in stage
          // height units. 0.35 lands on the torso/head of a typical rig.
          var FACE_OFFSET = 0.35;
          var PAN_DURATION = ${PORTRAIT_PAN_DURATION};
          var PAN_EASE = '${PORTRAIT_PAN_EASE}';

          var vp = document.querySelector('.viewport');
          var stage = document.querySelector('.stage');
          if (!vp || !stage) return;

          var S = window.SCENE_DATA || { characters: [], segments: [] };
          var charById = {};
          (S.characters || []).forEach(function (c) { charById[c.id] = c; });

          var outW = parseInt(vp.dataset.width, 10) || STAGE_W;
          var outH = parseInt(vp.dataset.height, 10) || STAGE_H;
          var mode = vp.dataset.viewMode === 'portrait' ? 'portrait' : 'landscape';
          var firstSpeaker = (S.characters && S.characters[0] && S.characters[0].id) || null;
          var lastSpeaker = firstSpeaker;

          function activeSpeakerAt(t) {
            var segs = S.segments || [];
            for (var i = 0; i < segs.length; i++) {
              var s = segs[i];
              if (t >= s.startAt && t < s.startAt + s.duration) return s.speaker;
            }
            return lastSpeaker;
          }

          function computeCamera(speakerId) {
            if (mode === 'landscape') return { x: 0, y: 0, scale: 1 };
            var ch = charById[speakerId];
            var nx = ch ? ch.x : 0.5;
            var ny = ch ? Math.max(0, ch.y - FACE_OFFSET) : 0.5;
            var faceX = nx * STAGE_W;
            var faceY = ny * STAGE_H;
            // Cover the viewport by whichever axis has the tighter ratio,
            // so neither side letterboxes.
            var s = Math.max(outW / STAGE_W, outH / STAGE_H);
            var dx = (STAGE_W / 2 - faceX) * s;
            var dy = (STAGE_H / 2 - faceY) * s;
            var halfVW = outW / 2, halfVH = outH / 2;
            var halfSW = STAGE_W * s / 2, halfSH = STAGE_H * s / 2;
            var maxDx = Math.max(0, halfSW - halfVW);
            var maxDy = Math.max(0, halfSH - halfVH);
            if (dx > maxDx) dx = maxDx;
            if (dx < -maxDx) dx = -maxDx;
            if (dy > maxDy) dy = maxDy;
            if (dy < -maxDy) dy = -maxDy;
            return { x: dx, y: dy, scale: s };
          }

          // Initial camera — snap into position before the first paint
          // so neither preview nor render flashes an un-cropped frame.
          var init = computeCamera(lastSpeaker);
          gsap.set(stage, init);

          // Preview: the parent posts mode-switch messages into the iframe.
          // Render never receives these (no parent driver), so mode stays
          // as baked.
          //
          // On mode change we also resize the viewport element itself —
          // the preview HTML is always built with the landscape viewport
          // size baked, and the toggle needs to flip that at runtime so
          // the fit script re-scales and the camera math uses the correct
          // outW/outH.
          window.addEventListener('message', function (ev) {
            var d = ev.data || {};
            if (d.type !== 'cartoonstudio:viewMode') return;
            var next = d.mode === 'portrait' ? 'portrait' : 'landscape';
            if (next === mode) return;
            mode = next;
            outW = mode === 'portrait' ? STAGE_H : STAGE_W;
            outH = mode === 'portrait' ? STAGE_W : STAGE_H;
            vp.style.width = outW + 'px';
            vp.style.height = outH + 'px';
            vp.dataset.width = String(outW);
            vp.dataset.height = String(outH);
            // Kick the fit script (it listens for resize).
            window.dispatchEvent(new Event('resize'));
            var c = computeCamera(lastSpeaker || firstSpeaker);
            gsap.to(stage, {
              x: c.x, y: c.y, scale: c.scale,
              duration: PAN_DURATION, ease: PAN_EASE,
            });
          });

          // Tick hook for player.js (preview path). On each animation
          // frame, detect speaker change and tween the camera. The render
          // path doesn't load player.js — it relies on the baked timeline
          // tweens below instead.
          window.__agentParkCamera = {
            mode: function () { return mode; },
            computeCamera: computeCamera,
            onTick: function (t) {
              if (mode !== 'portrait') return;
              var sp = activeSpeakerAt(t);
              if (sp && sp !== lastSpeaker) {
                lastSpeaker = sp;
                var c = computeCamera(sp);
                gsap.to(stage, {
                  x: c.x, y: c.y, scale: c.scale,
                  duration: PAN_DURATION, ease: PAN_EASE,
                });
              }
            },
            onSeek: function (t) {
              if (mode !== 'portrait') return;
              var sp = activeSpeakerAt(t) || firstSpeaker;
              lastSpeaker = sp;
              gsap.set(stage, computeCamera(sp));
            },
          };
        })();
      </script>
      <script>
        (function () {
          var S = window.SCENE_DATA;
          if (!S) return;
          S.speakers.forEach(function (sp) {
            gsap.set("#" + sp + "-rig .mouth-group", { opacity: 0 });
            gsap.set("#" + sp + "-rig .mouth-X", { opacity: 1 });
          });
          window.__timelines = window.__timelines || {};
          var tl = gsap.timeline({ paused: true });
          S.segments.forEach(function (seg) {
            var rigSel = "#" + seg.speaker + "-rig";
            var prev = "X";
            seg.cues.forEach(function (cue) {
              var t = seg.startAt + cue.start;
              if (cue.value === prev) return;
              tl.set(rigSel + " .mouth-" + prev, { opacity: 0 }, t);
              tl.set(rigSel + " .mouth-" + cue.value, { opacity: 1 }, t);
              prev = cue.value;
            });
            var endT = seg.startAt + seg.duration;
            if (prev !== "X") {
              tl.set(rigSel + " .mouth-" + prev, { opacity: 0 }, endT);
              tl.set(rigSel + " .mouth-X", { opacity: 1 }, endT);
            }
          });

          // Portrait render: bake per-segment camera pans into the same
          // timeline HyperFrames seeks per frame. We pull the compute fn
          // off the camera manager so the math stays in one place. The
          // lead-in (0.15s) makes the pan finish just as the new voice
          // begins — matches how a real edit would cut.
          var cam = window.__agentParkCamera;
          var stage = document.querySelector('.stage');
          if (cam && stage && cam.mode() === 'portrait') {
            var PAN_LEAD = ${PORTRAIT_PAN_LEAD};
            var PAN_DURATION = ${PORTRAIT_PAN_DURATION};
            var PAN_EASE = '${PORTRAIT_PAN_EASE}';
            var lastSpeaker = null;
            S.segments.forEach(function (seg) {
              if (seg.speaker === lastSpeaker) return;
              lastSpeaker = seg.speaker;
              var c = cam.computeCamera(seg.speaker);
              var t = Math.max(0, seg.startAt - PAN_LEAD);
              tl.to(
                stage,
                { x: c.x, y: c.y, scale: c.scale, duration: PAN_DURATION, ease: PAN_EASE },
                t,
              );
            });
          }

          window.__timelines["${show.id}"] = tl;
          // Expose to the preview-only player.js for the RAF loop.
          window.__agentPark = { tl: tl, duration: S.duration };
        })();
      </script>${motion ? `\n      ${motionScript(show.id)}` : ''}
      <script>
        // Load the RAF/audio player only in interactive preview mode
        // (URL has ?preview=1). The render pipeline loads the page without
        // that flag, so the inline scripts HyperFrames scans stay clean of
        // performance.now / requestAnimationFrame, and HyperFrames seeks
        // the registered timeline directly per frame.
        if (location.search.indexOf('preview=1') >= 0) {
          var s = document.createElement('script');
          s.src = 'player.js';
          document.body.appendChild(s);
        }
      </script>
    </div>
  </body>
</html>
`;
}

function ensureSvgId(svg: string, id: string): string {
  if (/<svg[^>]*\bid=/.test(svg)) {
    return svg.replace(/<svg([^>]*)\bid="[^"]*"/, `<svg$1 id="${id}"`);
  }
  return svg.replace(/<svg/, `<svg id="${id}"`);
}

// Preview-only RAF player. Loaded via <script src="player.js"> so it never
// appears in the inline scripts HyperFrames scans for non-determinism. Reads
// the registered timeline off window.__agentPark (set by the inline script).
const PLAYER_JS = `(function () {
  var ap = window.__agentPark;
  if (!ap || !ap.tl) return;
  var tl = ap.tl;
  var duration = ap.duration;
  var audios = Array.prototype.slice.call(
    document.querySelectorAll('audio[id^="aud-"]'),
  );
  var played = {};
  var t0 = 0;
  var elapsed = 0;
  var rafId = 0;
  function tick() {
    var now = performance.now() / 1000;
    var t = elapsed + (now - t0);
    tl.time(Math.min(t, duration));
    audios.forEach(function (a) {
      var s = parseFloat(a.dataset.start);
      if (!played[a.id] && t >= s) {
        played[a.id] = true;
        a.currentTime = Math.max(0, t - s);
        a.play().catch(function () {});
      }
    });
    if (window.__agentParkCamera) window.__agentParkCamera.onTick(t);
    window.parent.postMessage({ type: 'cartoonstudio:tick', t: t }, '*');
    if (t < duration) {
      rafId = requestAnimationFrame(tick);
    } else {
      doPause();
      window.parent.postMessage({ type: 'cartoonstudio:ended' }, '*');
    }
  }
  function doPlay() {
    if (rafId) return;
    if (elapsed >= duration) {
      elapsed = 0;
      played = {};
      audios.forEach(function (a) {
        try { a.pause(); } catch (e) {}
        a.currentTime = 0;
      });
      tl.time(0);
    }
    t0 = performance.now() / 1000;
    rafId = requestAnimationFrame(tick);
  }
  function doPause() {
    if (rafId) {
      elapsed += performance.now() / 1000 - t0;
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    audios.forEach(function (a) { try { a.pause(); } catch (e) {} });
  }
  function doSeek(t) {
    doPause();
    elapsed = Math.max(0, Math.min(duration, t));
    played = {};
    audios.forEach(function (a) {
      a.pause();
      a.currentTime = 0;
      var s = parseFloat(a.dataset.start);
      if (elapsed >= s + parseFloat(a.dataset.duration)) played[a.id] = true;
    });
    tl.time(elapsed);
    if (window.__agentParkCamera) window.__agentParkCamera.onSeek(elapsed);
  }
  window.__player = {
    duration: duration,
    play: doPlay,
    pause: doPause,
    seek: doSeek,
    stop: function () { doSeek(0); },
  };
  window.addEventListener('message', function (ev) {
    var d = ev.data || {};
    if (!d.type) return;
    if (d.type === 'cartoonstudio:play') doPlay();
    else if (d.type === 'cartoonstudio:pause') doPause();
    else if (d.type === 'cartoonstudio:seek')
      doSeek(typeof d.t === 'number' ? d.t : 0);
    else if (d.type === 'cartoonstudio:restart') { doSeek(0); doPlay(); }
  });
  window.parent.postMessage(
    { type: 'cartoonstudio:ready', duration: duration },
    '*',
  );
})();
`;

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
