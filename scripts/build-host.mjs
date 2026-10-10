// Bundles the audio host process to dist-host/host.cjs.
//
// It is TypeScript so it can share the model, the selection logic and the WAV
// decoder with the renderer — two copies of voice selection would drift, and a
// drifting audition is worse than none. `audify` stays external because it is a
// native module resolved at runtime.

import { build } from 'esbuild';

await build({
  entryPoints: ['src/audio/host.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist-host/host.cjs',
  external: ['audify'],
  logLevel: 'info',
  sourcemap: false,
});
