// Motion layer for the HyperFrames composition: idle breathing and sway,
// blinks, gaze, a bob on the active speaker, walk-on entrances and exits,
// per-line actions (jump, nod, turn, ...), props with keyframed moves, and
// camera push-ins.
//
// buildComposition() only uses this when BuildOptions.motion is set, so the
// desktop app's output is unchanged unless it opts in.
//
// Determinism: everything that varies (blink times, breathing phase) is
// planned here with a seeded PRNG and written to window.MOTION_PLAN. The
// runtime below evaluates that plan as a pure function of time. It hangs off
// a single tween on the composition's GSAP timeline whose setter calls
// frame(t), so any seek, in any order and in any render worker, produces the
// same pose. No Math.random, Date.now, requestAnimationFrame or CSS
// animations.

import type { Show } from '../shared/show';
import type { Cue } from './cues';
import { tagEyes } from './svgRig';

const STAGE_W = 1920;
const STAGE_H = 1080;
// composition.ts: a character slot is 20% of the stage wide at scale 1.
const SLOT_W = STAGE_W * 0.2;

// ---------------------------------------------------------------------------
// Input: what an episode asks for.

export type Side = 'left' | 'right';
// Seconds from the line's start (negative is fine), or "end", "end-0.5".
export type TimeRef = number | string;

export type MoveTarget = {
  x?: number;
  y?: number;
  rotate?: number;
  scale?: number;
  opacity?: number;
};

export type MotionAction = {
  do:
    | 'jump'
    | 'hop'
    | 'nod'
    | 'shake'
    | 'spin'
    | 'surprise'
    | 'turn'
    | 'look'
    | 'walk'
    | 'enter'
    | 'exit'
    | 'move'
    | 'show'
    | 'hide';
  // Character or prop id. Defaults to the line's speaker.
  who?: string;
  at?: TimeRef;
  duration?: number;
  // turn/look: a character or prop id, or left/right/up/down/front.
  // walk: an x position (0..1) or { x, y }. exit: left/right.
  // move (props): { x, y, rotate, scale, opacity }.
  to?: string | number | MoveTarget;
  from?: Side; // enter
  height?: number; // jump/hop/surprise, as a fraction of the character's height
  count?: number; // hop/nod/shake/spin repetitions; drift cycles for move
  ease?: string; // move/walk: any GSAP ease name
  drift?: number; // move: sideways sway while moving, fraction of stage width
};

export type MotionCamera =
  | 'push'
  | 'wide'
  | { push?: string; zoom?: number; at?: TimeRef; duration?: number; hold?: boolean };

export type MotionCharacter = {
  // Walk on from off-screen at the start (or at `at` seconds).
  enter?: Side | { from: Side; at?: number; duration?: number };
  // Which way the art faces; drives turn and walk mirroring.
  faces?: 'left' | 'right' | 'front';
  blink?: boolean;
  idle?: boolean;
};

export type MotionProp = {
  id: string;
  svg: string; // SVG markup
  x: number; // centre, as a fraction of the stage
  y: number;
  scale?: number; // 1 = 20% of the stage width, like characters
  rotate?: number;
  opacity?: number;
  z?: number | 'front' | 'back';
  float?: boolean | number; // gentle bob; a number scales it
};

export type MotionLine = { actions?: MotionAction[]; camera?: MotionCamera };

export type MotionInput = {
  idle?: boolean; // breathing and sway (default on)
  blink?: boolean; // default on
  talk?: boolean; // bob on the active speaker (default on)
  gaze?: boolean; // pupils follow the conversation (default on)
  intro?: number; // seconds before the first line
  seed?: number;
  characters?: Record<string, MotionCharacter>;
  props?: MotionProp[];
  lines?: Record<string, MotionLine>; // keyed by dialogue line id
};

export type MotionSegment = {
  id: string;
  speaker: string;
  startAt: number;
  duration: number;
  cues: Cue[];
};

// ---------------------------------------------------------------------------
// Plan: what the runtime evaluates.

// A keyframe track. Each segment eases from wherever the track is at t0
// (the runtime chains them) to `to`; null keeps that channel.
type Seg = {
  t0: number;
  t1: number;
  to: Array<number | null>;
  ease: string;
  walk?: [number, number, number]; // steps, bob (x height), rock degrees
  drift?: [number, number, number]; // amplitude px, cycles, tilt degrees
};
type Track = { init: number[]; segs: Seg[] };

type ActorPlan = {
  id: string;
  k: number; // stage px -> slot px
  h: number; // character height in stage px
  pos: Track; // [dx, dy] stage px from home
  face: Track; // [scaleX]
  gaze: Track; // [gx, gy], -1..1, stage directions
  acts: Array<[string, number, number, number, number]>; // kind, t0, dur, amp, count
  talk: Array<[number, number, number[]]>; // t0, t1, energy at 30 Hz
  idle: number[] | null; // breathAmp, breathPeriod, breathPhase, swayDeg, swayPeriod, swayPhase
  blinks: number[];
};

type PropPlan = {
  id: string;
  track: Track; // [dx, dy, rotate, scale, opacity]
  float: number[] | null; // amp px, period, phase, degrees, period, phase
};

export type MotionPlan = {
  duration: number;
  actors: ActorPlan[];
  props: PropPlan[];
  camera: Track | null; // [zoom, tx, ty]
};

// ---------------------------------------------------------------------------
// Helpers

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function viewBoxAspect(svg: string): number {
  const m = svg.match(/viewBox="([^"]+)"/);
  const p = m ? m[1].split(/[ ,]+/).map(Number) : [];
  return p.length >= 4 && p[2] > 0 && p[3] > 0 ? p[3] / p[2] : 1;
}

// Linear stand-in for the runtime's track evaluation, used for planning
// decisions (where is Max when Jane looks at him?). Eases are ignored.
function sample(tr: Track, t: number): number[] {
  const segs = [...tr.segs].sort((a, b) => a.t0 - b.t0);
  const froms: number[][] = [];
  const at = (limit: number, time: number): number[] => {
    for (let i = limit - 1; i >= 0; i--) {
      const s = segs[i];
      if (s.t0 > time) continue;
      const u = s.t1 > s.t0 ? clamp((time - s.t0) / (s.t1 - s.t0), 0, 1) : 1;
      return froms[i].map((f, j) => f + ((s.to[j] ?? f) - f) * u);
    }
    return tr.init;
  };
  for (let i = 0; i < segs.length; i++) froms.push(at(i, segs[i].t0));
  return at(segs.length, t);
}

function addSeg(tr: Track, seg: Seg): void {
  tr.segs.push(seg);
  tr.segs.sort((a, b) => a.t0 - b.t0);
}

// Lip-sync cue -> how open the mouth is, which drives the talking bob.
const OPENNESS: Record<string, number> = {
  X: 0,
  A: 0.15,
  B: 0.35,
  C: 0.65,
  D: 1,
  E: 0.7,
  F: 0.45,
  G: 0.3,
  H: 0.75,
};

export function motionIntro(motion: MotionInput, show: Show): number {
  if (motion.intro !== undefined) return Math.max(0, motion.intro);
  // Default: let walk-on entrances at the start finish before anyone talks.
  let intro = 0;
  for (const c of show.characters) {
    const enter = normEnter(motion.characters?.[c.id]?.enter);
    if (!enter || (enter.at ?? 0) > 0.5) continue;
    const h = SLOT_W * viewBoxAspect(c.svg) * c.scale;
    const dist = Math.abs(offscreenX(enter.from, c.scale) - c.x) * STAGE_W;
    intro = Math.max(intro, (enter.at ?? 0) + (enter.duration ?? walkDuration(dist, h)) + 0.2);
  }
  return r3(intro);
}

function normEnter(e: MotionCharacter['enter']): { from: Side; at?: number; duration?: number } | null {
  if (!e) return null;
  return typeof e === 'string' ? { from: e } : e;
}

function offscreenX(side: Side, scale: number): number {
  const half = 0.1 * scale + 0.01; // half a slot, plus a margin
  return side === 'left' ? -half : 1 + half;
}

function walkDuration(distPx: number, heightPx: number): number {
  return r3(clamp(distPx / (0.9 * heightPx), 0.6, 4));
}

function resolveAt(ref: TimeRef | undefined, seg: MotionSegment, def = 0): number {
  if (ref === undefined) return Math.max(0, seg.startAt + def);
  if (typeof ref === 'number') return Math.max(0, seg.startAt + ref);
  const m = ref.replace(/\s+/g, '').match(/^(start|end)?([+-]?\d*\.?\d+)?$/);
  if (!m || (!m[1] && !m[2])) {
    throw new Error(`Line ${seg.id}: bad time "${ref}". Use seconds from the line start, "end" or "end-0.5".`);
  }
  const base = m[1] === 'end' ? seg.startAt + seg.duration : seg.startAt;
  return Math.max(0, base + (m[2] ? parseFloat(m[2]) : 0));
}

// ---------------------------------------------------------------------------
// Planning

export function buildMotionPlan(
  show: Show,
  segments: MotionSegment[],
  motion: MotionInput,
  baseDuration: number,
): MotionPlan {
  const seed = motion.seed ?? 1;
  const props = motion.props ?? [];
  const charIds = new Set(show.characters.map((c) => c.id));
  const propIds = new Set(props.map((p) => p.id));
  for (const id of Object.keys(motion.characters ?? {})) {
    if (!charIds.has(id)) throw new Error(`motion: unknown character "${id}"`);
  }
  for (const p of props) {
    if (charIds.has(p.id)) throw new Error(`motion: prop id "${p.id}" is also a character id`);
  }
  const known = [...charIds, ...propIds].join(', ');
  let end = 0;
  const touch = (t: number): void => {
    end = Math.max(end, t);
  };

  type Actor = ActorPlan & {
    x: number;
    y: number;
    s: number;
    artDir: 1 | -1;
    front: boolean;
    looks: Array<{ t0: number; t1: number; prio: number; target: string | [number, number] }>;
  };
  const actors = new Map<string, Actor>();
  for (const c of show.characters) {
    const cm = motion.characters?.[c.id] ?? {};
    const h = SLOT_W * viewBoxAspect(c.svg) * c.scale;
    actors.set(c.id, {
      id: c.id,
      k: r3(1 / c.scale),
      h: r3(h),
      pos: { init: [0, 0], segs: [] },
      face: { init: [1], segs: [] },
      gaze: { init: [0, 0], segs: [] },
      acts: [],
      talk: [],
      idle: null,
      blinks: [],
      x: c.x,
      y: c.y,
      s: c.scale,
      artDir: cm.faces === 'left' ? -1 : 1,
      front: (cm.faces ?? 'front') === 'front',
      looks: [],
    });
  }
  const propPlans = new Map<string, PropPlan & { p: MotionProp }>();
  for (const p of props) {
    propPlans.set(p.id, {
      id: p.id,
      p,
      track: { init: [0, 0, p.rotate ?? 0, 1, p.opacity ?? 1], segs: [] },
      float: null,
    });
  }

  const posAt = (a: Actor, t: number): [number, number] => {
    const [dx, dy] = sample(a.pos, t);
    return [a.x * STAGE_W + dx, a.y * STAGE_H + dy];
  };
  const facePoint = (a: Actor, t: number): [number, number] => {
    const [x, y] = posAt(a, t);
    return [x, y - 0.8 * a.h];
  };
  const pointOf = (id: string, t: number): [number, number] => {
    const a = actors.get(id);
    if (a) return facePoint(a, t);
    const pp = propPlans.get(id);
    if (!pp) throw new Error(`motion: unknown "${id}"`);
    const [dx, dy] = sample(pp.track, t);
    return [pp.p.x * STAGE_W + dx, pp.p.y * STAGE_H + dy];
  };
  const onStage = (a: Actor, t: number): boolean => {
    const x = posAt(a, t)[0] / STAGE_W;
    return x > -0.02 && x < 1.02;
  };

  // Walk a character to stage x (px offset dx from home) starting at t.
  const walk = (a: Actor, t: number, toDx: number, toDy: number, opts: MotionAction, ease: string): number => {
    const [fx, fy] = sample(a.pos, t);
    const dist = Math.hypot(toDx - fx, toDy - fy);
    const dur = opts.duration ?? walkDuration(dist, a.h);
    const steps = Math.max(2, Math.round(dist / (0.3 * a.h)));
    addSeg(a.pos, {
      t0: r3(t),
      t1: r3(t + dur),
      to: [r3(toDx), r3(toDy)],
      ease: opts.ease ?? ease,
      walk: [steps, 0.035, 2.5],
    });
    const dir = Math.sign(toDx - fx);
    if (dir) {
      a.looks.push({ t0: t, t1: t + dur, prio: 1, target: [0.75 * dir, 0] });
      if (!a.front) turnTo(a, t, dir as 1 | -1, 0.2);
    }
    touch(t + dur);
    return t + dur;
  };

  const turnTo = (a: Actor, t: number, dir: 1 | -1, dur: number): void => {
    const target = dir * a.artDir;
    const current = sample(a.face, t)[0];
    if (Math.sign(current) === target) return;
    addSeg(a.face, { t0: r3(t), t1: r3(t + dur), to: [target], ease: 'sine.inOut' });
    a.acts.push(['hop', r3(t), r3(dur), 0.025, 1]);
  };

  // Character-level entrances.
  for (const a of actors.values()) {
    const enter = normEnter(motion.characters?.[a.id]?.enter);
    if (!enter) continue;
    a.pos.init = [r3((offscreenX(enter.from, a.s) - a.x) * STAGE_W), 0];
    walk(a, enter.at ?? 0, 0, 0, { do: 'enter', duration: enter.duration }, 'power1.out');
  }

  // A line-level enter needs the character to start off-screen.
  for (const seg of segments) {
    for (const act of motion.lines?.[seg.id]?.actions ?? []) {
      const a = actors.get(act.who ?? seg.speaker);
      if (act.do !== 'enter' || !a || a.pos.segs.length) continue;
      a.pos.init = [r3((offscreenX(act.from ?? 'left', a.s) - a.x) * STAGE_W), 0];
    }
  }

  // Per-line actions.
  for (const seg of segments) {
    for (const act of motion.lines?.[seg.id]?.actions ?? []) {
      const who = act.who ?? seg.speaker;
      const t = resolveAt(act.at, seg);
      const lineEnd = seg.startAt + seg.duration;
      const a = actors.get(who);
      const pp = propPlans.get(who);
      const where = `Line ${seg.id} (${act.do} ${who})`;

      if (!a) {
        if (!pp) throw new Error(`Line ${seg.id}: unknown "${who}" (known: ${known})`);
        const tr = pp.track;
        if (act.do === 'move') {
          const to = act.to;
          if (!to || typeof to !== 'object') throw new Error(`${where}: "to" must be { x, y, rotate, scale, opacity }`);
          const dur = act.duration ?? 1;
          const base = pp.p.scale ?? 0.3;
          addSeg(tr, {
            t0: r3(t),
            t1: r3(t + dur),
            to: [
              to.x === undefined ? null : r3((to.x - pp.p.x) * STAGE_W),
              to.y === undefined ? null : r3((to.y - pp.p.y) * STAGE_H),
              to.rotate ?? null,
              to.scale === undefined ? null : r3(to.scale / base),
              to.opacity ?? null,
            ],
            ease: act.ease ?? 'sine.inOut',
            drift: act.drift
              ? [r3(act.drift * STAGE_W), act.count ?? 1.5, r3(clamp(act.drift * 300, 2, 20))]
              : undefined,
          });
          touch(t + dur);
        } else if (act.do === 'show' || act.do === 'hide') {
          const dur = act.duration ?? 0.3;
          addSeg(tr, {
            t0: r3(t),
            t1: r3(t + dur),
            to: [null, null, null, null, act.do === 'show' ? 1 : 0],
            ease: 'sine.inOut',
          });
          touch(t + dur);
        } else {
          throw new Error(`${where}: props support move, show and hide`);
        }
        continue;
      }

      const actor = a;
      switch (act.do) {
        case 'jump': {
          const dur = act.duration ?? 0.9;
          actor.acts.push(['jump', r3(t), dur, act.height ?? 0.3, 1]);
          touch(t + dur);
          break;
        }
        case 'hop': {
          const count = act.count ?? 2;
          const dur = act.duration ?? 0.36 * count;
          actor.acts.push(['hop', r3(t), r3(dur), act.height ?? 0.08, count]);
          touch(t + dur);
          break;
        }
        case 'nod': {
          const count = act.count ?? 2;
          const dur = act.duration ?? 0.32 * count;
          actor.acts.push(['nod', r3(t), r3(dur), 0.05, count]);
          touch(t + dur);
          break;
        }
        case 'shake': {
          const count = act.count ?? 3;
          const dur = act.duration ?? 0.2 * count + 0.1;
          actor.acts.push(['shake', r3(t), r3(dur), 3.5, count]);
          touch(t + dur);
          break;
        }
        case 'spin': {
          const count = act.count ?? 1;
          const dur = act.duration ?? 0.6 * count;
          actor.acts.push(['spin', r3(t), r3(dur), 0, count]);
          touch(t + dur);
          break;
        }
        case 'surprise': {
          const dur = act.duration ?? 0.7;
          actor.acts.push(['surprise', r3(t), dur, act.height ?? 0.06, 1]);
          touch(t + dur);
          break;
        }
        case 'turn': {
          const dur = act.duration ?? 0.3;
          let dir: 1 | -1;
          if (act.to === 'left' || act.to === 'right') dir = act.to === 'left' ? -1 : 1;
          else if (typeof act.to === 'string') {
            if (!actors.has(act.to) && !propIds.has(act.to)) throw new Error(`${where}: unknown target "${act.to}"`);
            dir = pointOf(act.to, t)[0] >= posAt(actor, t)[0] ? 1 : -1;
            actor.looks.push({ t0: t, t1: Math.max(lineEnd, t + 1.5), prio: 2, target: act.to });
          } else dir = (Math.sign(sample(actor.face, t)[0]) * actor.artDir * -1) as 1 | -1;
          const target = dir * actor.artDir;
          addSeg(actor.face, { t0: r3(t), t1: r3(t + dur), to: [target], ease: 'sine.inOut' });
          actor.acts.push(['hop', r3(t), r3(dur), 0.025, 1]);
          touch(t + dur);
          break;
        }
        case 'look': {
          const to = act.to ?? 'front';
          const fixed: Record<string, [number, number]> = {
            left: [-0.85, 0],
            right: [0.85, 0],
            up: [0, -0.85],
            down: [0, 0.7],
            front: [0, 0],
          };
          if (typeof to !== 'string' || (!fixed[to] && !actors.has(to) && !propIds.has(to))) {
            throw new Error(`${where}: "to" must be a character or prop id, or left/right/up/down/front`);
          }
          const t1 = act.duration !== undefined ? t + act.duration : Math.max(lineEnd, t + 1.5);
          actor.looks.push({ t0: t, t1, prio: 2, target: fixed[to] ?? to });
          touch(t1);
          break;
        }
        case 'walk':
        case 'move': {
          let toX: number;
          let toY = actor.y;
          if (typeof act.to === 'number') toX = act.to;
          else if (act.to && typeof act.to === 'object' && act.to.x !== undefined) {
            toX = act.to.x;
            toY = act.to.y ?? actor.y;
          } else throw new Error(`${where}: "to" must be an x position (0..1) or { x, y }`);
          walk(actor, t, (toX - actor.x) * STAGE_W, (toY - actor.y) * STAGE_H, act, 'power1.inOut');
          break;
        }
        case 'enter': {
          let toDx = 0;
          if (typeof act.to === 'number') toDx = (act.to - actor.x) * STAGE_W;
          walk(actor, t, toDx, 0, act, 'power1.out');
          break;
        }
        case 'exit': {
          const side: Side =
            act.to === 'left' || act.to === 'right'
              ? act.to
              : posAt(actor, t)[0] < STAGE_W / 2
                ? 'left'
                : 'right';
          walk(actor, t, (offscreenX(side, actor.s) - actor.x) * STAGE_W, 0, act, 'power1.in');
          break;
        }
        default:
          throw new Error(`${where}: unknown action "${(act as { do: string }).do}"`);
      }
    }
  }

  // Camera, once characters have their moves.
  let camera: Track | null = null;
  segments.forEach((seg, i) => {
    const spec = motion.lines?.[seg.id]?.camera;
    if (!spec) return;
    camera ??= { init: [1, 0, 0], segs: [] };
    const o = typeof spec === 'string' ? {} : spec;
    const t0 = resolveAt(o.at, seg, -0.1);
    const dur = o.duration ?? 0.8;
    if (spec === 'wide') {
      addSeg(camera, { t0: r3(t0), t1: r3(t0 + dur), to: [1, 0, 0], ease: 'power2.inOut' });
      touch(t0 + dur);
      return;
    }
    const target = o.push ?? seg.speaker;
    if (!actors.has(target) && !propIds.has(target)) throw new Error(`Line ${seg.id}: camera target "${target}" unknown`);
    const z = clamp(o.zoom ?? 1.3, 1, 3);
    const [fx, fy] = pointOf(target, t0 + dur);
    // Bring the subject partway toward frame centre, then keep the stage
    // covering the frame so no edge shows.
    const cx = fx + (STAGE_W / 2 - fx) * 0.4;
    const cy = fy + (STAGE_H * 0.42 - fy) * 0.6;
    const tx = clamp(cx - z * fx, STAGE_W * (1 - z), 0);
    const ty = clamp(cy - z * fy, STAGE_H * (1 - z), 0);
    addSeg(camera, { t0: r3(t0), t1: r3(t0 + dur), to: [r3(z), r3(tx), r3(ty)], ease: 'power2.inOut' });
    touch(t0 + dur);
    const next = segments[i + 1];
    const nextHasCamera = next ? Boolean(motion.lines?.[next.id]?.camera) : false;
    if (!o.hold && !nextHasCamera) {
      const back = seg.startAt + seg.duration + 0.05;
      addSeg(camera, { t0: r3(back), t1: r3(back + 0.8), to: [1, 0, 0], ease: 'power2.inOut' });
      touch(back + 0.8);
    }
  });

  for (const seg of segments) touch(seg.startAt + seg.duration);
  const duration = r3(Math.max(baseDuration, end + 0.5));

  // Gaze: listeners look at the speaker, the speaker at whoever spoke
  // last (or the nearest character). Walks and look/turn actions override.
  if (motion.gaze !== false) {
    const list = [...actors.values()];
    for (const a of list) {
      const auto: Array<{ t: number; target: string | null }> = [];
      let lastOther: string | null = null;
      for (const seg of segments) {
        const t = Math.max(0, seg.startAt - 0.2);
        let target: string | null = null;
        if (seg.speaker !== a.id) target = seg.speaker;
        else {
          const others = list.filter((o) => o !== a && onStage(o, seg.startAt));
          if (lastOther && others.some((o) => o.id === lastOther)) target = lastOther;
          else {
            const me = posAt(a, seg.startAt)[0];
            others.sort((p, q) => Math.abs(posAt(p, seg.startAt)[0] - me) - Math.abs(posAt(q, seg.startAt)[0] - me));
            target = others[0]?.id ?? null;
          }
        }
        if (seg.speaker !== a.id) lastOther = seg.speaker;
        auto.push({ t, target });
      }
      const vecAt = (target: string | [number, number] | null, t: number): [number, number] => {
        if (target === null) return [0, 0];
        if (Array.isArray(target)) return target;
        const [ax, ay] = facePoint(a, t);
        const [bx, by] = pointOf(target, t);
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy);
        return len < 1 ? [0, 0] : [r3((0.85 * dx) / len), r3((0.85 * dy) / len)];
      };
      const valueAt = (t: number): [number, number] => {
        const live = a.looks.filter((l) => l.t0 <= t && t < l.t1).sort((p, q) => q.prio - p.prio || q.t0 - p.t0)[0];
        if (live) return vecAt(live.target, t);
        const key = [...auto].reverse().find((k) => k.t <= t);
        return vecAt(key ? key.target : null, t);
      };
      // Change points: auto keys, override edges, and samples every 0.25 s
      // inside overrides so a moving target is followed.
      const points = new Set<number>(auto.map((k) => r3(k.t)));
      for (const l of a.looks) {
        points.add(r3(l.t0));
        points.add(r3(l.t1));
        for (let t = l.t0 + 0.25; t < l.t1; t += 0.25) points.add(r3(t));
      }
      let prev: [number, number] = [0, 0];
      for (const t of [...points].sort((p, q) => p - q)) {
        if (t > duration) break;
        const v = valueAt(t);
        if (Math.abs(v[0] - prev[0]) < 0.02 && Math.abs(v[1] - prev[1]) < 0.02) continue;
        a.gaze.segs.push({ t0: t, t1: r3(t + 0.25), to: v, ease: 'sine.inOut' });
        prev = v;
      }
    }
  }

  // Talking bob, driven by how open the mouth is.
  if (motion.talk !== false) {
    for (const seg of segments) {
      const a = actors.get(seg.speaker);
      if (!a) continue;
      const n = Math.ceil(seg.duration * 30) + 1;
      const v: number[] = [];
      let e = 0;
      for (let i = 0; i < n; i++) {
        const t = i / 30;
        const cue = seg.cues.find((c) => t >= c.start && t < c.end);
        const target = OPENNESS[cue?.value ?? 'X'] ?? 0.3;
        e += (target - e) * (target > e ? 0.5 : 0.22);
        v.push(Math.round(e * 100) / 100);
      }
      a.talk.push([r3(seg.startAt), r3(seg.startAt + seg.duration), v]);
    }
  }

  // Idle breathing/sway and blinks, seeded per character.
  for (const a of actors.values()) {
    const cm = motion.characters?.[a.id] ?? {};
    const rand = rng(hash(`${a.id}:${seed}`));
    if (motion.idle !== false && cm.idle !== false) {
      a.idle = [0.012, r3(3 + rand() * 1.4), r3(rand() * Math.PI * 2), 0.7, r3(4.8 + rand() * 2.4), r3(rand() * Math.PI * 2)];
    }
    if (motion.blink !== false && cm.blink !== false) {
      for (let t = 0.6 + rand() * 2; t < duration; t += 2.4 + rand() * 3.2) {
        a.blinks.push(r3(t));
        if (rand() < 0.15) a.blinks.push(r3(t + 0.3));
      }
    }
  }

  for (const pp of propPlans.values()) {
    const f = pp.p.float;
    if (!f) continue;
    const amt = typeof f === 'number' ? f : 1;
    const rand = rng(hash(`${pp.id}:${seed}`));
    pp.float = [r3(8 * amt), r3(2.6 + rand()), r3(rand() * Math.PI * 2), r3(3 * amt), r3(3.4 + rand()), r3(rand() * Math.PI * 2)];
  }

  return {
    duration,
    actors: [...actors.values()].map((a) => ({
      id: a.id,
      k: a.k,
      h: a.h,
      pos: a.pos,
      face: a.face,
      gaze: a.gaze,
      acts: a.acts,
      talk: a.talk,
      idle: a.idle,
      blinks: a.blinks,
    })),
    props: [...propPlans.values()].map(({ id, track, float }) => ({ id, track, float })),
    camera,
  };
}

// ---------------------------------------------------------------------------
// Markup helpers for composition.ts

// Character SVG with blink lids and gaze-able pupils (see svgRig.tagEyes).
export function prepareCharacterSvg(svg: string, id: string, motion: MotionInput): string {
  const cm = motion.characters?.[id] ?? {};
  const wantEyes = (motion.blink !== false && cm.blink !== false) || motion.gaze !== false;
  return wantEyes ? tagEyes(svg, id).svg : svg;
}

export function actorHtml(id: string, svg: string): string {
  return `<div class="actor" id="${id}-actor">${svg}</div>`;
}

export function propsHtml(motion: MotionInput): string {
  return (motion.props ?? [])
    .map((p) => {
      const w = SLOT_W * (p.scale ?? 0.3);
      const z = p.z === 'front' ? 5000 : p.z === 'back' ? 1 : (p.z ?? Math.round(p.y * 1000));
      const src = `data:image/svg+xml;utf8,${encodeURIComponent(p.svg)}`;
      return `
        <div class="prop" style="left:${(p.x * 100).toFixed(2)}%;top:${(p.y * 100).toFixed(2)}%;width:${w.toFixed(1)}px;z-index:${z};">
          <div class="prop-inner" id="prop-${p.id}" style="opacity:${p.opacity ?? 1};transform:rotate(${p.rotate ?? 0}deg);"><img src="${src}" alt="" /></div>
        </div>`;
    })
    .join('\n');
}

export const MOTION_CSS = `
      .cam { position: absolute; inset: 0; transform-origin: 0 0; }
      .actor { transform-origin: 50% 100%; }
      .prop { position: absolute; transform: translate(-50%, -50%); }
      .prop-inner { transform-origin: 50% 50%; }
      .prop img { width: 100%; height: auto; display: block; }`;

export function motionScript(showId: string): string {
  return `<script>
${MOTION_RUNTIME_JS.replace('__SHOW_ID__', JSON.stringify(showId))}
      </script>`;
}

// The runtime. Inline (so HyperFrames' determinism lint sees it), ES5 style
// like the rest of the composition scripts.
const MOTION_RUNTIME_JS = `        // Motion runtime: evaluates window.MOTION_PLAN at time t. Driven by
        // one tween on the composition timeline (see src/main/motion.ts).
        (function () {
          var P = window.MOTION_PLAN;
          var tl = window.__timelines && window.__timelines[__SHOW_ID__];
          if (!P || !tl) return;
          var PI = Math.PI;
          function c01(u) { return u < 0 ? 0 : u > 1 ? 1 : u; }
          var EASES = {
            none: function (u) { return u; },
            linear: function (u) { return u; },
            'sine.in': function (u) { return 1 - Math.cos(u * PI / 2); },
            'sine.out': function (u) { return Math.sin(u * PI / 2); },
            'sine.inOut': function (u) { return -(Math.cos(PI * u) - 1) / 2; },
            'power1.in': function (u) { return u * u; },
            'power1.out': function (u) { return 1 - (1 - u) * (1 - u); },
            'power1.inOut': function (u) { return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; },
            'power2.inOut': function (u) { return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }
          };
          function ease(name) {
            if (EASES[name]) return EASES[name];
            var e = window.gsap && gsap.parseEase(name);
            return (EASES[name] = e || EASES['sine.inOut']);
          }
          // Chain each segment from the value the track has when it starts.
          function prep(tr) {
            tr.froms = [];
            for (var i = 0; i < tr.segs.length; i++) {
              var s = tr.segs[i];
              var f = valueAt(tr, s.t0, i);
              tr.froms.push(f);
              for (var j = 0; j < s.to.length; j++) if (s.to[j] === null) s.to[j] = f[j];
              s.e = ease(s.ease);
            }
          }
          function valueAt(tr, t, limit) {
            var n = limit === undefined ? tr.segs.length : limit;
            for (var i = n - 1; i >= 0; i--) {
              var s = tr.segs[i];
              if (s.t0 > t) continue;
              var k = s.e(s.t1 > s.t0 ? c01((t - s.t0) / (s.t1 - s.t0)) : 1);
              var f = tr.froms[i], out = [];
              for (var j = 0; j < f.length; j++) out.push(f[j] + (s.to[j] - f[j]) * k);
              return out;
            }
            return tr.init;
          }
          function running(tr, t) {
            for (var i = tr.segs.length - 1; i >= 0; i--) {
              var s = tr.segs[i];
              if (s.t0 <= t) return t < s.t1 ? s : null;
            }
            return null;
          }

          P.actors.forEach(function (a) {
            a.el = document.getElementById(a.id + '-actor');
            [a.pos, a.face, a.gaze].forEach(prep);
            var rig = document.getElementById(a.id + '-rig');
            a.lids = [];
            a.pupils = [];
            if (rig) {
              rig.querySelectorAll('.cs-lids').forEach(function (g) {
                a.lids.push({ g: g, parts: Array.prototype.map.call(g.children, function (p) {
                  return { el: p, open: parseFloat(p.getAttribute('data-cs-open')) || 0 };
                }) });
              });
              rig.querySelectorAll('.cs-pupil').forEach(function (p) {
                a.pupils.push({ el: p, g: p.getAttribute('data-cs-gaze').split(' ').map(Number) });
              });
            }
            a.lastBlink = -1;
            a.lastGaze = '';
          });
          P.props.forEach(function (p) { p.el = document.getElementById('prop-' + p.id); prep(p.track); });
          var cam = document.querySelector('.cam');
          if (P.camera) prep(P.camera);

          function actorFrame(a, t) {
            var p = valueAt(a.pos, t), h = a.h;
            var dx = p[0], dy = p[1], rot = 0, sx = 1, sy = 1, i, u, v;
            var w = running(a.pos, t);
            if (w && w.walk) {
              var ph = w.walk[0] * (t - w.t0) / (w.t1 - w.t0);
              dy -= w.walk[1] * h * Math.abs(Math.sin(PI * ph));
              rot += w.walk[2] * Math.sin(PI * ph);
            }
            if (a.idle) {
              var b = Math.sin(2 * PI * t / a.idle[1] + a.idle[2]);
              sy *= 1 + a.idle[0] * b;
              sx *= 1 - a.idle[0] * 0.4 * b;
              rot += a.idle[3] * Math.sin(2 * PI * t / a.idle[4] + a.idle[5]);
            }
            for (i = 0; i < a.talk.length; i++) {
              var tk = a.talk[i];
              if (t < tk[0] || t >= tk[1]) continue;
              var x = (t - tk[0]) * 30, n = Math.floor(x), f = x - n;
              var e = (tk[2][n] || 0) * (1 - f) + (tk[2][n + 1] || 0) * f;
              var env = Math.min(1, (t - tk[0]) / 0.25, (tk[1] - t) / 0.25);
              dy -= 0.018 * h * e;
              sy *= 1 + 0.03 * e;
              sx *= 1 - 0.012 * e;
              rot += 1.1 * Math.sin(2 * PI * (t - tk[0]) / 1.3) * env;
            }
            for (i = 0; i < a.acts.length; i++) {
              var ac = a.acts[i], kind = ac[0], t0 = ac[1], dur = ac[2], amp = ac[3], cnt = ac[4];
              if (t < t0 || t >= t0 + dur) continue;
              u = (t - t0) / dur;
              if (kind === 'jump') {
                if (u < 0.2) { v = Math.sin(PI * u / 0.2); sy *= 1 - 0.1 * v; sx *= 1 + 0.06 * v; }
                else if (u < 0.8) {
                  v = (u - 0.2) / 0.6;
                  dy -= amp * h * 4 * v * (1 - v);
                  var st = Math.pow(Math.sin(2 * PI * v), 2);
                  sy *= 1 + 0.06 * st; sx *= 1 - 0.03 * st;
                } else { v = Math.sin(PI * (u - 0.8) / 0.2); sy *= 1 - 0.08 * v; sx *= 1 + 0.05 * v; }
              } else if (kind === 'hop') {
                v = (u * cnt) % 1;
                dy -= amp * h * 4 * v * (1 - v);
                sy *= 1 + 0.04 * Math.pow(Math.sin(2 * PI * v), 2);
              } else if (kind === 'nod') {
                v = Math.sin(PI * ((u * cnt) % 1));
                sy *= 1 - amp * v;
                dy += 0.004 * h * v;
              } else if (kind === 'shake') {
                v = Math.sin(2 * PI * cnt * u) * Math.sin(PI * u);
                rot += amp * v;
                dx += 0.012 * h * v;
              } else if (kind === 'spin') {
                sx *= Math.cos(2 * PI * cnt * u);
              } else if (kind === 'surprise') {
                var k = u < 0.2 ? Math.sin(u / 0.2 * PI / 2) : (1 - (u - 0.2) / 0.8) * Math.cos(2.5 * PI * (u - 0.2) / 0.8);
                sy *= 1 + 0.12 * k;
                sx *= 1 - 0.05 * k;
                dy -= amp * h * Math.max(0, k);
              }
            }
            var face = valueAt(a.face, t)[0];
            sx *= face;
            if (a.el) {
              a.el.style.transform = 'translate(' + (dx * a.k).toFixed(2) + 'px,' + (dy * a.k).toFixed(2) +
                'px) rotate(' + rot.toFixed(3) + 'deg) scale(' + sx.toFixed(4) + ',' + sy.toFixed(4) + ')';
            }

            // Blink: close 70 ms, hold 50 ms, open 120 ms.
            var kb = 0;
            for (i = 0; i < a.blinks.length; i++) {
              var d = t - a.blinks[i];
              if (d < 0) break;
              if (d < 0.24) kb = d < 0.07 ? d / 0.07 : d < 0.12 ? 1 : 1 - (d - 0.12) / 0.12;
            }
            kb = Math.round(kb * 100) / 100;
            if (kb !== a.lastBlink) {
              a.lastBlink = kb;
              a.lids.forEach(function (l) {
                l.g.setAttribute('visibility', kb > 0 ? 'visible' : 'hidden');
                l.parts.forEach(function (part) {
                  part.el.setAttribute('transform', 'translate(0 ' + (part.open * (1 - kb)).toFixed(2) + ')');
                });
              });
            }

            // Round before caching so the pose depends only on t, not on
            // which frame was rendered before this one.
            var g = valueAt(a.gaze, t);
            var gx = Math.round(g[0] * (face < 0 ? -1 : 1) * 1000) / 1000, gy = Math.round(g[1] * 1000) / 1000;
            var key = gx + ',' + gy;
            if (key !== a.lastGaze) {
              a.lastGaze = key;
              a.pupils.forEach(function (p) {
                var px = gx >= 0 ? gx * p.g[1] : -gx * p.g[0];
                var py = gy >= 0 ? gy * p.g[3] : -gy * p.g[2];
                p.el.setAttribute('transform', 'translate(' + px.toFixed(2) + ' ' + py.toFixed(2) + ')');
              });
            }
          }

          function propFrame(p, t) {
            var v = valueAt(p.track, t), dx = v[0], dy = v[1], r = v[2];
            var m = running(p.track, t);
            if (m && m.drift) {
              var u = (t - m.t0) / (m.t1 - m.t0), env = Math.sin(PI * u), c = 2 * PI * m.drift[1] * u;
              dx += m.drift[0] * Math.sin(c) * env;
              r += m.drift[2] * Math.cos(c) * env;
            }
            if (p.float) {
              dy += p.float[0] * Math.sin(2 * PI * t / p.float[1] + p.float[2]);
              r += p.float[3] * Math.sin(2 * PI * t / p.float[4] + p.float[5]);
            }
            if (!p.el) return;
            p.el.style.transform = 'translate(' + dx.toFixed(2) + 'px,' + dy.toFixed(2) + 'px) rotate(' +
              r.toFixed(3) + 'deg) scale(' + v[3].toFixed(4) + ')';
            p.el.style.opacity = String(Math.round(v[4] * 1000) / 1000);
          }

          function frame(t) {
            P.actors.forEach(function (a) { actorFrame(a, t); });
            P.props.forEach(function (p) { propFrame(p, t); });
            if (P.camera && cam) {
              var c = valueAt(P.camera, t);
              cam.style.transform = 'translate(' + c[1].toFixed(2) + 'px,' + c[2].toFixed(2) + 'px) scale(' + c[0].toFixed(4) + ')';
            }
          }

          // The clock: GSAP tweens clock.t from 0 to the duration in step
          // with the timeline, and the setter renders that instant.
          var now = 0;
          var clock = {};
          Object.defineProperty(clock, 't', {
            get: function () { return now; },
            set: function (v) { now = v; frame(v); }
          });
          tl.fromTo(clock, { t: 0 }, { t: P.duration, duration: P.duration, ease: 'none' }, 0);
          frame(0);
        })();`;
