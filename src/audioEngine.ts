import { Effect } from 'effect'
import { ManagedResource } from 'foldkit'

const SAMPLE_RATE = 24000

interface StoredSamples {
  readonly samples: Float32Array
  readonly sampleRate: number
}

export interface AudioEngineHandle {
  readonly context: AudioContext
  readonly samplesByIndex: Map<number, StoredSamples>
  readonly activeSources: Array<AudioBufferSourceNode>
}

export const AudioEngine = ManagedResource.tag<AudioEngineHandle>()('AudioEngine')
export type AudioEngineService = ManagedResource.ServiceOf<typeof AudioEngine>

export const acquireAudioEngine: Effect.Effect<AudioEngineHandle> = Effect.sync(() => ({
  context: new AudioContext(),
  samplesByIndex: new Map(),
  activeSources: [],
}))

export const releaseAudioEngine = (handle: AudioEngineHandle): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const source of handle.activeSources) {
      try {
        source.stop()
      } catch {
        // already stopped
      }
    }
    void handle.context.close()
  })

export const storeSamples = (handle: AudioEngineHandle, index: number, samples: Float32Array): void => {
  handle.samplesByIndex.set(index, { samples, sampleRate: SAMPLE_RATE })
}

export interface ScheduleResult {
  readonly playAtSec: number
  readonly endsAtSec: number
  readonly durationSec: number
}

/**
 * Schedules chunk `index`'s stored samples to play at or after
 * `nextStartTimeSec` (an AudioContext.currentTime-relative timestamp).
 * Throws if the chunk's samples were never stored -- callers only invoke
 * this once SucceededSynthesizeChunk has stashed them via storeSamples.
 */
export const scheduleChunk = (
  handle: AudioEngineHandle,
  index: number,
  pauseSec: number,
  nextStartTimeSec: number,
): ScheduleResult => {
  const stored = handle.samplesByIndex.get(index)
  if (!stored) {
    throw new Error(`No stored samples for chunk ${index}`)
  }
  const { context } = handle
  // The context is created when the AudioEngine resource is acquired
  // (page load), not inside a click handler, so browsers leave it
  // 'suspended' until explicitly resumed -- scheduleChunk only ever runs
  // as a result of a Stream/Generate/Replay click, so this is always
  // within a user gesture's call stack.
  if (context.state === 'suspended') {
    void context.resume()
  }
  const buffer = context.createBuffer(1, stored.samples.length, stored.sampleRate)
  buffer.copyToChannel(Float32Array.from(stored.samples), 0)
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  const playAtSec = Math.max(nextStartTimeSec, context.currentTime + 0.05)
  source.start(playAtSec)
  handle.activeSources.push(source)
  const durationSec = stored.samples.length / stored.sampleRate
  return { playAtSec, endsAtSec: playAtSec + durationSec + pauseSec, durationSec }
}

export const stopAllAudio = (handle: AudioEngineHandle): void => {
  for (const source of handle.activeSources) {
    try {
      source.stop()
    } catch {
      // already stopped
    }
  }
  handle.activeSources.length = 0
}

const writeWavString = (view: DataView, offset: number, text: string): void => {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}

const floatArrayToWavUrl = (samples: Float32Array, sampleRate: number): string => {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  writeWavString(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeWavString(view, 8, 'WAVE')
  writeWavString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeWavString(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)
  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  const blob = new Blob([buffer], { type: 'audio/wav' })
  return URL.createObjectURL(blob)
}

/**
 * Concatenates every stored chunk's samples (in order, with the given
 * pause inserted between them) into a single downloadable WAV blob URL.
 */
export const assembleDownloadUrl = (
  handle: AudioEngineHandle,
  order: ReadonlyArray<number>,
  pauseSecByIndex: ReadonlyMap<number, number>,
): string => {
  let totalLen = 0
  for (const index of order) {
    const stored = handle.samplesByIndex.get(index)
    if (!stored) {
      continue
    }
    totalLen += stored.samples.length + Math.round((pauseSecByIndex.get(index) ?? 0) * SAMPLE_RATE)
  }
  const full = new Float32Array(totalLen)
  let offset = 0
  for (const index of order) {
    const stored = handle.samplesByIndex.get(index)
    if (!stored) {
      continue
    }
    full.set(stored.samples, offset)
    offset += stored.samples.length + Math.round((pauseSecByIndex.get(index) ?? 0) * SAMPLE_RATE)
  }
  return floatArrayToWavUrl(full, SAMPLE_RATE)
}
