# Headless episode renderer

Renders a Cartoon Studio episode to MP4 without the desktop app, so a coding agent can drive the whole pipeline: voices, lip sync, composition, render.

```
node --no-warnings --env-file-if-exists=agent/.env --import ./agent/hooks.mjs \
  agent/render-episode.ts agent/episodes/green-balloon.json [-o out.mp4] [--portrait] [--no-rhubarb]
```

The MP4 goes next to the episode file unless you pass `-o`. Working files (audio, mouth cues, `index.html`) go in `.agent-work/shows/<episode-slug>/`. Voiced lines are cached by voice and text, so re-renders after staging changes only re-run the render.

## Episode file

```json
{
  "name": "The Green Balloon",
  "scene": "backyard",
  "characters": [
    { "id": "jane", "svg": "jane", "x": 0.27, "y": 0.98, "scale": 1.9, "voice": "say:Samantha" }
  ],
  "lines": [{ "speaker": "jane", "text": "Hello!" }]
}
```

- `scene`: bundled `backyard`, `living-room`, `park`, `street`, or a path to an `.svg`.
- `svg`: bundled `bill`, `jane`, `max`, `ted`, or a path to a rigged `.svg`, which needs `mouth-A` to `mouth-H` and `mouth-X` groups. `npm run rig` adds them to a new character.
- `x`, `y`: where the character's feet go, as a fraction of the 1920x1080 stage. `scale` 1 is 20% of the stage width.
- `voice`: `say:<macOS voice>`, `kokoro:<voice>[@speed]`, `edge:<voice>[@speed]` or `elevenlabs:<voice id>`; see [Voices](#voices). A line can override its speaker's voice with its own `voice`.

## Voices

- `say:<macOS voice>`: free, local. List them with `say -v '?'`.
- `kokoro:<voice>[@speed]`, e.g. `kokoro:af_heart` or `kokoro:am_fenrir@1.1`: free, local, and much more natural than `say`. Runs Kokoro-82M v1.0 on Apple Silicon through MLX (`mlx-community/Kokoro-82M-bf16`; set `KOKORO_MODEL` to use another build). `speed` is a rate multiplier from 0.5 to 2, default 1. When [tts-service](#tts-service) is running, Kokoro lines go to it. Otherwise all of an episode's Kokoro lines are voiced in one call to `agent/kokoro_tts.py`, a uv script that declares its own dependencies, so the model loads once. The first run builds a ~410 MB environment in uv's cache and downloads ~330 MB of weights and voices to the Hugging Face cache. After that, six lines take about 4 s.
- `edge:<voice>[@speed]`, e.g. `edge:en-US-AnaNeural` (a child voice tagged "Cartoon") or `edge:en-US-GuyNeural@1.1`: Microsoft Edge's online Read Aloud voices, free and with no key. Needs tts-service and an internet connection. The service is unofficial and can break or throttle, and its commercial-use status is unclear: for published, monetised content, use the same voices through Azure AI Speech.
- `elevenlabs:<voice id>`: paid, needs `ELEVENLABS_API_KEY` in `agent/.env`.

`say`, `kokoro` and `edge` voices go through Rhubarb for lip sync. Edge's word timings are also saved in each line's metadata.

### tts-service

A small local HTTP service that keeps Kokoro loaded and adds Edge voices. The renderer checks `GET /health` at `TTS_SERVICE_URL` (default `http://127.0.0.1:8787`) and, when it answers, sends all uncached `kokoro:` and `edge:` lines in one `POST /synthesize/batch` request. Each line comes back as a 24 kHz mono WAV, loudness-normalised to -16 LUFS so Kokoro (about 6 dB quieter as generated) matches Edge. If the service isn't running, `kokoro:` falls back to `agent/kokoro_tts.py` and `edge:` stops with a message asking you to start it. Lines cached with and without the service are cached separately, because the service normalises them.

`episodes/green-balloon-edge.json` gives Jane `edge:en-US-AnaNeural` and Max `kokoro:am_fenrir@1.1`.

English Kokoro voices, with the overall grades from the model's [VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md). Higher grades come from more and cleaner training audio.

| | Female | Male |
| --- | --- | --- |
| American | `af_heart` A, `af_bella` A-, `af_nicole` B- (whispery), `af_aoede` C+, `af_kore` C+, `af_sarah` C+, `af_alloy` C, `af_nova` C, `af_sky` C-, `af_jessica` D, `af_river` D | `am_fenrir` C+, `am_michael` C+, `am_puck` C+, `am_echo` D, `am_eric` D, `am_liam` D, `am_onyx` D, `am_santa` D-, `am_adam` F+ |
| British | `bf_emma` B-, `bf_isabella` C, `bf_alice` D, `bf_lily` D | `bm_fable` C, `bm_george` C, `bm_lewis` D+, `bm_daniel` D |

Kokoro has no child voices. `episodes/green-balloon-kokoro.json` uses `af_heart` for Jane (top grade, and the highest-pitched female voice) and `am_fenrir@1.1` for Max (the most animated male voice, with the widest pitch range). Kokoro is weakest on very short lines of a word or two. Its lines are about 6 dB quieter on average than `say` lines, so avoid mixing the two in one episode.

## Motion

Every episode gets these by default, with no extra fields:

- **Idle:** slow breathing and a slight sway, with a different rhythm for each character.
- **Blinks:** every 2.4 to 5.6 s, sometimes a double blink. The renderer finds each character's eyes and adds eyelids clipped to the eye whites. The eyelids take the colour of the face.
- **Talk:** the speaker bobs, squashes and tilts in time with how wide the mouth is open.
- **Gaze:** listeners look at the speaker. The speaker looks at whoever spoke last. Characters look where they are walking.

`"motion": { "idle": false, "blink": false, "talk": false, "gaze": false, "seed": 2 }` turns any of these off, and `seed` changes the blink and breathing timing. `"motion": false` turns the motion layer off completely, which gives the app's original output.

`episodes/green-balloon-motion.json` uses everything below.

```json
{
  "intro": 2,
  "characters": [
    { "id": "jane", "...": "...", "enter": "left" },
    { "id": "max", "...": "...", "enter": { "from": "right", "at": 0.4, "duration": 1.5 }, "faces": "front" }
  ],
  "props": [
    { "id": "balloon", "svg": "props/balloon-green.svg", "x": 0.6, "y": 0.2, "scale": 0.3, "rotate": -12, "float": 0.5 }
  ],
  "lines": [
    {
      "speaker": "jane", "text": "Can we get it down?",
      "camera": "push",
      "actions": [
        { "do": "shake", "at": 0.1 },
        { "do": "turn", "who": "max", "to": "jane", "at": "end-1" },
        { "do": "move", "who": "balloon", "to": { "x": 0.5, "y": 0.56, "rotate": 0 }, "at": "end-2.6", "duration": 3.2, "drift": 0.035 }
      ]
    }
  ]
}
```

**Characters**

- `enter`: `"left"` or `"right"`, or `{ "from", "at", "duration" }`. The character starts off-screen and walks to its `x` with a stepping bob. `at` is in seconds from the start of the episode, and the default is 0.
- `faces`: `"front"` (the default), `"left"` or `"right"`. This is the direction the art faces, and `turn` uses it to decide when to mirror the character. Side-facing characters also turn to face the way they walk.
- `intro`: seconds of silence before the first line. If you leave it out and characters enter at the start, it is long enough for them to finish walking on.

**Props**

- `svg`: a path to an `.svg` file, relative to the episode file, or inline `<svg>` markup. The prop is drawn as an image, so its styles can't leak into the characters.
- `x`, `y`: the centre of the prop, as a fraction of the stage. `scale` 1 is 20% of the stage width, as for characters, and the default is 0.3.
- `rotate` (degrees), `opacity` (0 to 1).
- `z`: a number, `"front"` or `"back"`. The default is `y × 1000`, which is how characters are layered (feet at `y` 0.98 means 980).
- `float`: `true`, or a number to scale it. The prop bobs and rocks gently.

**Line actions**

Each action is `{ "do": ..., "who": ..., "at": ... }`.

- `who` is a character or prop id. The default is the line's speaker.
- `at` is the time the action starts: seconds from the start of the line (negative values start before the line), or `"end"`, `"end-0.5"`, `"end+1"`. The default is 0.
- `duration` overrides the default length of any action.
- The video gets longer if actions run past the last line, for example exits.

| `do` | Who | Options |
| --- | --- | --- |
| `jump` | character | `height` (fraction of the character's height, default 0.3) |
| `hop` | character | `count` (default 2), `height` (default 0.08) |
| `nod`, `shake`, `spin` | character | `count` |
| `surprise` | character | `height`. A quick stretch upward that settles back. |
| `turn` | character | `to`: a character or prop id, `"left"` or `"right"`. With no `to`, the character flips. Mirrors the character with scaleX, and with an id it also looks at the target until the end of the line. |
| `look` | character | `to`: a character or prop id (followed as it moves), or `"left"`, `"right"`, `"up"`, `"down"`, `"front"`. Lasts until the end of the line unless you give a `duration`. |
| `walk` | character | `to`: an x position (0 to 1) or `{ "x", "y" }`. Also takes `ease`. |
| `enter` | character | `from`: `"left"` or `"right"`. The character starts off-screen. `to`: an x position, which defaults to the character's `x`. |
| `exit` | character | `to`: `"left"` or `"right"`. The default is the nearest edge. |
| `move` | prop | `to`: `{ "x", "y", "rotate", "scale", "opacity" }`, any subset. Also takes `ease` (any GSAP ease, default `sine.inOut`), `drift` (sideways sway as a fraction of the stage width) and `count` (number of sway cycles, default 1.5). |
| `show`, `hide` | prop | Fades the prop in or out. |

**Camera**

A line's `camera` field controls the camera for that line.

- `"push"` pushes in on the speaker for the line.
- `{ "push": "<character or prop id>", "zoom": 1.3, "at": -0.1, "duration": 0.8, "hold": false }` sets the target, zoom and timing.
- After the line, the camera eases back to the wide shot, unless the next line has its own `camera` or the push has `"hold": true`.
- `"wide"` returns to the wide shot.

The push is applied inside the stage, so it also works with `--portrait`.

**Determinism**

All motion is planned when the composition is built, using a PRNG seeded from the character id and `seed`. The plan is written to `scene.js` as `window.MOTION_PLAN`. One tween on the composition's GSAP timeline then calls a pure function of time for each frame. Any seek order, and any number of HyperFrames render workers, produces the same frames: two renders of `green-balloon-motion.json` hash identically frame by frame.

## Requirements

- `npm install` (the install scripts fetch chrome-headless-shell).
- Rhubarb Lip Sync 1.14.0 at `~/.local/opt/rhubarb-lip-sync-1.14.0/`, or set `RHUBARB_PATH`. Without it, only ElevenLabs voices work, using the app's word-timing heuristic.
- [uv](https://docs.astral.sh/uv/), for Kokoro voices. It needs an Apple Silicon Mac.
- tts-service, for Edge voices (optional for Kokoro). Set `TTS_SERVICE_URL` if it isn't on `http://127.0.0.1:8787`.

## How it works

`hooks.mjs` runs the app's main-process code under plain Node. It swaps in two stubs: `electron` (app paths only) and `src/main/settings` (API keys from environment variables). `src/main/composition.ts` uses Rhubarb cues from the line metadata when they are present. Motion is passed to `buildComposition()` as `BuildOptions.motion` and is built by `src/main/motion.ts`. The episode fields are defined in `agent/episode-motion.ts`, and the eye rig is `tagEyes()` in `src/main/svgRig.ts`. The desktop app doesn't pass `motion`, so its output is unchanged.
