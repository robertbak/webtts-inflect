import { Array, Match as M, Option } from 'effect'
import { Document, Html, html } from 'foldkit/html'

import { Button } from '@foldkit/ui'

import {
  ClickedGenerate,
  ClickedReplay,
  ClickedStop,
  ClickedSynthesize,
  ClickedToggleLogs,
  Message,
  SelectedModel,
  UpdatedTextInput,
} from './message'
import type {
  Model,
  ModelKey,
  PlaybackChunkState,
  PlaybackState,
  PreloadStatus,
  SynthesisState,
  WordSpan,
} from './model'
import { computeWordLayout } from './normalize'

const cardClass =
  'bg-white rounded-2xl shadow-xl shadow-slate-200/60 ring-1 ring-slate-900/5 p-8'

const repeat = <T>(count: number, toValue: (index: number) => T): Array<T> => {
  const values: Array<T> = []
  for (let i = 0; i < count; i++) {
    values.push(toValue(i))
  }
  return values
}

export const view = (model: Model): Document => {
  const h = html<Message>()

  return {
    title: 'Inflect TTS — entirely in-browser',
    body: h.div(
      [
        h.Class(
          'min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 py-12 px-4',
        ),
      ],
      [
        h.div(
          [h.Class('max-w-2xl mx-auto flex flex-col gap-6')],
          [
            headerView(),
            h.div(
              [h.Class(cardClass + ' flex flex-col gap-6')],
              [
                modelPickerView(model),
                textInputView(model.textInput),
                controlsView(
                  model.synthesis,
                  model.playback,
                  model.currentPlaybackTimeSec,
                  (model.selectedModel === 'Nano'
                    ? model.nanoPreload
                    : model.microPreload
                  )._tag === 'PreloadReady',
                ),
                transcriptView(
                  model.synthesis,
                  model.playback,
                  model.currentPlaybackTimeSec,
                ),
                audioView(model.maybeDownloadUrl),
              ],
            ),
            logCardView(model),
            aboutView(),
          ],
        ),
      ],
    ),
  }
}

const headerView = (): Html => {
  const h = html<Message>()

  return h.div(
    [h.Class('text-center flex flex-col gap-1')],
    [
      h.h1(
        [h.Class('text-3xl font-bold text-slate-900 tracking-tight')],
        ['Inflect TTS, entirely in-browser'],
      ),
      h.p(
        [h.Class('text-slate-500 text-sm')],
        [
          'ONNX Runtime Web + espeak-ng WASM. No server round-trip for synthesis.',
        ],
      ),
    ],
  )
}

const preloadDotClass = (status: PreloadStatus): string =>
  M.value(status).pipe(
    M.tag('PreloadNotStarted', () => 'bg-slate-300'),
    M.tag('PreloadInProgress', () => 'bg-amber-400 animate-pulse'),
    M.tag('PreloadReady', () => 'bg-emerald-500'),
    M.tag('PreloadFailed', () => 'bg-red-500'),
    M.exhaustive,
  )

const preloadLabel = (status: PreloadStatus): string =>
  M.value(status).pipe(
    M.tag('PreloadNotStarted', () => 'not loaded'),
    M.tag('PreloadInProgress', ({ progress, phase }) =>
      phase === 'compiling'
        ? 'compiling…'
        : `downloading… ${Math.round(progress * 100)}%`,
    ),
    M.tag('PreloadReady', () => 'ready'),
    M.tag('PreloadFailed', ({ error }) => `failed: ${error}`),
    M.exhaustive,
  )

const modelButtonView = (
  label: string,
  paramsDescription: string,
  model: ModelKey,
  isSelected: boolean,
  status: PreloadStatus,
): Html => {
  const h = html<Message>()

  const baseClass =
    'flex-1 rounded-xl border-2 px-4 py-3 text-left transition-colors cursor-pointer'
  const selectedClass = isSelected
    ? 'border-indigo-500 bg-indigo-50'
    : 'border-slate-200 bg-white hover:border-slate-300'

  return Button.view<Message>({
    onClick: SelectedModel({ model }),
    toView: attributes =>
      h.button(
        [...attributes.button, h.Class(`${baseClass} ${selectedClass}`)],
        [
          h.div(
            [h.Class('flex items-center gap-2')],
            [
              h.span(
                [h.Class(`w-2 h-2 rounded-full ${preloadDotClass(status)}`)],
                [],
              ),
              h.span([h.Class('font-semibold text-slate-900')], [label]),
            ],
          ),
          h.div([h.Class('text-xs text-slate-500 mt-1')], [paramsDescription]),
          h.div([h.Class('text-xs text-slate-400')], [preloadLabel(status)]),
          status._tag === 'PreloadInProgress'
            ? h.div(
                [
                  h.Class(
                    'h-1 w-full rounded-full bg-slate-100 overflow-hidden mt-1',
                  ),
                ],
                [
                  h.div(
                    [
                      h.Class(
                        status.phase === 'compiling'
                          ? 'h-full w-full bg-amber-400 animate-pulse'
                          : 'h-full bg-amber-400 transition-all duration-200 ease-out',
                      ),
                      h.Style(
                        status.phase === 'compiling'
                          ? {}
                          : { width: `${(status.progress * 100).toFixed(1)}%` },
                      ),
                    ],
                    [],
                  ),
                ],
              )
            : h.empty,
        ],
      ),
  })
}

const modelPickerView = (model: Model): Html => {
  const h = html<Message>()

  return h.div(
    [h.Class('flex gap-3')],
    [
      modelButtonView(
        'Inflect-Nano-v2',
        '3.97M params, ~16MB',
        'Nano',
        model.selectedModel === 'Nano',
        model.nanoPreload,
      ),
      modelButtonView(
        'Inflect-Micro-v2',
        '9.36M params, ~37MB',
        'Micro',
        model.selectedModel === 'Micro',
        model.microPreload,
      ),
    ],
  )
}

const textInputView = (textInput: string): Html => {
  const h = html<Message>()

  return h.textarea(
    [
      h.Value(textInput),
      h.OnInput(value => UpdatedTextInput({ value })),
      h.Rows(6),
      h.Placeholder('Type something to synthesize…'),
      h.Class(
        'w-full rounded-xl border border-slate-200 p-4 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent resize-y',
      ),
    ],
    [],
  )
}

const isSynthesisInFlight = (synthesis: SynthesisState): boolean =>
  synthesis._tag === 'SynthesisActive' &&
  synthesis.chunkStates.some(
    state =>
      state._tag === 'SynthChunkPending' ||
      state._tag === 'SynthChunkDispatched',
  )

const canReplay = (synthesis: SynthesisState): boolean =>
  synthesis._tag === 'SynthesisActive' && !isSynthesisInFlight(synthesis)

// PlaybackFinished fires the instant the last chunk is *handed to* Web
// Audio, typically several seconds before that chunk's audio actually
// stops playing (see the playbackClock subscription for the same
// distinction) -- Stop needs to stay enabled through that tail window,
// not just while playback._tag is literally 'PlaybackActive'.
const isAudioStillPlaying = (
  playback: PlaybackState,
  currentPlaybackTimeSec: number,
): boolean =>
  playback._tag === 'PlaybackActive' ||
  (playback._tag === 'PlaybackFinished' &&
    currentPlaybackTimeSec < playback.finishesAtSec)

const controlsView = (
  synthesis: SynthesisState,
  playback: PlaybackState,
  currentPlaybackTimeSec: number,
  modelReady: boolean,
): Html => {
  const h = html<Message>()
  const synthesizing = isSynthesisInFlight(synthesis)
  const playing = isAudioStillPlaying(playback, currentPlaybackTimeSec)

  return h.div(
    [h.Class('grid grid-cols-2 gap-3 sm:flex')],
    [
      Button.view<Message>({
        onClick: ClickedSynthesize(),
        isDisabled: synthesizing || !modelReady,
        toView: attributes =>
          h.button(
            [
              ...attributes.button,
              h.Class(
                'sm:flex-1 rounded-xl bg-indigo-600 text-white font-semibold py-3 transition-colors hover:bg-indigo-700 data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed data-[disabled]:hover:bg-indigo-600',
              ),
            ],
            [
              synthesizing
                ? 'Streaming…'
                : !modelReady
                  ? 'Loading model…'
                  : 'Stream',
            ],
          ),
      }),
      Button.view<Message>({
        onClick: ClickedGenerate(),
        isDisabled: synthesizing || !modelReady,
        toView: attributes =>
          h.button(
            [
              ...attributes.button,
              h.Class(
                'sm:flex-1 rounded-xl border-2 border-indigo-200 text-indigo-700 font-semibold py-3 transition-colors hover:bg-indigo-50 data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed',
              ),
            ],
            [
              synthesizing
                ? 'Generating…'
                : !modelReady
                  ? 'Loading model…'
                  : 'Generate',
            ],
          ),
      }),
      Button.view<Message>({
        onClick: ClickedReplay(),
        isDisabled: !canReplay(synthesis),
        toView: attributes =>
          h.button(
            [
              ...attributes.button,
              h.Class(
                'rounded-xl border border-slate-200 text-slate-600 font-semibold py-3 sm:px-6 transition-colors hover:bg-slate-50 data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed',
              ),
            ],
            ['Replay'],
          ),
      }),
      Button.view<Message>({
        onClick: ClickedStop(),
        isDisabled: !playing,
        toView: attributes =>
          h.button(
            [
              ...attributes.button,
              h.Class(
                'rounded-xl border border-slate-200 text-slate-600 font-semibold py-3 sm:px-6 transition-colors hover:bg-slate-50 data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed',
              ),
            ],
            ['Stop'],
          ),
      }),
    ],
  )
}

/**
 * Renders one chunk's words, colored by relationship to the current
 * AudioContext playback time: light green once a word's window has
 * passed, blue for whichever word is currently playing, light orange for
 * words still ahead (already scheduled, just not reached yet). The
 * windows are an approximation (see computeWordFractions), not real
 * alignment data from the model, so this tracks along rather than
 * pinpoints exactly.
 */
// splitSentences() attaches a chunk-ending line/stanza break as trailing
// '\n's on that chunk's own text (see there) -- used for the audio pause
// (boundaryPauseSeconds), but computeWordLayout only ever looks at gaps
// *before* each word, so a chunk's own trailing break, after its last
// word, is otherwise never rendered. Every chunk boundary that lands on
// a real line break (any line ending in punctuation, i.e. most of them)
// needs this, not just mid-chunk enjambment.
const trailingBreakCount = (chunkText: string): number =>
  chunkText.match(/\n+$/)?.[0].length ?? 0

const scheduledChunkView = (
  chunkIndex: number,
  chunkText: string,
  wordSpans: ReadonlyArray<WordSpan>,
  currentTimeSec: number,
): Html => {
  const h = html<Message>()
  const layout = computeWordLayout(chunkText)

  const wordPrefix = (
    keyPrefix: string,
    wordIndex: number,
  ): Array<Html | string> => {
    const { breaksBefore, indent } = layout[wordIndex] ?? {
      breaksBefore: 0,
      indent: 0,
    }
    const breaks = repeat(breaksBefore, brIndex =>
      h.keyed('br')(`${keyPrefix}-br-${wordIndex}-${brIndex}`, [], []),
    )
    return indent > 0 ? [...breaks, ' '.repeat(indent)] : breaks
  }

  const trailingBreaks = repeat(trailingBreakCount(chunkText), brIndex =>
    h.keyed('br')(`chunk-${chunkIndex}-trailing-br-${brIndex}`, [], []),
  )

  return h.keyed('span')(
    `chunk-${chunkIndex}`,
    [],
    [
      ...wordSpans.flatMap((span, wordIndex) => {
        const isCurrent =
          currentTimeSec >= span.startSec && currentTimeSec < span.endSec
        const isDone = currentTimeSec >= span.endSec
        const wordClass = isCurrent
          ? 'bg-blue-200 text-blue-900 rounded px-0.5'
          : isDone
            ? 'bg-emerald-100 text-emerald-800 rounded px-0.5'
            : 'bg-amber-100 text-amber-800 rounded px-0.5'
        const wordSpan = h.keyed('span')(
          `chunk-${chunkIndex}-word-${wordIndex}`,
          [h.Class(`${wordClass} transition-colors`)],
          [span.word],
        )
        return [...wordPrefix(`chunk-${chunkIndex}`, wordIndex), wordSpan, ' ']
      }),
      ...trailingBreaks,
    ],
  )
}

const plainChunkView = (
  chunkIndex: number,
  chunkText: string,
  isSkipped: boolean,
): Html => {
  const h = html<Message>()
  const layout = computeWordLayout(chunkText)
  const words = chunkText.split(/\s+/).filter(Boolean)
  const wordClass = isSkipped ? 'text-red-400 line-through' : 'text-slate-700'

  const wordPrefix = (wordIndex: number): Array<Html | string> => {
    const { breaksBefore, indent } = layout[wordIndex] ?? {
      breaksBefore: 0,
      indent: 0,
    }
    const breaks = repeat(breaksBefore, brIndex =>
      h.keyed('br')(
        `chunk-${chunkIndex}-plain-br-${wordIndex}-${brIndex}`,
        [],
        [],
      ),
    )
    return indent > 0 ? [...breaks, ' '.repeat(indent)] : breaks
  }

  const trailingBreaks = repeat(trailingBreakCount(chunkText), brIndex =>
    h.keyed('br')(`chunk-${chunkIndex}-plain-trailing-br-${brIndex}`, [], []),
  )

  return h.keyed('span')(
    `chunk-${chunkIndex}`,
    [h.Class(wordClass)],
    [
      ...words.flatMap((word, wordIndex) => [
        ...wordPrefix(wordIndex),
        word,
        ' ',
      ]),
      ...trailingBreaks,
    ],
  )
}

const playbackChunksView = (
  chunkTexts: ReadonlyArray<string>,
  chunkStates: ReadonlyArray<PlaybackChunkState>,
  currentPlaybackTimeSec: number,
): Html => {
  const h = html<Message>()

  return h.p(
    [h.Class('text-sm leading-relaxed whitespace-pre-line')],
    chunkStates.map((state, i) =>
      M.value(state).pipe(
        M.tag('PlaybackChunkScheduled', ({ wordSpans }) =>
          scheduledChunkView(
            i,
            chunkTexts[i] ?? '',
            wordSpans,
            currentPlaybackTimeSec,
          ),
        ),
        M.tag('PlaybackChunkSkipped', () =>
          plainChunkView(i, chunkTexts[i] ?? '', true),
        ),
        M.tag('PlaybackChunkWaiting', () =>
          plainChunkView(i, chunkTexts[i] ?? '', false),
        ),
        M.exhaustive,
      ),
    ),
  )
}

interface ProgressSegment {
  readonly key: string
  readonly durationSec: number
  readonly colorClass: string
  // How much of this segment lies before currentPlaybackTimeSec: 0 for a
  // word not reached yet, 1 for one fully played, a fraction in between
  // for whichever word is currently playing. Segment *widths* only ever
  // change in discrete word-sized jumps (fine for text highlighting above),
  // but this drives a separate playhead overlay that moves continuously
  // within a word instead of only jumping at word boundaries.
  readonly completedFraction: number
}

/**
 * One segment per word for scheduled chunks (so the bar's blue marker
 * moves in step with the text highlight above), one segment per
 * not-yet-scheduled chunk sized by its estimated duration (no per-word
 * timing exists for those yet).
 */
const buildProgressSegments = (
  chunkStates: ReadonlyArray<PlaybackChunkState>,
  estimatedDurationsSec: ReadonlyArray<number>,
  currentPlaybackTimeSec: number,
): ReadonlyArray<ProgressSegment> =>
  chunkStates.flatMap((state, i) =>
    M.value(state).pipe(
      M.tag('PlaybackChunkScheduled', ({ wordSpans }) =>
        wordSpans.map((span, wi) => {
          const durationSec = Math.max(span.endSec - span.startSec, 0.001)
          const completedFraction =
            currentPlaybackTimeSec <= span.startSec
              ? 0
              : currentPlaybackTimeSec >= span.endSec
                ? 1
                : (currentPlaybackTimeSec - span.startSec) / durationSec
          return {
            key: `seg-${i}-${wi}`,
            durationSec,
            colorClass:
              currentPlaybackTimeSec >= span.startSec &&
              currentPlaybackTimeSec < span.endSec
                ? 'bg-blue-400'
                : currentPlaybackTimeSec >= span.endSec
                  ? 'bg-emerald-400'
                  : 'bg-amber-300',
            completedFraction,
          }
        }),
      ),
      M.tag('PlaybackChunkSkipped', () => [
        {
          key: `seg-${i}`,
          durationSec: estimatedDurationsSec[i] ?? 1,
          colorClass: 'bg-red-300',
          completedFraction: 0,
        },
      ]),
      M.tag('PlaybackChunkWaiting', () => [
        {
          key: `seg-${i}`,
          durationSec: estimatedDurationsSec[i] ?? 1,
          colorClass: 'bg-amber-200',
          completedFraction: 0,
        },
      ]),
      M.exhaustive,
    ),
  )

const progressBarView = (
  chunkStates: ReadonlyArray<PlaybackChunkState>,
  estimatedDurationsSec: ReadonlyArray<number>,
  currentPlaybackTimeSec: number,
): Html => {
  const h = html<Message>()
  const segments = buildProgressSegments(
    chunkStates,
    estimatedDurationsSec,
    currentPlaybackTimeSec,
  )
  const totalSec =
    segments.reduce((sum, segment) => sum + segment.durationSec, 0) || 1
  const playedSec = segments.reduce(
    (sum, segment) => sum + segment.durationSec * segment.completedFraction,
    0,
  )
  const playheadPercent = Math.min(
    100,
    Math.max(0, (playedSec / totalSec) * 100),
  )

  return h.div(
    [h.Class('relative h-2 w-full')],
    [
      h.div(
        [h.Class('flex h-2 w-full rounded-full overflow-hidden bg-slate-100')],
        segments.map(segment =>
          h.keyed('div')(
            segment.key,
            [
              h.Class(
                `${segment.colorClass} transition-all duration-300 ease-out`,
              ),
              h.Style({
                width: `${((segment.durationSec / totalSec) * 100).toFixed(3)}%`,
              }),
            ],
            [],
          ),
        ),
      ),
      // The segments above jump in discrete word-sized steps; this thin
      // marker glides continuously (re-positioned every animation frame by
      // the playback clock) so the bar as a whole doesn't look like it's
      // standing still between word boundaries.
      h.div(
        [
          h.Class(
            'absolute top-0 h-2 w-0.5 -ml-px rounded-full bg-blue-700 shadow-sm',
          ),
          h.Style({
            left: `${playheadPercent.toFixed(3)}%`,
            transition: 'left 80ms linear',
          }),
        ],
        [],
      ),
    ],
  )
}

const transcriptView = (
  synthesis: SynthesisState,
  playback: PlaybackState,
  currentPlaybackTimeSec: number,
): Html => {
  const h = html<Message>()

  if (synthesis._tag === 'SynthesisIdle') {
    return h.empty
  }
  const estimatedDurationsSec = synthesis.estimatedDurationsSec

  return M.value(playback).pipe(
    M.tag('PlaybackIdle', () => h.empty),
    M.tag('PlaybackActive', ({ chunkTexts, chunkStates }) =>
      h.div(
        [h.Class('flex flex-col gap-3')],
        [
          playbackChunksView(chunkTexts, chunkStates, currentPlaybackTimeSec),
          progressBarView(
            chunkStates,
            estimatedDurationsSec,
            currentPlaybackTimeSec,
          ),
        ],
      ),
    ),
    M.tag('PlaybackFinished', ({ chunkTexts, chunkStates }) =>
      h.div(
        [h.Class('flex flex-col gap-3')],
        [
          playbackChunksView(chunkTexts, chunkStates, currentPlaybackTimeSec),
          progressBarView(
            chunkStates,
            estimatedDurationsSec,
            currentPlaybackTimeSec,
          ),
        ],
      ),
    ),
    M.exhaustive,
  )
}

const audioView = (maybeDownloadUrl: Option.Option<string>): Html => {
  const h = html<Message>()

  return Option.match(maybeDownloadUrl, {
    onNone: () => h.empty,
    onSome: url =>
      h.div(
        [h.Class('flex flex-col gap-2')],
        [
          h.audio([h.Src(url), h.Controls(true), h.Class('w-full')], []),
          h.a(
            [
              h.Href(url),
              h.Download('inflect-tts.wav'),
              h.Class('text-xs text-indigo-600 hover:underline'),
            ],
            ['Download WAV'],
          ),
        ],
      ),
  })
}

/** Average real-time factor across every chunk synthesized so far, if any. */
const averageRtf = (synthesis: SynthesisState): number | undefined => {
  if (synthesis._tag !== 'SynthesisActive') {
    return undefined
  }
  const ready = synthesis.chunkStates.filter(
    state => state._tag === 'SynthChunkReady',
  )
  if (ready.length === 0) {
    return undefined
  }
  const totalRtf = ready.reduce(
    (sum, state) =>
      sum + state.durationSec / Math.max(state.synthMs / 1000, 0.001),
    0,
  )
  return totalRtf / ready.length
}

const logCardView = (model: Model): Html => {
  const h = html<Message>()
  const rtf = averageRtf(model.synthesis)

  return h.div(
    [h.Class(cardClass + ' flex flex-col gap-4')],
    [
      Button.view<Message>({
        onClick: ClickedToggleLogs(),
        toView: attributes =>
          h.button(
            [
              ...attributes.button,
              h.Class(
                'flex items-center justify-between gap-3 cursor-pointer text-left',
              ),
            ],
            [
              h.div(
                [h.Class('flex items-center gap-2')],
                [
                  h.span(
                    [
                      h.Class(
                        'text-xs font-semibold text-slate-400 uppercase tracking-wide',
                      ),
                    ],
                    ['Logs'],
                  ),
                  rtf === undefined
                    ? h.empty
                    : h.span(
                        [
                          h.Class(
                            'text-xs font-mono text-emerald-600 bg-emerald-50 rounded-full px-2 py-0.5',
                          ),
                        ],
                        [`${rtf.toFixed(1)}x avg`],
                      ),
                ],
              ),
              h.span(
                [h.Class('text-xs text-slate-400')],
                [model.logsExpanded ? 'Hide ▲' : 'Show ▼'],
              ),
            ],
          ),
      }),
      model.logsExpanded
        ? h.div(
            [h.Class('flex flex-col gap-4')],
            [
              logSectionView('Activity', model.activityLog),
              Array.match(model.detailLog, {
                onEmpty: () => h.empty,
                onNonEmpty: () => logSectionView('Details', model.detailLog),
              }),
            ],
          )
        : h.empty,
    ],
  )
}

const logSectionView = (title: string, lines: ReadonlyArray<string>): Html => {
  const h = html<Message>()

  return h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.div(
        [
          h.Class(
            'text-xs font-semibold text-slate-400 uppercase tracking-wide',
          ),
        ],
        [title],
      ),
      Array.match(lines, {
        onEmpty: () =>
          h.div([h.Class('text-sm text-slate-400')], ['Nothing yet.']),
        onNonEmpty: nonEmptyLines =>
          h.div(
            [
              h.Class(
                'font-mono text-xs text-slate-600 bg-slate-50 rounded-lg p-3 max-h-64 overflow-y-auto whitespace-pre-wrap break-words',
              ),
            ],
            [nonEmptyLines.join('\n')],
          ),
      }),
    ],
  )
}

const aboutView = (): Html => {
  const h = html<Message>()

  return h.p(
    [h.Class('text-xs text-slate-400 text-center leading-relaxed')],
    [
      'Text is chunked, normalized (numbers/dates/money/abbreviations, ported from the model ',
      "author's own normalize_text()), phonemized with espeak-ng (WASM), and streamed through ",
      'the ONNX graphs as it becomes ready. Synthesis and playback are independent: Replay ',
      'restarts playback against already-synthesized audio, instantly, with no server and no ',
      're-synthesis. Each chunk predicts the next one’s synthesis time from its own measured ',
      'speed, and only waits when there’s a real risk of an audible gap.',
    ],
  )
}
