import { Schema as S } from 'effect'
import { m } from 'foldkit/message'

export const ClickedSynthesize = m('ClickedSynthesize')
export const ClickedGenerate = m('ClickedGenerate')
export const ClickedReplay = m('ClickedReplay')
export const ClickedStop = m('ClickedStop')
export const ClickedToggleLogs = m('ClickedToggleLogs')
export const SelectedModel = m('SelectedModel', { model: S.Literals(['Nano', 'Micro']) })
export const UpdatedTextInput = m('UpdatedTextInput', { value: S.String })

export const PreloadedModel = m('PreloadedModel', { model: S.Literals(['Nano', 'Micro']) })
export const FailedPreloadModel = m('FailedPreloadModel', {
  model: S.Literals(['Nano', 'Micro']),
  error: S.String,
})
export const ReceivedDownloadProgress = m('ReceivedDownloadProgress', {
  model: S.Literals(['Nano', 'Micro']),
  fraction: S.Number,
  phase: S.Literals(['downloading', 'compiling']),
})

export const SucceededSynthesizeChunk = m('SucceededSynthesizeChunk', {
  runId: S.Number,
  index: S.Number,
  synthMs: S.Number,
  durationSec: S.Number,
  normalizedText: S.String,
  phonemeText: S.String,
})
export const FailedSynthesizeChunk = m('FailedSynthesizeChunk', {
  runId: S.Number,
  index: S.Number,
  error: S.String,
})

export const SucceededScheduleChunk = m('SucceededScheduleChunk', {
  playbackId: S.Number,
  index: S.Number,
  playAtSec: S.Number,
  endsAtSec: S.Number,
})
export const FailedScheduleChunk = m('FailedScheduleChunk', {
  playbackId: S.Number,
  index: S.Number,
  error: S.String,
})

export const CompletedStopAudio = m('CompletedStopAudio')
export const CompletedAssembleDownload = m('CompletedAssembleDownload', { url: S.String })

export const AcquiredSynthesisWorker = m('AcquiredSynthesisWorker')
export const ReleasedSynthesisWorker = m('ReleasedSynthesisWorker')
export const FailedAcquireSynthesisWorker = m('FailedAcquireSynthesisWorker', { error: S.String })
export const AcquiredAudioEngine = m('AcquiredAudioEngine')
export const ReleasedAudioEngine = m('ReleasedAudioEngine')
export const FailedAcquireAudioEngine = m('FailedAcquireAudioEngine', { error: S.String })

export const TickedPlayback = m('TickedPlayback', { currentTimeSec: S.Number })

export const Message = S.Union([
  ClickedSynthesize,
  ClickedGenerate,
  ClickedReplay,
  ClickedStop,
  ClickedToggleLogs,
  SelectedModel,
  UpdatedTextInput,
  PreloadedModel,
  FailedPreloadModel,
  ReceivedDownloadProgress,
  SucceededSynthesizeChunk,
  FailedSynthesizeChunk,
  SucceededScheduleChunk,
  FailedScheduleChunk,
  CompletedStopAudio,
  CompletedAssembleDownload,
  AcquiredSynthesisWorker,
  ReleasedSynthesisWorker,
  FailedAcquireSynthesisWorker,
  AcquiredAudioEngine,
  ReleasedAudioEngine,
  FailedAcquireAudioEngine,
  TickedPlayback,
])
export type Message = typeof Message.Type
