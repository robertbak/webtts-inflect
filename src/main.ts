import { Effect, Match as M, Option, Schema as S, Stream } from 'effect'
import { Command, ManagedResource, Runtime, Subscription } from 'foldkit'
import { evo } from 'foldkit/struct'

import {
  AudioEngine,
  acquireAudioEngine,
  releaseAudioEngine,
  type AudioEngineService,
} from './audioEngine'
import {
  AssembleDownload,
  PreloadModel,
  ScheduleChunk,
  StopAudio,
  SynthesizeChunk,
} from './command'
import {
  AcquiredAudioEngine,
  AcquiredSynthesisWorker,
  FailedAcquireAudioEngine,
  FailedAcquireSynthesisWorker,
  Message,
  ReceivedDownloadProgress,
  ReleasedAudioEngine,
  ReleasedSynthesisWorker,
} from './message'
import {
  CHUNK_CHAR_LIMIT,
  MAX_DISPATCH_AHEAD,
  Model,
  PlaybackActive,
  PlaybackChunkScheduled,
  PlaybackChunkSkipped,
  PlaybackChunkWaiting,
  PlaybackFinished,
  PlaybackIdle,
  type PlaybackState,
  PreloadFailed,
  PreloadInProgress,
  PreloadNotStarted,
  PreloadReady,
  RTF_SAFETY_MARGIN,
  SynthChunkDispatched,
  SynthChunkFailed,
  SynthChunkPending,
  SynthChunkReady,
  type SynthChunkState,
  SynthesisActive,
  SynthesisIdle,
  type SynthesisState,
} from './model'
import {
  boundaryPauseSeconds,
  computeDisplayWordFractions,
  estimateDurationSec,
  normalizeText,
  splitText,
} from './normalize'
import { streamPlaybackTicks } from './playbackClock'
import {
  acquireSynthesisWorker,
  releaseSynthesisWorker,
  streamWorkerProgress,
  SynthesisWorker,
  type SynthesisWorkerService,
} from './workerClient'

export { Message, Model }
export { view } from './view'

type AppRequirements = SynthesisWorkerService | AudioEngineService
type AppCommand = Command.Command<Message, never, AppRequirements>
type UpdateReturn = readonly [Model, ReadonlyArray<AppCommand>]
const withUpdateReturn = M.withReturnType<UpdateReturn>()

const DEFAULT_TEXT =
  'Hello there, this is a browser test. Dr. Smith paid $42.50 at 3:15pm on 6/24/2026 for order A2093. This version chunks longer text into sentence-sized pieces and streams playback, predicting each chunk\'s synthesis speed from the one before it.'

const MAX_LOG_LINES = 200

const appendLog = (log: ReadonlyArray<string>, line: string): ReadonlyArray<string> =>
  [...log, line].slice(-MAX_LOG_LINES)

// SYNTHESIS ADVANCE

/**
 * Slides synthesis's own dispatch window forward: keeps at most
 * MAX_DISPATCH_AHEAD chunks in flight (dispatched but not yet
 * Ready/Failed) at a time, independent of whatever playback is doing with
 * the results.
 */
const tryAdvanceSynthesis = (synthesis: typeof SynthesisActive.Type): readonly [SynthesisState, ReadonlyArray<AppCommand>] => {
  const commands: Array<AppCommand> = []
  let current = synthesis

  const resolvedCount = current.chunkStates.filter(
    state => state._tag === 'SynthChunkReady' || state._tag === 'SynthChunkFailed',
  ).length
  const dispatchTarget = current.dispatchAll
    ? current.chunkTexts.length
    : Math.min(current.chunkTexts.length, resolvedCount + MAX_DISPATCH_AHEAD)

  while (current.dispatchedCount < dispatchTarget) {
    const index = current.dispatchedCount
    const text = current.chunkTexts[index]
    if (text === undefined) {
      break
    }
    commands.push(SynthesizeChunk({ runId: current.runId, index, text, seed: 7 + index, model: current.model }))
    current = evo(current, {
      dispatchedCount: n => n + 1,
      chunkStates: states => states.map((state, i) => (i === index ? SynthChunkDispatched() : state)),
    })
  }

  return [current, commands]
}

// PLAYBACK ADVANCE

/**
 * Schedules (or skips, on failure) chunks for playback in order, reading
 * synthesis's per-chunk readiness as input. Uses each chunk's own
 * just-measured synthesis speed to predict whether the next chunk will be
 * ready in time -- only waiting for it when there's a real risk of an
 * audible gap, one chunk at a time. Knows nothing about how the audio was
 * produced: this same logic drives both streaming (synthesis still in
 * flight) and Replay (synthesis already fully resolved, so every chunk is
 * immediately schedulable).
 */
const tryAdvancePlayback = (
  playback: typeof PlaybackActive.Type,
  synthesisChunkStates: ReadonlyArray<SynthChunkState>,
  estimatedDurationsSec: ReadonlyArray<number>,
): readonly [PlaybackState, ReadonlyArray<AppCommand>] => {
  const commands: Array<AppCommand> = []
  let current = playback

  let stillAdvancing = true
  while (stillAdvancing && current.nextToSchedule < current.chunkTexts.length) {
    const index = current.nextToSchedule
    const synthState = synthesisChunkStates[index]

    if (synthState?._tag === 'SynthChunkFailed') {
      const { error } = synthState
      current = evo(current, {
        nextToSchedule: n => n + 1,
        chunkStates: states => states.map((state, i) => (i === index ? PlaybackChunkSkipped({ error }) : state)),
      })
      continue
    }

    if (synthState?._tag !== 'SynthChunkReady') {
      stillAdvancing = false
      continue
    }

    const isLast = index === current.chunkTexts.length - 1
    const nextSynthState = isLast ? undefined : synthesisChunkStates[index + 1]
    const nextIsSettled = isLast || nextSynthState?._tag === 'SynthChunkReady' || nextSynthState?._tag === 'SynthChunkFailed'

    let safeToScheduleNow = nextIsSettled
    if (!safeToScheduleNow && nextSynthState) {
      const rtf = synthState.durationSec / Math.max(synthState.synthMs / 1000, 0.001)
      const estimatedNextSec = estimatedDurationsSec[index + 1] ?? 0
      const predictedSynthSec = estimatedNextSec / Math.max(rtf, 0.01)
      const chunkText = current.chunkTexts[index] ?? ''
      const slackSec = synthState.durationSec + boundaryPauseSeconds(chunkText)
      safeToScheduleNow = predictedSynthSec * RTF_SAFETY_MARGIN <= slackSec
    }

    if (!safeToScheduleNow) {
      stillAdvancing = false
      continue
    }

    const chunkText = current.chunkTexts[index] ?? ''
    const pauseSec = isLast ? 0 : boundaryPauseSeconds(chunkText)
    commands.push(
      ScheduleChunk({ playbackId: current.playbackId, index, pauseSec, nextStartTimeSec: current.nextStartTimeSec }),
    )
    current = evo(current, { nextToSchedule: n => n + 1 })
    stillAdvancing = false
  }

  // "Done" means every chunk has actually *settled* (its ScheduleChunk
  // result came back), not just that we've issued commands for all of
  // them -- nextToSchedule advances the instant a command is dispatched,
  // before its result arrives. Using nextToSchedule alone here declared
  // PlaybackFinished right after sending the last chunk's ScheduleChunk,
  // so when that chunk's real SucceededScheduleChunk showed up afterward,
  // withPlaybackActive no longer matched (state had already moved to
  // PlaybackFinished) and silently dropped it -- that chunk's word spans
  // never got attached, so it rendered with no highlighting at all.
  const allSettled = current.chunkStates.every(
    state => state._tag === 'PlaybackChunkScheduled' || state._tag === 'PlaybackChunkSkipped',
  )
  if (allSettled) {
    const order = current.chunkTexts.map((_, i) => i)
    const pausesSec = current.chunkTexts.map((text, i) =>
      i === current.chunkTexts.length - 1 ? 0 : boundaryPauseSeconds(text),
    )
    commands.push(AssembleDownload({ order, pausesSec }))
    return [
      PlaybackFinished({
        chunkTexts: current.chunkTexts,
        chunkStates: current.chunkStates,
        finishesAtSec: current.nextStartTimeSec,
      }),
      commands,
    ]
  }

  return [current, commands]
}

const withSynthesisActive = (
  model: Model,
  runId: number,
  toReturn: (synthesis: typeof SynthesisActive.Type) => UpdateReturn,
): UpdateReturn =>
  M.value(model.synthesis).pipe(
    withUpdateReturn,
    M.tag('SynthesisActive', synthesis => (synthesis.runId === runId ? toReturn(synthesis) : [model, []])),
    M.orElse(() => [model, []]),
  )

const withPlaybackActive = (
  model: Model,
  playbackId: number,
  toReturn: (playback: typeof PlaybackActive.Type) => UpdateReturn,
): UpdateReturn =>
  M.value(model.playback).pipe(
    withUpdateReturn,
    M.tag('PlaybackActive', playback => (playback.playbackId === playbackId ? toReturn(playback) : [model, []])),
    M.orElse(() => [model, []]),
  )

const appendActivityLog = (model: Model, line: string): Model =>
  evo(model, { activityLog: log => appendLog(log, line) })

const startPlayback = (chunkTexts: ReadonlyArray<string>, playbackId: number): typeof PlaybackActive.Type =>
  PlaybackActive({
    playbackId,
    chunkTexts,
    chunkStates: chunkTexts.map(() => PlaybackChunkWaiting()),
    nextToSchedule: 0,
    nextStartTimeSec: 0,
  })

const isSynthesisFullyResolved = (synthesis: typeof SynthesisActive.Type): boolean =>
  synthesis.dispatchedCount === synthesis.chunkTexts.length &&
  synthesis.chunkStates.every(state => state._tag === 'SynthChunkReady' || state._tag === 'SynthChunkFailed')

/**
 * Generate sets pendingAutoPlay and leaves playback Idle, since it
 * shouldn't start until the whole thing is done. Called after every
 * synthesis advance to check whether that point has now been reached.
 */
const maybeAutoStartPlayback = (model: Model, nextRunId: number): UpdateReturn => {
  if (
    !model.pendingAutoPlay ||
    model.playback._tag !== 'PlaybackIdle' ||
    model.synthesis._tag !== 'SynthesisActive' ||
    !isSynthesisFullyResolved(model.synthesis)
  ) {
    return [model, []]
  }

  const playbackId = nextRunId
  const freshPlayback = startPlayback(model.synthesis.chunkTexts, playbackId)
  const [advancedPlayback, commands] = tryAdvancePlayback(
    freshPlayback,
    model.synthesis.chunkStates,
    model.synthesis.estimatedDurationsSec,
  )
  return [
    evo(model, {
      playback: () => advancedPlayback,
      nextRunId: n => n + 1,
      pendingAutoPlay: () => false,
    }),
    commands,
  ]
}

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    withUpdateReturn,
    M.tagsExhaustive({
      UpdatedTextInput: ({ value }) => [evo(model, { textInput: () => value }), []],

      SelectedModel: ({ model: selected }) => {
        const status = selected === 'Nano' ? model.nanoPreload : model.microPreload
        const nextModel = evo(model, { selectedModel: () => selected })
        if (status._tag !== 'PreloadNotStarted') {
          return [nextModel, []]
        }
        const withPreloading = evo(nextModel, {
          nanoPreload: current => (selected === 'Nano' ? PreloadInProgress({ progress: 0, phase: 'downloading' }) : current),
          microPreload: current => (selected === 'Micro' ? PreloadInProgress({ progress: 0, phase: 'downloading' }) : current),
        })
        return [withPreloading, [PreloadModel({ model: selected })]]
      },

      PreloadedModel: ({ model: preloaded }) => [
        evo(model, {
          nanoPreload: current => (preloaded === 'Nano' ? PreloadReady() : current),
          microPreload: current => (preloaded === 'Micro' ? PreloadReady() : current),
        }),
        [],
      ],

      FailedPreloadModel: ({ model: failed, error }) => [
        evo(model, {
          nanoPreload: current => (failed === 'Nano' ? PreloadFailed({ error }) : current),
          microPreload: current => (failed === 'Micro' ? PreloadFailed({ error }) : current),
        }),
        [],
      ],

      ReceivedDownloadProgress: ({ model: downloading, fraction, phase }) => [
        evo(model, {
          nanoPreload: current =>
            downloading === 'Nano' && current._tag === 'PreloadInProgress'
              ? PreloadInProgress({ progress: fraction, phase })
              : current,
          microPreload: current =>
            downloading === 'Micro' && current._tag === 'PreloadInProgress'
              ? PreloadInProgress({ progress: fraction, phase })
              : current,
        }),
        [],
      ],

      ClickedSynthesize: () => {
        const chunkTexts = splitText(model.textInput, CHUNK_CHAR_LIMIT)
        if (chunkTexts.length === 0) {
          return [appendActivityLog(model, 'Enter some text first.'), []]
        }

        const estimatedDurationsSec = chunkTexts.map(text => estimateDurationSec(normalizeText(text)))
        const synthesisRunId = model.nextRunId
        const playbackId = model.nextRunId + 1
        const freshSynthesis = SynthesisActive({
          runId: synthesisRunId,
          model: model.selectedModel,
          chunkTexts,
          estimatedDurationsSec,
          chunkStates: chunkTexts.map(() => SynthChunkPending()),
          dispatchedCount: 0,
          dispatchAll: false,
        })

        const [advancedSynthesis, commands] = tryAdvanceSynthesis(freshSynthesis)

        return [
          evo(model, {
            synthesis: () => advancedSynthesis,
            playback: () => startPlayback(chunkTexts, playbackId),
            nextRunId: n => n + 2,
            activityLog: () => [`${chunkTexts.length} chunk(s) queued.`],
            detailLog: () => [],
            maybeDownloadUrl: () => Option.none(),
            pendingAutoPlay: () => false,
          }),
          [StopAudio(), ...commands],
        ]
      },

      ClickedGenerate: () => {
        const chunkTexts = splitText(model.textInput, CHUNK_CHAR_LIMIT)
        if (chunkTexts.length === 0) {
          return [appendActivityLog(model, 'Enter some text first.'), []]
        }

        const estimatedDurationsSec = chunkTexts.map(text => estimateDurationSec(normalizeText(text)))
        const synthesisRunId = model.nextRunId
        const freshSynthesis = SynthesisActive({
          runId: synthesisRunId,
          model: model.selectedModel,
          chunkTexts,
          estimatedDurationsSec,
          chunkStates: chunkTexts.map(() => SynthChunkPending()),
          dispatchedCount: 0,
          dispatchAll: true,
        })

        // No playback started here: Generate synthesizes the whole thing
        // as fast as the worker can go, with no incremental predictive
        // scheduling in the way, and only starts playing once every chunk
        // has actually resolved (see pendingAutoPlay, checked in
        // SucceededSynthesizeChunk/FailedSynthesizeChunk below).
        const [advancedSynthesis, commands] = tryAdvanceSynthesis(freshSynthesis)

        return [
          evo(model, {
            synthesis: () => advancedSynthesis,
            playback: () => PlaybackIdle(),
            nextRunId: n => n + 1,
            activityLog: () => [`${chunkTexts.length} chunk(s) queued (generate).`],
            detailLog: () => [],
            maybeDownloadUrl: () => Option.none(),
            pendingAutoPlay: () => true,
          }),
          [StopAudio(), ...commands],
        ]
      },

      ClickedReplay: () =>
        M.value(model.synthesis).pipe(
          withUpdateReturn,
          M.tag('SynthesisActive', synthesis => {
            const playbackId = model.nextRunId
            const freshPlayback = startPlayback(synthesis.chunkTexts, playbackId)
            const [advancedPlayback, commands] = tryAdvancePlayback(
              freshPlayback,
              synthesis.chunkStates,
              synthesis.estimatedDurationsSec,
            )
            return [
              evo(model, {
                playback: () => advancedPlayback,
                nextRunId: n => n + 1,
                activityLog: () => ['Replaying.'],
                maybeDownloadUrl: () => Option.none(),
              }),
              [StopAudio(), ...commands],
            ]
          }),
          M.orElse(() => [appendActivityLog(model, 'Nothing to replay yet.'), []]),
        ),

      ClickedStop: () =>
        M.value(model.playback).pipe(
          withUpdateReturn,
          M.tag('PlaybackActive', () => [evo(model, { playback: () => PlaybackIdle() }), [StopAudio()]]),
          // PlaybackFinished fires the instant the last chunk is handed to
          // Web Audio, not once it actually stops sounding -- audio can
          // still genuinely be playing during that tail window (see
          // isAudioStillPlaying in view.ts, which is what makes Stop
          // clickable here in the first place), so this needs to actually
          // stop it too, not just no-op because playback isn't literally
          // 'PlaybackActive' anymore.
          M.tag('PlaybackFinished', () => [evo(model, { playback: () => PlaybackIdle() }), [StopAudio()]]),
          M.orElse(() => [model, []]),
        ),

      ClickedToggleLogs: () => [evo(model, { logsExpanded: expanded => !expanded }), []],

      SucceededSynthesizeChunk: ({ runId, index, synthMs, durationSec, normalizedText, phonemeText }) =>
        withSynthesisActive(model, runId, synthesis => {
          const nextSynthesis = evo(synthesis, {
            chunkStates: states =>
              states.map((state, i) =>
                i === index ? SynthChunkReady({ normalizedText, phonemeText, synthMs, durationSec }) : state,
              ),
          })
          const [advancedSynthesis, synthesisCommands] = tryAdvanceSynthesis(nextSynthesis)
          const rtf = durationSec / Math.max(synthMs / 1000, 0.001)

          let nextModel = evo(model, {
            synthesis: () => advancedSynthesis,
            activityLog: log =>
              appendLog(
                log,
                `chunk ${index + 1}/${synthesis.chunkTexts.length}: synth ${synthMs.toFixed(0)}ms, ` +
                  `${durationSec.toFixed(2)}s audio, ${rtf.toFixed(1)}x real-time`,
              ),
            detailLog: log => [
              ...appendLog(log, `chunk ${index + 1}: normalized "${normalizedText}"`),
              `chunk ${index + 1}: phonemes "${phonemeText}"`,
            ],
          })
          let commands: ReadonlyArray<AppCommand> = synthesisCommands

          if (nextModel.playback._tag === 'PlaybackActive') {
            const advancedSynthesisChunkStates =
              advancedSynthesis._tag === 'SynthesisActive' ? advancedSynthesis.chunkStates : synthesis.chunkStates
            const [advancedPlayback, playbackCommands] = tryAdvancePlayback(
              nextModel.playback,
              advancedSynthesisChunkStates,
              synthesis.estimatedDurationsSec,
            )
            nextModel = evo(nextModel, { playback: () => advancedPlayback })
            commands = [...commands, ...playbackCommands]
          }

          const [finalModel, autoPlayCommands] = maybeAutoStartPlayback(nextModel, nextModel.nextRunId)
          return [finalModel, [...commands, ...autoPlayCommands]]
        }),

      FailedSynthesizeChunk: ({ runId, index, error }) =>
        withSynthesisActive(model, runId, synthesis => {
          const nextSynthesis = evo(synthesis, {
            chunkStates: states => states.map((state, i) => (i === index ? SynthChunkFailed({ error }) : state)),
          })
          const [advancedSynthesis, synthesisCommands] = tryAdvanceSynthesis(nextSynthesis)

          let nextModel = evo(model, {
            synthesis: () => advancedSynthesis,
            activityLog: log => appendLog(log, `chunk ${index + 1}: FAILED: ${error}`),
          })
          let commands: ReadonlyArray<AppCommand> = synthesisCommands

          if (nextModel.playback._tag === 'PlaybackActive') {
            const advancedSynthesisChunkStates =
              advancedSynthesis._tag === 'SynthesisActive' ? advancedSynthesis.chunkStates : synthesis.chunkStates
            const [advancedPlayback, playbackCommands] = tryAdvancePlayback(
              nextModel.playback,
              advancedSynthesisChunkStates,
              synthesis.estimatedDurationsSec,
            )
            nextModel = evo(nextModel, { playback: () => advancedPlayback })
            commands = [...commands, ...playbackCommands]
          }

          return [nextModel, commands]
        }),

      SucceededScheduleChunk: ({ playbackId, index, playAtSec, endsAtSec }) =>
        withPlaybackActive(model, playbackId, playback => {
          const synthState =
            model.synthesis._tag === 'SynthesisActive' ? model.synthesis.chunkStates[index] : undefined
          const rawText = playback.chunkTexts[index] ?? ''

          const nextPlayback = evo(playback, {
            nextStartTimeSec: () => endsAtSec,
            chunkStates: states =>
              states.map((state, i) => {
                if (i !== index || synthState?._tag !== 'SynthChunkReady') {
                  return state
                }
                // Word weighting/highlighting uses the *normalized* text
                // (what was actually spoken) for timing, then maps each
                // span back onto the raw typed words for display -- see
                // computeDisplayWordFractions.
                const wordSpans = computeDisplayWordFractions(rawText, synthState.normalizedText).map(
                  ({ displayText, startFraction, endFraction }) => ({
                    word: displayText,
                    startSec: playAtSec + startFraction * synthState.durationSec,
                    endSec: playAtSec + endFraction * synthState.durationSec,
                  }),
                )
                return PlaybackChunkScheduled({ playAtSec, durationSec: synthState.durationSec, wordSpans })
              }),
          })
          const [advancedPlayback, commands] =
            model.synthesis._tag === 'SynthesisActive'
              ? tryAdvancePlayback(nextPlayback, model.synthesis.chunkStates, model.synthesis.estimatedDurationsSec)
              : [nextPlayback, []]
          return [evo(model, { playback: () => advancedPlayback }), commands]
        }),

      FailedScheduleChunk: ({ playbackId, index, error }) =>
        withPlaybackActive(model, playbackId, playback => {
          const [advancedPlayback, commands] =
            model.synthesis._tag === 'SynthesisActive'
              ? tryAdvancePlayback(playback, model.synthesis.chunkStates, model.synthesis.estimatedDurationsSec)
              : [playback, []]
          return [
            evo(model, {
              playback: () => advancedPlayback,
              activityLog: log => appendLog(log, `chunk ${index + 1}: scheduling FAILED: ${error}`),
            }),
            commands,
          ]
        }),

      CompletedStopAudio: () => [model, []],

      CompletedAssembleDownload: ({ url }) => [
        evo(model, {
          maybeDownloadUrl: () => (url ? Option.some(url) : Option.none()),
          activityLog: log => appendLog(log, 'All chunks synthesized.'),
        }),
        [],
      ],

      AcquiredSynthesisWorker: () => [
        evo(model, { nanoPreload: () => PreloadInProgress({ progress: 0, phase: 'downloading' }) }),
        [PreloadModel({ model: 'Nano' })],
      ],
      ReleasedSynthesisWorker: () => [model, []],
      FailedAcquireSynthesisWorker: ({ error }) => [
        appendActivityLog(model, `Synthesis worker failed to start: ${error}`),
        [],
      ],
      AcquiredAudioEngine: () => [model, []],
      ReleasedAudioEngine: () => [model, []],
      FailedAcquireAudioEngine: ({ error }) => [
        appendActivityLog(model, `Audio engine failed to start: ${error}`),
        [],
      ],

      TickedPlayback: ({ currentTimeSec }) => [
        evo(model, { currentPlaybackTimeSec: () => currentTimeSec }),
        [],
      ],
    }),
  )

// INIT

export const init: Runtime.ApplicationInit<Model, Message, void, AppRequirements> = () => [
  {
    selectedModel: 'Nano',
    nanoPreload: PreloadNotStarted(),
    microPreload: PreloadNotStarted(),
    textInput: DEFAULT_TEXT,
    synthesis: SynthesisIdle(),
    playback: PlaybackIdle(),
    activityLog: [],
    detailLog: [],
    maybeDownloadUrl: Option.none(),
    nextRunId: 0,
    currentPlaybackTimeSec: 0,
    pendingAutoPlay: false,
    logsExpanded: false,
  },
  [],
]

// MANAGED RESOURCE

export const managedResources = ManagedResource.make<Model, Message>()(entry => ({
  synthesisWorker: entry(S.Option(S.Null), {
    resource: SynthesisWorker,
    modelToMaybeRequirements: () => Option.some(null),
    acquire: () => acquireSynthesisWorker,
    release: releaseSynthesisWorker,
    onAcquired: () => AcquiredSynthesisWorker(),
    onReleased: () => ReleasedSynthesisWorker(),
    onAcquireError: error => FailedAcquireSynthesisWorker({ error: String(error) }),
  }),
  audioEngine: entry(S.Option(S.Null), {
    resource: AudioEngine,
    modelToMaybeRequirements: () => Option.some(null),
    acquire: () => acquireAudioEngine,
    release: releaseAudioEngine,
    onAcquired: () => AcquiredAudioEngine(),
    onReleased: () => ReleasedAudioEngine(),
    onAcquireError: error => FailedAcquireAudioEngine({ error: String(error) }),
  }),
}))

// SUBSCRIPTION

export const subscriptions = Subscription.make<Model, Message, AudioEngineService | SynthesisWorkerService>()(entry => ({
  downloadProgress: entry(
    { active: S.Boolean },
    {
      // dependenciesToStream only re-runs when this computed value
      // actually *changes* -- an always-true dependency never changes, so
      // it only gets evaluated once, at the very start of app boot,
      // before the SynthesisWorker resource has finished acquiring
      // (confirmed via logging: ResourceNotAvailable, then silence
      // forever after, even once the worker was clearly ready and
      // posting real progress messages). Gating on preload having
      // started at all gives it a genuine false->true edge that only
      // fires once the worker is guaranteed to exist (AcquiredSynthesisWorker
      // always kicks off preload first), so the stream gets (re)built at
      // a point where SynthesisWorker.get can actually succeed.
      modelToDependencies: sub => ({
        active: sub.nanoPreload._tag !== 'PreloadNotStarted' || sub.microPreload._tag !== 'PreloadNotStarted',
      }),
      dependenciesToStream: ({ active }) =>
        Stream.when(
          Stream.unwrap(
            SynthesisWorker.get.pipe(
              Effect.map(streamWorkerProgress),
              Effect.catchTag('ResourceNotAvailable', () => Effect.succeed(Stream.empty)),
            ),
          ).pipe(
            Stream.map(({ modelKey, fraction, phase }) =>
              ReceivedDownloadProgress({ model: modelKey === 'nano' ? 'Nano' : 'Micro', fraction, phase }),
            ),
          ),
          Effect.sync(() => active),
        ),
    },
  ),

  playbackClock: entry(
    { shouldTick: S.Boolean },
    {
      // Keep ticking until the *audio* actually finishes, not just until
      // scheduling does -- PlaybackFinished is reached the instant the
      // last chunk is handed to Web Audio, typically several seconds
      // before that chunk's audio actually stops playing. Stopping the
      // clock at PlaybackFinished froze currentPlaybackTimeSec mid-chunk,
      // leaving whichever word was active at that instant stuck
      // highlighted for the remainder of playback.
      modelToDependencies: sub => ({
        shouldTick:
          sub.playback._tag === 'PlaybackActive' ||
          (sub.playback._tag === 'PlaybackFinished' && sub.currentPlaybackTimeSec < sub.playback.finishesAtSec),
      }),
      dependenciesToStream: ({ shouldTick }) =>
        Stream.when(
          Stream.unwrap(
            AudioEngine.get.pipe(
              Effect.map(streamPlaybackTicks),
              Effect.catchTag('ResourceNotAvailable', () => Effect.succeed(Stream.empty)),
            ),
          ),
          Effect.sync(() => shouldTick),
        ),
    },
  ),
}))
