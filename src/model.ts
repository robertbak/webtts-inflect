import { Schema as S } from 'effect'
import { ts } from 'foldkit/schema'

export const ModelKey = S.Literals(['Nano', 'Micro'])
export type ModelKey = typeof ModelKey.Type

// PRELOAD STATUS

export const PreloadNotStarted = ts('PreloadNotStarted')
export const PreloadInProgress = ts('PreloadInProgress', {
  progress: S.Number,
  phase: S.Literals(['downloading', 'compiling']),
})
export const PreloadReady = ts('PreloadReady')
export const PreloadFailed = ts('PreloadFailed', { error: S.String })

export const PreloadStatus = S.Union([
  PreloadNotStarted,
  PreloadInProgress,
  PreloadReady,
  PreloadFailed,
])
export type PreloadStatus = typeof PreloadStatus.Type

export const WordSpan = S.Struct({
  word: S.String,
  startSec: S.Number,
  endSec: S.Number,
})
export type WordSpan = typeof WordSpan.Type

// SYNTHESIS -- turning text into audio samples. Knows nothing about
// playback: a chunk is either not started, in flight, ready (with audio
// samples stashed in the AudioEngine resource, keyed by index), or
// failed. Persists after finishing (doesn't collapse back to idle) so a
// later Replay can reuse it without resynthesizing.

export const SynthChunkPending = ts('SynthChunkPending')
export const SynthChunkDispatched = ts('SynthChunkDispatched')
export const SynthChunkReady = ts('SynthChunkReady', {
  normalizedText: S.String,
  phonemeText: S.String,
  synthMs: S.Number,
  durationSec: S.Number,
})
export const SynthChunkFailed = ts('SynthChunkFailed', { error: S.String })

export const SynthChunkState = S.Union([
  SynthChunkPending,
  SynthChunkDispatched,
  SynthChunkReady,
  SynthChunkFailed,
])
export type SynthChunkState = typeof SynthChunkState.Type

export const SynthesisIdle = ts('SynthesisIdle')
export const SynthesisActive = ts('SynthesisActive', {
  runId: S.Number,
  model: ModelKey,
  chunkTexts: S.Array(S.String),
  estimatedDurationsSec: S.Array(S.Number),
  chunkStates: S.Array(SynthChunkState),
  dispatchedCount: S.Number,
  // Generate mode: dispatch every chunk immediately instead of throttling
  // to MAX_DISPATCH_AHEAD. There's no concurrent playback to pace against
  // (Generate doesn't start playback until everything's resolved), so
  // there's nothing to gain by holding chunks back.
  dispatchAll: S.Boolean,
})

export const SynthesisState = S.Union([SynthesisIdle, SynthesisActive])
export type SynthesisState = typeof SynthesisState.Type

// PLAYBACK -- scheduling and highlighting already-synthesized audio. Reads
// synthesis's per-chunk readiness as input data; owns nothing about how
// that audio was produced. A fresh PlaybackActive can start against
// synthesis data that's mid-flight (streaming, chunks arrive over time) or
// fully resolved already (Replay, effectively instant since every chunk is
// already ChunkReady).

export const PlaybackChunkWaiting = ts('PlaybackChunkWaiting')
export const PlaybackChunkScheduled = ts('PlaybackChunkScheduled', {
  playAtSec: S.Number,
  durationSec: S.Number,
  wordSpans: S.Array(WordSpan),
})
export const PlaybackChunkSkipped = ts('PlaybackChunkSkipped', { error: S.String })

export const PlaybackChunkState = S.Union([
  PlaybackChunkWaiting,
  PlaybackChunkScheduled,
  PlaybackChunkSkipped,
])
export type PlaybackChunkState = typeof PlaybackChunkState.Type

export const PlaybackIdle = ts('PlaybackIdle')
export const PlaybackActive = ts('PlaybackActive', {
  playbackId: S.Number,
  chunkTexts: S.Array(S.String),
  chunkStates: S.Array(PlaybackChunkState),
  nextToSchedule: S.Number,
  nextStartTimeSec: S.Number,
})
export const PlaybackFinished = ts('PlaybackFinished', {
  chunkTexts: S.Array(S.String),
  chunkStates: S.Array(PlaybackChunkState),
  finishesAtSec: S.Number,
})

export const PlaybackState = S.Union([PlaybackIdle, PlaybackActive, PlaybackFinished])
export type PlaybackState = typeof PlaybackState.Type

// MODEL

export const Model = S.Struct({
  selectedModel: ModelKey,
  nanoPreload: PreloadStatus,
  microPreload: PreloadStatus,
  textInput: S.String,
  synthesis: SynthesisState,
  playback: PlaybackState,
  activityLog: S.Array(S.String),
  detailLog: S.Array(S.String),
  maybeDownloadUrl: S.Option(S.String),
  nextRunId: S.Number,
  currentPlaybackTimeSec: S.Number,
  // Set by Generate: once the in-flight synthesis fully resolves, start
  // playback automatically instead of requiring a manual Replay click.
  pendingAutoPlay: S.Boolean,
  // Activity/details logs are folded by default -- most people don't care
  // about per-chunk synth timing, just the transcript and audio.
  logsExpanded: S.Boolean,
})
export type Model = typeof Model.Type

export const MAX_DISPATCH_AHEAD = 6
export const RTF_SAFETY_MARGIN = 1.1
export const CHUNK_CHAR_LIMIT = 280
