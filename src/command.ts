import { Effect, Schema as S } from 'effect'
import { Command } from 'foldkit'

import { AudioEngine, assembleDownloadUrl, scheduleChunk, storeSamples, stopAllAudio } from './audioEngine'
import {
  CompletedAssembleDownload,
  CompletedStopAudio,
  FailedPreloadModel,
  FailedScheduleChunk,
  FailedSynthesizeChunk,
  PreloadedModel,
  SucceededScheduleChunk,
  SucceededSynthesizeChunk,
} from './message'
import { ModelKey } from './model'
import { requestFromWorker, SynthesisWorker } from './workerClient'

export const PreloadModel = Command.define(
  'PreloadModel',
  { model: ModelKey },
  PreloadedModel,
  FailedPreloadModel,
)(({ model }) =>
  Effect.gen(function* () {
    const worker = yield* SynthesisWorker.get
    yield* requestFromWorker(worker, { type: 'preload', modelKey: model.toLowerCase() })
    return PreloadedModel({ model })
  }).pipe(Effect.catch(error => Effect.succeed(FailedPreloadModel({ model, error: String(error) })))),
)

export const SynthesizeChunk = Command.define(
  'SynthesizeChunk',
  { runId: S.Number, index: S.Number, text: S.String, seed: S.Number, model: ModelKey },
  SucceededSynthesizeChunk,
  FailedSynthesizeChunk,
)(({ runId, index, text, seed, model }) =>
  Effect.gen(function* () {
    const worker = yield* SynthesisWorker.get
    const audioEngine = yield* AudioEngine.get
    const response = yield* requestFromWorker(worker, {
      type: 'synthesize',
      text,
      seed,
      modelKey: model.toLowerCase(),
    })
    if (response.type !== 'result') {
      return yield* Effect.fail(new Error('Unexpected worker response for synthesize request'))
    }
    storeSamples(audioEngine, index, response.samples)
    const durationSec = response.samples.length / response.sampleRate
    return SucceededSynthesizeChunk({
      runId,
      index,
      synthMs: response.synthMs,
      durationSec,
      normalizedText: response.normalizedText,
      phonemeText: response.phonemeText,
    })
  }).pipe(
    Effect.catch(error => Effect.succeed(FailedSynthesizeChunk({ runId, index, error: String(error) }))),
  ),
)

export const ScheduleChunk = Command.define(
  'ScheduleChunk',
  { playbackId: S.Number, index: S.Number, pauseSec: S.Number, nextStartTimeSec: S.Number },
  SucceededScheduleChunk,
  FailedScheduleChunk,
)(({ playbackId, index, pauseSec, nextStartTimeSec }) =>
  Effect.gen(function* () {
    const audioEngine = yield* AudioEngine.get
    const result = scheduleChunk(audioEngine, index, pauseSec, nextStartTimeSec)
    return SucceededScheduleChunk({
      playbackId,
      index,
      playAtSec: result.playAtSec,
      endsAtSec: result.endsAtSec,
    })
  }).pipe(
    Effect.catch(error => Effect.succeed(FailedScheduleChunk({ playbackId, index, error: String(error) }))),
  ),
)

export const StopAudio = Command.define(
  'StopAudio',
  CompletedStopAudio,
)(
  Effect.gen(function* () {
    const audioEngine = yield* AudioEngine.get
    stopAllAudio(audioEngine)
    return CompletedStopAudio()
  }).pipe(Effect.catch(() => Effect.succeed(CompletedStopAudio()))),
)

export const AssembleDownload = Command.define(
  'AssembleDownload',
  { order: S.Array(S.Number), pausesSec: S.Array(S.Number) },
  CompletedAssembleDownload,
)(({ order, pausesSec }) =>
  Effect.gen(function* () {
    const audioEngine = yield* AudioEngine.get
    const pauseSecByIndex = new Map(order.map((index, i) => [index, pausesSec[i] ?? 0]))
    const url = assembleDownloadUrl(audioEngine, order, pauseSecByIndex)
    return CompletedAssembleDownload({ url })
  }).pipe(Effect.catch(() => Effect.succeed(CompletedAssembleDownload({ url: '' })))),
)
