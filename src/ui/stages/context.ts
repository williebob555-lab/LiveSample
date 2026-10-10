// ============================================================================
// StageContext — what a stage module may use from the Studio.
//
// The shared panels are owned by Studio (one instance each, re-parented into
// whichever stage is showing), so stages get them through this narrow
// interface rather than reaching into Studio itself.
// ============================================================================

import type { Stage } from '../app';
import type { ZoneMap } from '../zonemap';
import type { Keyboard } from '../keyboard';
import type { WaveformView } from '../waveform';
import type { EnvelopeView, FilterView } from '../curves';
import type { CoverageStrip } from '../coverage';

export interface StageContext {
  readonly zoneMap: ZoneMap;
  readonly keyboard: Keyboard;
  readonly waveform: WaveformView;
  readonly coverage: CoverageStrip;
  readonly envelopeView: EnvelopeView;
  readonly filterView: FilterView;
  setStage(stage: Stage): void;
}
