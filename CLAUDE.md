# Cartoon Studio, headless

This checkout adds a headless pipeline to Jellypod's Cartoon Studio, so an agent can make cartoon episodes from a shell. The desktop app is unchanged.

- How to render an episode, and the episode format: [agent/README.md](agent/README.md)
- How the pipeline fits together: [docs/pipeline.md](docs/pipeline.md)
- Lessons learned: [docs/lessons.md](docs/lessons.md). Read it before changing the renderer, and add to it when something takes a while to figure out.

Render command, from the repo root:

```
node --no-warnings --env-file-if-exists=agent/.env --import ./agent/hooks.mjs agent/render-episode.ts <episode.json>
```

After a render, grab a few frames with ffmpeg and look at them before calling it done.
