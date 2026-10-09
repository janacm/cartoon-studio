// Module hooks that let Cartoon Studio's main-process code run under plain
// Node (with built-in TypeScript type stripping) instead of Electron:
//   - `electron` resolves to a small stub that only provides app paths.
//   - `./settings` from src/main resolves to a stub that reads API keys from
//     environment variables instead of the OS keychain.
//   - Extensionless relative imports (`./tts`) resolve to their .ts file, as
//     Vite does for the app build.
//
// Usage: node --import ./agent/hooks.mjs agent/render-episode.ts ...

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const stub = (name) => pathToFileURL(path.join(here, 'stubs', name)).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { url: stub('electron.mjs'), shortCircuit: true };
    }
    const parent = context.parentURL ?? '';
    if (specifier === './settings' && parent.includes('/src/main/')) {
      return { url: stub('settings.mjs'), shortCircuit: true };
    }
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (relative && parent.startsWith('file:') && !path.extname(specifier)) {
      const base = fileURLToPath(new URL(specifier, parent));
      for (const ext of ['.ts', '.mts', '.js', '.mjs']) {
        if (existsSync(base + ext)) {
          return { url: pathToFileURL(base + ext).href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
