// Headless episode renderer, so a coding agent can make a cartoon without the
// desktop app. Reads an episode file, voices each line, times the mouth shapes
// with Rhubarb Lip Sync, builds the same HyperFrames composition the app
// builds, and renders it to MP4.
//
//   node --env-file-if-exists=agent/.env --import ./agent/hooks.mjs \
//     agent/render-episode.ts agent/episodes/green-balloon.json [-o out.mp4] [--portrait]
//
// Voices: "say:<macOS voice>" (free, local), "kokoro:<voice>[@speed]" (free,
// local, needs uv) or "elevenlabs:<voice id>"
// (needs ELEVENLABS_API_KEY). Lip sync: Rhubarb when installed (RHUBARB_PATH
// or the default location below), otherwise the app's word-timing heuristic.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ShowSchema, type Show } from '../src/shared/show.ts';
import { buildComposition } from '../src/main/composition.ts';
import { showWorkingDir } from '../src/main/showStore.ts';
import { generateLine } from '../src/main/tts.ts';
import { chromePath } from '../src/main/binaries.ts';
import * as M from './episode-motion.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = path.join(REPO, 'resources', 'defaults');
// Same model the app's voice catalog uses (src/shared/voices.ts).
const ELEVENLABS_MODEL = 'elevenlabs/eleven_v3';
// Kokoro-82M v1.0 on MLX, run through a uv inline script (agent/kokoro_tts.py).
const KOKORO_SCRIPT = path.join(REPO, 'agent', 'kokoro_tts.py');
const KOKORO_MODEL = process.env.KOKORO_MODEL ?? 'mlx-community/Kokoro-82M-bf16';
const RHUBARB =
  process.env.RHUBARB_PATH ??
  path.join(
    os.homedir(),
    '.local/opt/rhubarb-lip-sync-1.14.0/Rhubarb-Lip-Sync-1.14.0-macOS/rhubarb',
  );

const Id = z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and dashes');

const EpisodeSchema = z.object({
  name: z.string(),
  // Bundled scene name (backyard, living-room, park, street) or an .svg path.
  scene: z.string(),
  characters: z.array(
    z.object({
      id: Id,
      // Bundled character name (bill, jane, max, ted) or an .svg path.
      svg: z.string(),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      scale: z.number().min(0.1).max(3).default(1),
      voice: z.string(),
      enter: M.EnterSchema.optional(), // motion: walk on from off-screen
      faces: M.FacesSchema.optional(), // motion: which way the art faces
    }),
  ),
  lines: z.array(
    z.object({
      speaker: Id,
      text: z.string().min(1),
      voice: z.string().optional(),
      actions: z.array(M.ActionSchema).optional(), // motion: jump, nod, turn, walk, move a prop...
      camera: M.CameraSchema.optional(), // motion: "push", "wide" or { push, zoom }
    }),
  ),
  // Motion layer (agent/episode-motion.ts, src/main/motion.ts).
  motion: M.MotionSettingsSchema.optional(),
  intro: z.number().min(0).optional(),
  props: z.array(M.PropSchema).optional(),
});
type Episode = z.infer<typeof EpisodeSchema>;

type Cue = { start: number; end: number; value: string };

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${path.basename(cmd)} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'episode';
}

function readSvg(ref: string, kind: 'characters' | 'scenes', baseDir: string): string {
  if (ref.endsWith('.svg')) return fs.readFileSync(path.resolve(baseDir, ref), 'utf8');
  const file = kind === 'scenes' ? `scene-${ref}.svg` : `${ref}.svg`;
  return fs.readFileSync(path.join(DEFAULTS, kind, file), 'utf8');
}

function parseVoice(spec: string): { kind: 'say' | 'elevenlabs' | 'kokoro'; voice: string; speed?: number } {
  const i = spec.indexOf(':');
  const kind = spec.slice(0, i);
  const voice = spec.slice(i + 1);
  if ((kind !== 'say' && kind !== 'elevenlabs' && kind !== 'kokoro') || !voice) {
    throw new Error(
      `Unknown voice "${spec}". Use "say:<macOS voice>", "kokoro:<voice>[@speed]" or "elevenlabs:<voice id>".`,
    );
  }
  if (kind === 'kokoro') {
    // "af_heart" or "af_heart@1.1"; speed is Kokoro's rate multiplier.
    const m = /^([a-z]{2}_[a-z]+)(?:@(.+))?$/.exec(voice);
    const speed = m?.[2] === undefined ? 1 : Number(m[2]);
    if (!m || !(speed >= 0.5 && speed <= 2)) {
      throw new Error(`Bad Kokoro voice "${spec}". Use e.g. "kokoro:af_heart" or "kokoro:af_heart@1.1" (speed 0.5-2).`);
    }
    return { kind, voice: m[1], speed };
  }
  return { kind, voice };
}

function toShow(ep: Episode, baseDir: string): Show {
  const now = Date.now();
  const byId = new Map(ep.characters.map((c) => [c.id, c]));
  return ShowSchema.parse({
    id: slug(ep.name),
    name: ep.name,
    createdAt: now,
    updatedAt: now,
    scene: { id: slug(ep.scene), name: ep.scene, svg: readSvg(ep.scene, 'scenes', baseDir) },
    characters: ep.characters.map((c, i) => ({
      id: c.id,
      name: c.id,
      svg: readSvg(c.svg, 'characters', baseDir),
      x: c.x,
      y: c.y,
      scale: c.scale,
      z: i,
      provider: parseVoice(c.voice).kind,
      model: '',
      voice: c.voice,
    })),
    dialogue: ep.lines.map((l, i) => {
      const speaker = byId.get(l.speaker);
      if (!speaker) throw new Error(`Line ${i + 1}: unknown speaker "${l.speaker}"`);
      const spec = l.voice ?? speaker.voice;
      return {
        id: `l${String(i + 1).padStart(2, '0')}`,
        speakerId: l.speaker,
        text: l.text,
        provider: parseVoice(spec).kind,
        model: '',
        voice: spec,
      };
    }),
  });
}

// Rhubarb reads WAV or Ogg; returns its mouth cues and the clip length.
function rhubarbCues(wav: string, text: string): { cues: Cue[]; duration: number } {
  const dialog = `${wav}.dialog.txt`;
  const out = `${wav}.rhubarb.json`;
  fs.writeFileSync(dialog, text);
  run(RHUBARB, ['-f', 'json', '-d', dialog, '-o', out, '-q', wav]);
  const r = JSON.parse(fs.readFileSync(out, 'utf8')) as {
    metadata: { duration: number };
    mouthCues: Cue[];
  };
  return { cues: r.mouthCues, duration: r.metadata.duration };
}

// Cache key for a voiced line. Kokoro lines also key on speed and model.
function lineHash(line: Show['dialogue'][number], useRhubarb: boolean): string {
  const { kind, voice, speed } = parseVoice(line.voice);
  const extra = kind === 'kokoro' ? `|${speed}|${KOKORO_MODEL}` : '';
  return crypto
    .createHash('sha256')
    .update(`${kind}|${voice}${extra}|${line.text}|${useRhubarb}`)
    .digest('hex')
    .slice(0, 16);
}

async function isCached(metaPath: string, hash: string): Promise<boolean> {
  try {
    return JSON.parse(await fsp.readFile(metaPath, 'utf8')).agentHash === hash;
  } catch {
    return false; // not voiced yet
  }
}

// Voices every uncached Kokoro line in one Python process, so the model loads
// once. Writes <lineId>.wav; voiceLine then runs Rhubarb on each one.
async function voiceKokoroBatch(show: Show, useRhubarb: boolean): Promise<void> {
  const dir = showWorkingDir(show.id);
  const jobs: Array<{ text: string; voice: string; speed: number; out: string }> = [];
  for (const line of show.dialogue) {
    const { kind, voice, speed = 1 } = parseVoice(line.voice);
    if (kind !== 'kokoro') continue;
    if (await isCached(path.join(dir, `${line.id}.meta.json`), lineHash(line, useRhubarb))) continue;
    jobs.push({ text: line.text, voice, speed, out: path.join(dir, `${line.id}.wav`) });
  }
  if (!jobs.length) return;
  if (!useRhubarb) {
    throw new Error('"kokoro" voices have no word timings, so they need Rhubarb for lip sync.');
  }
  const jobsFile = path.join(dir, 'kokoro-jobs.json');
  await fsp.writeFile(jobsFile, JSON.stringify(jobs, null, 2));
  log(`  kokoro: ${jobs.length} lines in one batch (${KOKORO_MODEL})`);
  const started = Date.now();
  const r = spawnSync('uv', ['run', '--script', KOKORO_SCRIPT, '--model', KOKORO_MODEL, jobsFile], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (r.error) {
    throw new Error(`Kokoro voices need uv (https://docs.astral.sh/uv/): ${r.error.message}`);
  }
  if (r.status !== 0) throw new Error(`kokoro_tts.py failed (${r.status})`);
  log(`  kokoro: done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

async function voiceLine(
  show: Show,
  line: Show['dialogue'][number],
  useRhubarb: boolean,
): Promise<void> {
  const dir = showWorkingDir(show.id);
  const metaPath = path.join(dir, `${line.id}.meta.json`);
  const { kind, voice } = parseVoice(line.voice);
  const hash = lineHash(line, useRhubarb);
  if (await isCached(metaPath, hash)) {
    log(`  ${line.id} cached`);
    return;
  }

  if (kind === 'say' || kind === 'kokoro') {
    if (!useRhubarb) {
      throw new Error(`"${kind}" voices have no word timings, so they need Rhubarb for lip sync.`);
    }
    const audioFile = `${line.id}.wav`;
    const wav = path.join(dir, audioFile);
    // Kokoro WAVs were already written by voiceKokoroBatch.
    if (kind === 'say') {
      run('say', ['-v', voice, '-o', wav, '--file-format=WAVE', '--data-format=LEI16@22050', line.text]);
    }
    const { cues, duration } = rhubarbCues(wav, line.text);
    const meta = { hash, agentHash: hash, audioFile, words: [], durationMs: Math.round(duration * 1000) + 150, cues };
    await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
  } else {
    const r = await generateLine({
      showId: show.id,
      lineId: line.id,
      text: line.text,
      provider: 'elevenlabs',
      model: ELEVENLABS_MODEL,
      voice,
      force: true,
    });
    const meta: Record<string, unknown> = { ...r, agentHash: hash };
    delete meta.cached;
    if (useRhubarb) {
      const wav = path.join(dir, `${line.id}.rhubarb.wav`);
      run('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(dir, r.audioFile), '-ac', '1', '-ar', '22050', wav]);
      meta.cues = rhubarbCues(wav, line.text).cues;
    }
    await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2));
  }
  log(`  ${line.id} voiced (${kind}:${voice})`);
}

function render(dir: string, output: string): Promise<void> {
  const cli = path.join(REPO, 'node_modules', 'hyperframes', 'dist', 'cli.js');
  // HyperFrames spawns bare `ffmpeg`; put the bundled one on PATH.
  const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string;
  const chrome = chromePath();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'render', dir, '-o', output, '--quiet'], {
      cwd: dir,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        PATH: `${path.dirname(ffmpeg)}${path.delimiter}${process.env.PATH ?? ''}`,
        PUPPETEER_EXECUTABLE_PATH: chrome,
        PRODUCER_HEADLESS_SHELL_PATH: chrome,
      },
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`hyperframes render exited with code ${code}`)),
    );
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' },
      portrait: { type: 'boolean', default: false },
      'no-rhubarb': { type: 'boolean', default: false },
    },
  });
  const episodePath = positionals[0];
  if (!episodePath) {
    throw new Error('usage: render-episode.ts <episode.json> [-o out.mp4] [--portrait] [--no-rhubarb]');
  }
  const baseDir = path.dirname(path.resolve(episodePath));
  const episode = EpisodeSchema.parse(JSON.parse(fs.readFileSync(episodePath, 'utf8')));
  const show = toShow(episode, baseDir);
  const useRhubarb = !values['no-rhubarb'] && fs.existsSync(RHUBARB);
  const output = path.resolve(values.output ?? path.join(baseDir, `${show.id}.mp4`));

  const dir = showWorkingDir(show.id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'show.json'), JSON.stringify(show, null, 2));

  log(`Voicing ${show.dialogue.length} lines (lip sync: ${useRhubarb ? 'Rhubarb' : 'word heuristic'})`);
  await voiceKokoroBatch(show, useRhubarb);
  for (const line of show.dialogue) await voiceLine(show, line, useRhubarb);

  const built = await buildComposition(show, {
    viewMode: values.portrait ? 'portrait' : 'landscape',
    motion: M.episodeMotion(episode, show, baseDir),
  });
  if (built.missingLines.length) throw new Error(`Lines without audio: ${built.missingLines.join(', ')}`);
  log(`Composition: ${built.composition} (${built.duration.toFixed(1)} s)`);

  log(`Rendering ${output}`);
  await render(built.outDir, output);
  log(`Done: ${output}`);
}

main().catch((err: unknown) => {
  log(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
