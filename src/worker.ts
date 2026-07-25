// Runs phonemization + both ONNX graphs off the main thread, so the UI
// (and Web Audio scheduling) never stalls during synthesis. Framework-
// agnostic: plain Worker global scope, no Foldkit/Effect dependency here.
// The main thread talks to it via src/workerClient.ts.
import * as ort from 'onnxruntime-web/wasm'
import { phonemize } from 'phonemizer'

import { normalizeText } from './normalize'

// Root cause of the GitHub Pages hang (confirmed via diagnostic logging:
// our own top-level log line was repeating ~numThreads times): a
// *production build* bundles onnxruntime-web's threaded runtime into this
// same worker file, so each pthread sub-worker it spawns re-executes our
// ENTIRE app worker script from the top -- including this file's own
// `self.onmessage` handler further down, which stomps on the internal
// handler Emscripten's pthread pool needs for its own startup handshake,
// so InferenceSession.create() never resolves. Pointing wasmPaths at
// unbundled copies of onnxruntime-web's own dist files (public/ort/,
// untouched by Vite) makes it load its runtime as a genuinely separate
// script instead. Dev-only, restricted to prod: Vite's dev server refuses
// to serve public/ files via dynamic import() (by design, logs "should
// not be imported from source code"), and the bug this works around only
// exists in a bundled production build anyway -- `vite dev` always serves
// modules unbundled, so onnxruntime's own default resolution just works.
if (import.meta.env.PROD) {
  ort.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`
}
ort.env.wasm.numThreads = self.crossOriginIsolated ? navigator.hardwareConcurrency || 4 : 1
ort.env.wasm.simd = true

const SAMPLE_RATE = 24000

// Mirrors runtime/text/symbols.py exactly (pad + punctuation + ascii letters + IPA letters).
const PAD = '_'
const PUNCTUATION = ';:,.!?¡¿—…"«»“” '
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const LETTERS_IPA =
  "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'̩'ᵻ"
const SYMBOLS = [PAD, ...PUNCTUATION, ...LETTERS, ...LETTERS_IPA]
const SYMBOL_TO_ID = new Map(SYMBOLS.map((s, i) => [s, i]))
const ADD_BLANK = true

const PHONEME_OVERRIDES: Readonly<Record<string, string>> = {
  sˈæskɐtʃˌuːən: 'sɐskˈætʃəwən',
  flʊɹɹˈɛsənt: 'flʊˈɹɛsənt',
}

const applyOverrides = (input: string): string => {
  let text = input
  for (const [src, dst] of Object.entries(PHONEME_OVERRIDES)) {
    text = text.split(src).join(dst)
  }
  return text.replace(/\s+/g, ' ').trim()
}

const textToTokens = (phonemeText: string): Array<number> => {
  const ids: Array<number> = []
  for (const ch of phonemeText) {
    const id = SYMBOL_TO_ID.get(ch)
    if (id === undefined) {
      continue
    }
    ids.push(id)
  }
  if (!ADD_BLANK) {
    return ids
  }
  const withBlanks = new Array<number>(ids.length * 2 + 1).fill(0)
  for (let i = 0; i < ids.length; i++) {
    withBlanks[i * 2 + 1] = ids[i] ?? 0
  }
  return withBlanks
}

const edgeFade = (samples: Float32Array, sampleRate: number, milliseconds = 5.0): Float32Array => {
  const frames = Math.min(Math.round((sampleRate * milliseconds) / 1000), Math.floor(samples.length / 2))
  if (frames <= 0) {
    return samples
  }
  const out = Float32Array.from(samples)
  for (let i = 0; i < frames; i++) {
    const ramp = i / (frames - 1)
    out[i] = (out[i] ?? 0) * ramp
    out[out.length - 1 - i] = (out[out.length - 1 - i] ?? 0) * ramp
  }
  return out
}

const mulberry32 = (seedInput: number): (() => number) => {
  let seed = seedInput
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const makeGaussian = (seed: number): (() => number) => {
  const rand = mulberry32(seed)
  let spare: number | null = null
  return () => {
    if (spare !== null) {
      const v = spare
      spare = null
      return v
    }
    let u = 0
    let v = 0
    let s = 0
    do {
      u = rand() * 2 - 1
      v = rand() * 2 - 1
      s = u * u + v * v
    } while (s >= 1 || s === 0)
    const mul = Math.sqrt((-2.0 * Math.log(s)) / s)
    spare = v * mul
    return u * mul
  }
}

const sessionsByModel = new Map<string, Promise<[ort.InferenceSession, ort.InferenceSession]>>()

/**
 * Fetches a model file manually (rather than handing the URL straight to
 * InferenceSession.create) so we can report download progress as bytes
 * arrive -- ORT's own URL-based loading gives no progress hook. Falls
 * back to the response's total size if Content-Length is missing (no
 * mid-flight progress in that case, just a jump from 0 to done).
 */
const fetchWithProgress = async (url: string, onBytes: (loaded: number, total: number) => void): Promise<Uint8Array> => {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`)
  }
  const total = Number(response.headers.get('content-length')) || 0
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    onBytes(loaded, total)
  }
  const buffer = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.length
  }
  return buffer
}

const getSessions = (
  modelKey: string,
  onProgress: (fraction: number, phase: 'downloading' | 'compiling') => void,
): Promise<[ort.InferenceSession, ort.InferenceSession]> => {
  const existing = sessionsByModel.get(modelKey)
  if (existing) {
    onProgress(1, 'compiling')
    return existing
  }
  // GitHub Pages serves this app from a /webtts-inflect/ subpath, not the
  // domain root, so model paths need Vite's configured base baked in --
  // a hardcoded leading slash would 404 there.
  const base = import.meta.env.BASE_URL
  const progressByFile = { duration: 0, decode: 0 }
  const totalByFile = { duration: 1, decode: 1 }
  const reportCombined = (): void => {
    const loaded = progressByFile.duration + progressByFile.decode
    const total = totalByFile.duration + totalByFile.decode
    // Content-Length reflects the compressed wire size when a CDN
    // (GitHub Pages/Fastly) gzips the response, but fetch's reader
    // delivers already-decompressed bytes -- so summed loaded bytes can
    // legitimately exceed that total. Clamp rather than show >100%.
    const fraction = total > 0 ? Math.min(1, loaded / total) : 0
    onProgress(fraction, 'downloading')
  }
  const created = (async (): Promise<[ort.InferenceSession, ort.InferenceSession]> => {
    // Fetching reports real byte-level progress; InferenceSession.create()
    // below (parsing + compiling the WASM graph) has no progress hook at
    // all, so that phase is reported separately -- otherwise a fast/cached
    // download (near-instant) would flash 0% and then just sit there with
    // no feedback while the (often slower, especially for decode.onnx)
    // compile step runs, looking stuck rather than genuinely working.
    const [durationBuffer, decodeBuffer] = await Promise.all([
      fetchWithProgress(`${base}${modelKey}/duration.onnx`, (loaded, total) => {
        progressByFile.duration = loaded
        totalByFile.duration = total || loaded
        reportCombined()
      }),
      fetchWithProgress(`${base}${modelKey}/decode.onnx`, (loaded, total) => {
        progressByFile.decode = loaded
        totalByFile.decode = total || loaded
        reportCombined()
      }),
    ])
    onProgress(1, 'compiling')
    return Promise.all([
      ort.InferenceSession.create(durationBuffer, { executionProviders: ['wasm'] }),
      ort.InferenceSession.create(decodeBuffer, { executionProviders: ['wasm'] }),
    ])
  })()
  sessionsByModel.set(modelKey, created)
  return created
}

// phonemizer (npm) has no equivalent of Python phonemizer's
// preserve_punctuation=True (checked its full API and bundled source: it's
// hardcoded to strip). The Python pipeline never inserts artificial
// silence for punctuation at all: it keeps punctuation characters
// literally in the phoneme string, they get tokenized as real symbol ids
// (the model's vocabulary includes ,;:.!? etc.), and the model's own
// duration predictor, trained on data where those tokens appear, produces
// the pause as a learned behavior. To match that instead of faking a
// pause: split the normalized text on punctuation ourselves, phonemize
// each piece with its mark stripped (phonemizer would strip it anyway),
// then reattach the actual character before tokenizing. Single model
// pass, real tokens, same mechanism as Python, not a synthesized silence.
const SPLIT_PUNCTUATION = new Set([',', ';', ':', '.', '!', '?'])

const splitPreservingPunctuation = (text: string): Array<string> => {
  const pieces: Array<string> = []
  let current = ''
  for (const ch of text) {
    current += ch
    if (SPLIT_PUNCTUATION.has(ch)) {
      pieces.push(current.trim())
      current = ''
    }
  }
  if (current.trim()) {
    pieces.push(current.trim())
  }
  return pieces
}

const buildPhonemeText = async (normalized: string): Promise<string> => {
  const pieces = splitPreservingPunctuation(normalized)
  const parts: Array<string> = []
  for (const piece of pieces) {
    const trailingPunct = SPLIT_PUNCTUATION.has(piece.slice(-1)) ? piece.slice(-1) : ''
    const textForPhonemizer = trailingPunct ? piece.slice(0, -1).trim() : piece
    if (!textForPhonemizer) {
      if (trailingPunct) {
        parts.push(trailingPunct)
      }
      continue
    }
    const lines = await phonemize(textForPhonemizer, 'en-us')
    parts.push(applyOverrides(lines.join(' ')) + trailingPunct)
  }
  return parts.join(' ')
}

interface SynthesisResult {
  readonly samples: Float32Array
  readonly normalizedText: string
  readonly phonemeText: string
}

const synthesizeChunk = async (
  chunkText: string,
  seed: number,
  modelKey: string,
  onProgress: (fraction: number, phase: 'downloading' | 'compiling') => void,
): Promise<SynthesisResult> => {
  // Matches the Python pipeline's order exactly: our own chunking happens
  // on raw text (main thread), then the author's normalize_text() runs
  // per chunk, then phonemization -- see
  // inflect_vits_frontend.run_vits_frontend.
  const normalized = normalizeText(chunkText)
  const phonemeText = await buildPhonemeText(normalized)

  const tokens = textToTokens(phonemeText)
  const textLen = tokens.length
  const [durationSess, decodeSess] = await getSessions(modelKey, onProgress)

  const tokensTensor = new ort.Tensor('int64', BigInt64Array.from(tokens.map(BigInt)), [1, textLen])
  const lengthsTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(textLen)]), [1])
  const lengthScaleTensor = new ort.Tensor('float32', Float32Array.from([1.0]), [])

  const durOut = await durationSess.run({
    tokens: tokensTensor,
    lengths: lengthsTensor,
    length_scale: lengthScaleTensor,
  })

  const mpExp = durOut.m_p_exp
  if (!mpExp) {
    throw new Error('duration graph did not return m_p_exp')
  }
  const mpDims = mpExp.dims
  const numel = (mpDims[0] ?? 1) * (mpDims[1] ?? 1) * (mpDims[2] ?? 1)
  const gauss = makeGaussian(seed)
  const zpNoise = new Float32Array(numel)
  for (let i = 0; i < numel; i++) {
    zpNoise[i] = gauss()
  }
  const zpNoiseTensor = new ort.Tensor('float32', zpNoise, mpDims)
  const noiseScaleTensor = new ort.Tensor('float32', Float32Array.from([0.667]), [])

  const logsPExp = durOut.logs_p_exp
  const yMask = durOut.y_mask
  if (!logsPExp || !yMask) {
    throw new Error('duration graph did not return logs_p_exp/y_mask')
  }

  const decOut = await decodeSess.run({
    m_p_exp: mpExp,
    logs_p_exp: logsPExp,
    y_mask: yMask,
    zp_noise: zpNoiseTensor,
    noise_scale: noiseScaleTensor,
  })

  const waveform = decOut.waveform
  if (!waveform) {
    throw new Error('decode graph did not return waveform')
  }
  if (!(waveform.data instanceof Float32Array)) {
    throw new Error('decode graph returned non-float32 waveform data')
  }
  const samples = edgeFade(waveform.data, SAMPLE_RATE)
  return { samples, normalizedText: normalized, phonemeText }
}

type SynthesizeRequest = {
  readonly type: 'synthesize'
  readonly id: string
  readonly text: string
  readonly seed: number
  readonly modelKey: string
}
type PreloadRequest = { readonly type: 'preload'; readonly id: string; readonly modelKey: string }
type WorkerRequest = SynthesizeRequest | PreloadRequest

// onnxruntime-web sessions aren't safe for concurrent run() calls. The
// main thread fires off all chunk requests up front (so the worker can
// start on chunk 2 the instant chunk 1 finishes, no extra round-trip
// latency), so this queue serializes handling: one synthesizeChunk() call
// fully completes before the next one starts, even though messages can
// arrive back-to-back.
let queue: Promise<void> = Promise.resolve()

// Throttled per model so a fast connection doesn't flood postMessage with
// a call per chunk of every streamed response -- only worth updating the
// UI a couple times a second. Phase changes always get through regardless
// of the byte-progress threshold, so the downloading->compiling switch is
// never swallowed by throttling.
const lastReportedProgress = new Map<string, number>()
const lastReportedPhase = new Map<string, string>()
const reportProgress = (modelKey: string, fraction: number, phase: 'downloading' | 'compiling'): void => {
  const last = lastReportedProgress.get(modelKey) ?? -1
  const phaseChanged = lastReportedPhase.get(modelKey) !== phase
  if (!phaseChanged && fraction < 1 && fraction - last < 0.02) {
    return
  }
  lastReportedProgress.set(modelKey, fraction)
  lastReportedPhase.set(modelKey, phase)
  self.postMessage({ type: 'progress', modelKey, fraction, phase })
}

const handleMessage = async (request: WorkerRequest): Promise<void> => {
  if (request.type === 'preload') {
    try {
      await getSessions(request.modelKey, (fraction, phase) => reportProgress(request.modelKey, fraction, phase))
      self.postMessage({ type: 'preloaded', id: request.id, modelKey: request.modelKey })
    } catch (error) {
      self.postMessage({ type: 'error', id: request.id, message: String(error) })
    }
    return
  }

  try {
    const t0 = performance.now()
    const result = await synthesizeChunk(request.text, request.seed, request.modelKey, (fraction, phase) =>
      reportProgress(request.modelKey, fraction, phase),
    )
    const synthMs = performance.now() - t0
    self.postMessage(
      {
        type: 'result',
        id: request.id,
        synthMs,
        samples: result.samples,
        sampleRate: SAMPLE_RATE,
        normalizedText: result.normalizedText,
        phonemeText: result.phonemeText,
      },
      { transfer: [result.samples.buffer] },
    )
  } catch (error) {
    self.postMessage({ type: 'error', id: request.id, message: String(error) })
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  queue = queue.then(() => handleMessage(event.data))
}
