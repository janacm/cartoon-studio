# Lessons learned

Things we found out the hard way while building the headless pipeline. Add an entry when something costs more than a few minutes to figure out: what happened, why, and what to do instead. Newest first within each section.

## Rendering

- **HyperFrames can fail with "Navigation timeout of 60000 ms exceeded" in every worker even when nothing is wrong with the episode.** It happened three times in a row right after the repo was moved to a new folder, then never again with the same files. Chrome loaded the page fine on its own, and the WAV headers checked out. If it happens, retry before debugging, and try `--workers 1` on the HyperFrames CLI to confirm.
- **Everything that moves has to be on the one GSAP timeline, driven by seeded values.** HyperFrames renders by seeking that timeline frame by frame in parallel workers. `requestAnimationFrame`, CSS animations, `Date.now` and `Math.random` give different results per worker. Two renders of an episode should produce identical frames; check that after any motion change.
- **Keep `requestAnimationFrame` and `performance.now` out of inline scripts in the composition.** HyperFrames scans inline scripts for them and switches to screenshot capture, which breaks the timeline seek and the lip sync. The preview player lives in an external `player.js` for this reason.
- **Run the HyperFrames CLI with plain `node`, not with Electron as Node.** The desktop app spawns its own Electron binary, which sits inside an `.app` bundle. Executing that directly is unreliable outside the app.
- **Scale 1 makes a character 20% of the stage width**, which looks small and far away. About 1.8 to 1.9 works for a two-character shot with feet at `y` 0.98.

## Characters and art

- **The bundled characters are drawn as a black silhouette under the colour fills.** Squashing an eye to blink shows black. Blinks use face-coloured eyelids clipped to the eye whites instead. Expect other art styles to need their own approach.
- **Rigging finds the face by looking for two roughly circular eyes with a mouth below them.** Art without clear, separate eye shapes needs manual mouth placement.
- **Flatten downloaded SVGs before rigging, and check the result by eye.** `agent/tools/flatten_svg.py` converts any SVG into the absolute-path, fill-attribute layout the rig needs. `npm run rig` alone wraps the art in a transform the rig can't see. Of ten OpenClipart kids, five "rigged", but only one had the mouth in the right place. The others landed on shoes, fists, an ear and trouser flies. `agent/tools/rig-check.ts` with `MOUTH_BBOX=x,y,w,h` places the mouth by hand.
- **Delete the original drawn mouth after rigging.** Otherwise the old smile stays under the animated mouth and the character has two mouths. Also remove logos and trademarks from downloaded art.
- **Free assets that passed the licence check (October 2026):** OpenClipart (CC0), Kenney (CC0; Toon Characters has cut-out body parts, but as PNG), DiceBear (CC0 heads; eyes and mouth are one path, so they don't rig), and LottieFiles under the Lottie Simple License. Freepik's free tier and Avataaars are not CC0.

## Voices and lip sync

- **Kokoro-82M v1.0 is still the newest English Kokoro (checked October 2026), and the MLX `bf16` build is the one to use.** The quantised builds are barely smaller and the `kokoro_mlx` library can't load them. v1.1-zh is a Chinese model.
- **Kokoro has no child voices.** `af_heart` is the best-graded voice. Pitch-shifting to sound younger needs ffmpeg's `rubberband` filter, which Homebrew's ffmpeg lacks; simple resampling sounds like a chipmunk.
- **Kokoro output is about 6 dB quieter than macOS `say`.** Don't mix the two in one episode, and normalise loudness before publishing.
- **Rhubarb 1.14.0 ships only an Intel macOS build**; it runs under Rosetta at 4 to 7 s per line. Always pass the line text as the dialog file, which improves accuracy.
- **Voiced lines are cached by voice and text.** Staging changes only re-run the composition and the render, so iterate on positions and actions freely.

## Environment

- **The agent can't run `npm install`, `npm ci` or `npx … install`;** the user's Claude Code settings deny them. Ask the user to run installs.
- **Model weights go to the Hugging Face cache.** If that cache lives on a removable drive, the Kokoro model downloads again whenever the drive is missing.
- **HyperFrames telemetry is off** (`hyperframes telemetry disable`, or `HYPERFRAMES_NO_TELEMETRY=1`). Re-check it after reinstalling.

## Research and sources

- **GitHub star counts in search-engine metadata were badly wrong: one repo showed 11 stars in search and had 710.** Take them from the repo page or the GitHub API.
- **A GitHub fork of a public repo can't be made private.** For a private copy, create a new private repo and keep the original as an `upstream` remote.
