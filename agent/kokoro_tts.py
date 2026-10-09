#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "kokoro-mlx==0.1.2",
#   "soundfile>=0.13.1",
#   # misaki's English G2P loads this spaCy model; it would otherwise try to
#   # pip-install it at runtime, which fails inside a uv environment.
#   "en-core-web-sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl",
# ]
#
# [tool.uv]
# exclude-newer = "2026-10-08T00:00:00Z"
# # misaki[en] pulls spacy-curated-transformers (and with it PyTorch) only for
# # the en_core_web_trf model. kokoro-mlx uses en_core_web_sm, so skip it.
# override-dependencies = ["spacy-curated-transformers; sys_platform == 'never'"]
# ///
"""Voice many lines with Kokoro-82M on Apple Silicon (MLX), loading the model once.

    uv run --script agent/kokoro_tts.py jobs.json      # or "-" to read stdin
    uv run --script agent/kokoro_tts.py --list-voices

jobs.json is a list of {"text": str, "voice": str, "speed": float, "out": path}.
Each job becomes a 24 kHz mono 16-bit WAV at "out". A JSON summary goes to
stdout; progress goes to stderr.

The model defaults to mlx-community/Kokoro-82M-bf16 (Kokoro v1.0 weights);
override it with --model or KOKORO_MODEL (a Hugging Face repo id or a local
directory). The first run downloads about 330 MB into the Hugging Face cache.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

DEFAULT_MODEL = "mlx-community/Kokoro-82M-bf16"
SAMPLE_RATE = 24000


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def load_jobs(src: str) -> list[dict]:
    raw = sys.stdin.read() if src == "-" else Path(src).read_text(encoding="utf-8")
    jobs = json.loads(raw)
    if not isinstance(jobs, list):
        raise ValueError("jobs must be a JSON list")
    for i, job in enumerate(jobs):
        if not isinstance(job, dict):
            raise ValueError(f"job {i}: expected an object")
        if not isinstance(job.get("text"), str) or not job["text"].strip():
            raise ValueError(f"job {i}: 'text' must be a non-empty string")
        if not isinstance(job.get("voice"), str) or not job["voice"]:
            raise ValueError(f"job {i}: 'voice' must be a string")
        if not isinstance(job.get("out"), str) or not job["out"]:
            raise ValueError(f"job {i}: 'out' must be a path")
        speed = job.get("speed", 1.0)
        if not isinstance(speed, (int, float)) or not 0.5 <= speed <= 2.0:
            raise ValueError(f"job {i}: 'speed' must be a number from 0.5 to 2.0")
        job["speed"] = float(speed)
    return jobs


def main() -> int:
    parser = argparse.ArgumentParser(description="Batch Kokoro TTS to WAV files.")
    parser.add_argument("jobs", nargs="?", help='JSON file of jobs, or "-" for stdin')
    parser.add_argument("--model", default=os.environ.get("KOKORO_MODEL", DEFAULT_MODEL))
    parser.add_argument("--list-voices", action="store_true")
    args = parser.parse_args()
    if not args.list_voices and not args.jobs:
        parser.error("pass a jobs file, '-', or --list-voices")

    jobs = [] if args.list_voices else load_jobs(args.jobs)

    import soundfile as sf
    from kokoro_mlx import KokoroTTS

    t0 = time.perf_counter()
    log(f"kokoro: loading {args.model}")
    with KokoroTTS.from_pretrained(args.model) as tts:
        load_s = time.perf_counter() - t0
        # Skip macOS "._" metadata files, which appear when the Hugging Face
        # cache lives on a non-APFS (e.g. exFAT) drive.
        voices = {v for v in tts.list_voices() if not v.startswith(".")}
        if args.list_voices:
            print("\n".join(sorted(voices)))
            return 0

        unknown = sorted({j["voice"] for j in jobs} - voices)
        if unknown:
            log(f"kokoro: unknown voice(s): {', '.join(unknown)}")
            log(f"kokoro: available: {', '.join(sorted(voices))}")
            return 2

        results = []
        for i, job in enumerate(jobs, 1):
            t = time.perf_counter()
            r = tts.generate(job["text"], voice=job["voice"], speed=job["speed"], sample_rate=SAMPLE_RATE)
            out = Path(job["out"])
            out.parent.mkdir(parents=True, exist_ok=True)
            # Write to a temp name first so an interrupted run never leaves a
            # truncated WAV that looks finished.
            tmp = out.with_name(out.name + ".part")
            sf.write(str(tmp), r.audio, SAMPLE_RATE, subtype="PCM_16", format="WAV")
            os.replace(tmp, out)
            secs = time.perf_counter() - t
            log(f"kokoro: [{i}/{len(jobs)}] {job['voice']}@{job['speed']:g} {r.duration:.2f}s audio in {secs:.2f}s -> {out.name}")
            results.append({"out": str(out), "durationS": round(r.duration, 3), "seconds": round(secs, 3)})

    print(json.dumps({
        "model": args.model,
        "loadSeconds": round(load_s, 3),
        "totalSeconds": round(time.perf_counter() - t0, 3),
        "lines": results,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
