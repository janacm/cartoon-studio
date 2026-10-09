// Headless stand-in for the parts of Electron's `app` that the composition
// and show-store code use. Shows are written under CARTOON_WORKDIR
// (default: <repo>/.agent-work) instead of the desktop app's userData dir.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = process.env.CARTOON_WORKDIR ?? path.join(repoRoot, '.agent-work');

export const app = {
  isPackaged: false,
  getAppPath: () => repoRoot,
  getPath: (name) => {
    if (name === 'userData') return workDir;
    throw new Error(`electron stub: app.getPath('${name}') is not supported headless`);
  },
};
