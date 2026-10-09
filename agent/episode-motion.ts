// Episode-file fields for the motion layer (src/main/motion.ts), and the
// mapping from a parsed episode to BuildOptions.motion. Kept out of
// render-episode.ts so the schema there only gains one line per field.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Show } from '../src/shared/show.ts';
import type { MotionInput, MotionLine } from '../src/main/motion.ts';

const Side = z.enum(['left', 'right']);
// Seconds from the line's start (may be negative), or "end", "end-0.5".
const TimeRef = z.union([z.number(), z.string()]);
const MoveTarget = z
  .object({
    x: z.number().optional(),
    y: z.number().optional(),
    rotate: z.number().optional(),
    scale: z.number().positive().optional(),
    opacity: z.number().min(0).max(1).optional(),
  })
  .strict();

export const ActionSchema = z
  .object({
    do: z.enum([
      'jump',
      'hop',
      'nod',
      'shake',
      'spin',
      'surprise',
      'turn',
      'look',
      'walk',
      'enter',
      'exit',
      'move',
      'show',
      'hide',
    ]),
    who: z.string().optional(),
    at: TimeRef.optional(),
    duration: z.number().positive().optional(),
    to: z.union([z.string(), z.number(), MoveTarget]).optional(),
    from: Side.optional(),
    height: z.number().positive().optional(),
    count: z.number().positive().optional(),
    ease: z.string().optional(),
    drift: z.number().optional(),
  })
  .strict();

export const CameraSchema = z.union([
  z.enum(['push', 'wide']),
  z
    .object({
      push: z.string().optional(),
      zoom: z.number().min(1).max(3).optional(),
      at: TimeRef.optional(),
      duration: z.number().positive().optional(),
      hold: z.boolean().optional(),
    })
    .strict(),
]);

export const EnterSchema = z.union([
  Side,
  z
    .object({
      from: Side,
      at: z.number().min(0).optional(),
      duration: z.number().positive().optional(),
    })
    .strict(),
]);

export const FacesSchema = z.enum(['left', 'right', 'front']);

export const PropSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
    // Path to an .svg (relative to the episode file) or inline <svg> markup.
    svg: z.string(),
    x: z.number(),
    y: z.number(),
    scale: z.number().positive().optional(),
    rotate: z.number().optional(),
    opacity: z.number().min(0).max(1).optional(),
    z: z.union([z.number(), z.enum(['front', 'back'])]).optional(),
    float: z.union([z.boolean(), z.number()]).optional(),
  })
  .strict();

// `"motion": false` turns the whole layer off (the app's original output).
export const MotionSettingsSchema = z.union([
  z.literal(false),
  z
    .object({
      idle: z.boolean().optional(),
      blink: z.boolean().optional(),
      talk: z.boolean().optional(),
      gaze: z.boolean().optional(),
      seed: z.number().optional(),
    })
    .strict(),
]);

type EpisodeMotionFields = {
  motion?: z.infer<typeof MotionSettingsSchema>;
  intro?: number;
  props?: Array<z.infer<typeof PropSchema>>;
  characters: Array<{ id: string; enter?: z.infer<typeof EnterSchema>; faces?: z.infer<typeof FacesSchema> }>;
  lines: Array<{ actions?: Array<z.infer<typeof ActionSchema>>; camera?: z.infer<typeof CameraSchema> }>;
};

function readPropSvg(ref: string, baseDir: string): string {
  const s = ref.trim();
  if (s.startsWith('<')) return s;
  if (!s.endsWith('.svg')) throw new Error(`Prop svg "${ref}" must be an .svg path or inline <svg> markup`);
  return fs.readFileSync(path.resolve(baseDir, s), 'utf8');
}

export function episodeMotion(ep: EpisodeMotionFields, show: Show, baseDir: string): MotionInput | undefined {
  if (ep.motion === false) return undefined;
  const lines: Record<string, MotionLine> = {};
  ep.lines.forEach((l, i) => {
    if (l.actions || l.camera) lines[show.dialogue[i].id] = { actions: l.actions, camera: l.camera };
  });
  const characters: NonNullable<MotionInput['characters']> = {};
  for (const c of ep.characters) {
    if (c.enter || c.faces) characters[c.id] = { enter: c.enter, faces: c.faces };
  }
  return {
    ...(ep.motion ?? {}),
    intro: ep.intro,
    characters,
    props: (ep.props ?? []).map((p) => ({ ...p, svg: readPropSvg(p.svg, baseDir) })),
    lines,
  };
}
