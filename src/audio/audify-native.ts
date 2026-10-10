// ============================================================================
// Loads audify's native binary directly.
//
// audify's own index.js goes through the `bindings` package, which searches for
// audify.node relative to the *application* root rather than the package. Under
// Electron that means it looks in `<app>/build/Release/audify.node`, never
// finds it, and throws — the module works under plain node only because the cwd
// happens to line up.
//
// Resolving the .node path from audify's package.json instead makes it work in
// the main process, in a utilityProcess, and in a packaged app. The enum values
// are inlined because audify declares them as non-exported ambient consts.
// ============================================================================

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { RtAudio as RtAudioClass } from 'audify';

// Resolved at runtime relative to this bundle, not to the process cwd.
const req = createRequire(__filename);

interface AudifyNative {
  RtAudio: new (api?: number) => RtAudioClass;
}

let cached: AudifyNative | null = null;

/**
 * Load on first use, not at import time. A throw during module evaluation kills
 * the host process outright, with no chance to report *why* the driver is
 * unavailable — which is the one thing the user needs to know.
 */
export function loadAudify(): AudifyNative {
  if (cached) return cached;
  cached = load();
  return cached;
}

function load(): AudifyNative {
  const errors: string[] = [];

  // Preferred: the binary next to audify's package.json.
  try {
    const pkg = req.resolve('audify/package.json');
    const candidates = [
      join(dirname(pkg), 'build', 'Release', 'audify.node'),
      join(dirname(pkg), 'build', 'Debug', 'audify.node'),
    ];
    for (const candidate of candidates) {
      try {
        return req(candidate) as AudifyNative;
      } catch (e) {
        errors.push(`${candidate}: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    errors.push(`resolve audify/package.json: ${(e as Error).message}`);
  }

  // Fall back to the package's own loader, which works under plain node.
  try {
    return req('audify') as AudifyNative;
  } catch (e) {
    errors.push(`require('audify'): ${(e as Error).message}`);
  }

  throw new Error(`Could not load audify native binary.\n${errors.join('\n')}`);
}

/** Runtime values verified against audify 1.10.1. */
export const RtAudioFormat = {
  SINT8: 0x1,
  SINT16: 0x2,
  SINT24: 0x4,
  SINT32: 0x8,
  FLOAT32: 0x10,
  FLOAT64: 0x20,
} as const;

export const RtAudioStreamFlags = {
  NONINTERLEAVED: 0x1,
  MINIMIZE_LATENCY: 0x2,
  HOG_DEVICE: 0x4,
  SCHEDULE_REALTIME: 0x8,
} as const;
