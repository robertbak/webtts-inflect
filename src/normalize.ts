// Port of inflect_nano_v2_frontend.py's normalize_text() and its helpers,
// the model author's own number/date/money/abbreviation expansion
// pipeline, so this app gets the same preprocessing the Python sidecar
// gets for free (by executing the author's own code directly). Pure and
// framework-agnostic: used from both the main thread (duration estimates)
// and the synthesis Worker.
import { toCardinal, toOrdinal } from 'n2words/en-US'

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const WORD_OVERRIDES: Readonly<Record<string, string>> = {
  Qwen3: 'Qwen three',
  Qwen: 'Qwen',
  PyTorch: 'pie torch',
  SQLite: 'ess cue lite',
  'USB-C': 'you ess bee see',
  'RTX 3060': 'ar tee ex thirty sixty',
  'RTX 3090': 'ar tee ex thirty ninety',
  'RTX 4090': 'ar tee ex forty ninety',
  'RTX 5080': 'ar tee ex fifty eighty',
  'RTX 5090': 'ar tee ex fifty ninety',
}

const LETTER_NAMES: Readonly<Record<string, string>> = {
  A: 'ay',
  B: 'bee',
  C: 'see',
  D: 'dee',
  E: 'ee',
  F: 'eff',
  G: 'gee',
  H: 'aitch',
  I: 'eye',
  J: 'jay',
  K: 'kay',
  L: 'ell',
  M: 'em',
  N: 'en',
  O: 'oh',
  P: 'pee',
  Q: 'cue',
  R: 'ar',
  S: 'ess',
  T: 'tee',
  U: 'you',
  V: 'vee',
  W: 'double you',
  X: 'ex',
  Y: 'why',
  Z: 'zee',
}

export const ABBREVIATIONS: Readonly<Record<string, string>> = {
  'Dr.': 'doctor',
  'Mr.': 'mister',
  'Mrs.': 'missus',
  'Ms.': 'miss',
  'Prof.': 'professor',
  'St.': 'saint',
  'vs.': 'versus',
  'etc.': 'et cetera',
  'e.g.': 'for example',
  'i.e.': 'that is',
}

const PUNCT_TRANSLATION: Readonly<Record<string, string>> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': ', ',
  '…': '...',
  '(': ', ',
  ')': ', ',
  '[': ', ',
  ']': ', ',
  '{': ', ',
  '}': ', ',
}
const PUNCT_TRANSLATION_RE = new RegExp(
  `[${Object.keys(PUNCT_TRANSLATION)
    .map(c => c.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'))
    .join('')}]`,
  'g',
)

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const words = (value: number, ordinal = false): string => {
  const text = ordinal ? toOrdinal(value) : toCardinal(value)
  return text.replace(/-/g, ' ').replace(/,/g, '')
}

const digitWords = (text: string): string =>
  [...text]
    .filter(ch => /\d/.test(ch))
    .map(ch => words(parseInt(ch, 10)))
    .join(' ')

const identifierDigits = (text: string): string => {
  const out: Array<string> = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === undefined || !/\d/.test(ch)) {
      continue
    }
    out.push(ch === '0' && i > 0 ? 'oh' : words(parseInt(ch, 10)))
  }
  return out.join(' ')
}

const expandIdentifierToken = (token: string): string => {
  const match = token.match(/^([A-Za-z]?)(\d+)([A-Za-z]?)$/)
  if (!match) {
    return token
  }
  const [, prefix, digits, suffix] = match
  const pieces: Array<string> = []
  if (prefix) {
    pieces.push(LETTER_NAMES[prefix.toUpperCase()] ?? prefix)
  }
  if (digits !== undefined) {
    if (digits.length === 3 || digits.startsWith('0')) {
      pieces.push(identifierDigits(digits))
    } else {
      pieces.push(words(parseInt(digits, 10)))
    }
  }
  if (suffix) {
    pieces.push(LETTER_NAMES[suffix.toUpperCase()] ?? suffix)
  }
  return pieces.join(' ')
}

const expandMoney = (raw: string): string => {
  const cleaned = raw.replace(/,/g, '')
  const [dollarsStr, centsStrRaw] = cleaned.split('.')
  const dollarCount = parseInt(dollarsStr ?? '0', 10)
  const parts = [words(dollarCount), dollarCount === 1 ? 'dollar' : 'dollars']
  if (centsStrRaw !== undefined && centsStrRaw.length > 0) {
    const cents = centsStrRaw.slice(0, 2).padEnd(2, '0')
    const centCount = parseInt(cents, 10)
    if (centCount) {
      parts.push('and', words(centCount), centCount === 1 ? 'cent' : 'cents')
    }
  }
  return parts.join(' ')
}

const expandDateSlash = (
  monthStr: string,
  dayStr: string,
  yearStr: string,
  full: string,
): string => {
  const month = parseInt(monthStr, 10)
  const day = parseInt(dayStr, 10)
  const year = parseInt(yearStr, 10)
  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return full
  }
  return `${MONTHS[month - 1]} ${words(day, true)} ${words(year)}`
}

const expandTime = (
  hourStr: string,
  minuteStr: string,
  suffixRaw: string | undefined,
): string => {
  const hour = parseInt(hourStr, 10)
  const minute = parseInt(minuteStr, 10)
  const pieces = [words(hour)]
  if (minute === 0) {
    pieces.push('o clock')
  } else if (minute < 10) {
    pieces.push('oh', words(minute))
  } else {
    pieces.push(words(minute))
  }
  if (suffixRaw) {
    pieces.push(...suffixRaw.toLowerCase().replace(/\./g, '').split(''))
  }
  return pieces.join(' ')
}

const expandBareHourTime = (hourStr: string, suffixRaw: string): string => {
  const hour = parseInt(hourStr, 10)
  const suffix = suffixRaw.replace(/[^A-Za-z]/g, '').toLowerCase()
  return `${words(hour)} ${suffix.split('').join(' ')}`
}

const expandVersion = (full: string): string =>
  full
    .split('.')
    .map(p => words(parseInt(p, 10)))
    .join(' point ')

const expandDecimal = (wholeStr: string, fracStr: string): string =>
  `${words(parseInt(wholeStr, 10))} point ${digitWords(fracStr)}`

const expandNumber = (full: string): string => {
  const value = full.replace(/,/g, '')
  if (value.length >= 5 && !value.startsWith('20')) {
    return digitWords(value)
  }
  return words(parseInt(value, 10))
}

const expandPhone = (leftStr: string, rightStr: string): string =>
  `${digitWords(leftStr)}, ${digitWords(rightStr)}`

const expandAcronym = (full: string): string => {
  if (full.length <= 1) {
    return full
  }
  return [...full].map(ch => LETTER_NAMES[ch] ?? ch).join(' ')
}

export const normalizeText = (input: string): string => {
  let text = input.replace(
    PUNCT_TRANSLATION_RE,
    ch => PUNCT_TRANSLATION[ch] ?? ch,
  )
  text = text.replace(/\s+/g, ' ').trim()

  for (const [src, dst] of Object.entries(WORD_OVERRIDES)) {
    text = text.replace(new RegExp(`\\b${escapeRegExp(src)}\\b`, 'g'), dst)
  }
  for (const [src, dst] of Object.entries(ABBREVIATIONS)) {
    text = text.replace(new RegExp(`\\b${escapeRegExp(src)}`, 'gi'), dst)
  }

  text = text.replace(/\b([A-Z])(?:\.([A-Z]))+\./g, full =>
    (full.match(/[A-Z]/g) ?? []).join(' '),
  )
  text = text.replace(
    /\b(apartment|apt\.?|suite|unit|room|flight|extension|order|invoice|locker|aisle|gate)\s+([A-Za-z]?\d{1,4}[A-Za-z]?)\b/gi,
    (_, label: string, ident: string) =>
      `${label} ${expandIdentifierToken(ident)}`,
  )
  text = text.replace(
    /\b(\d{3})(?=\s+(?:North|South|East|West)\b)/gi,
    (_, digits: string) => identifierDigits(digits),
  )
  text = text.replace(/\$(\d[\d,]*(?:\.\d{1,2})?)/g, (_, raw: string) =>
    expandMoney(raw),
  )
  text = text.replace(
    /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2}|19\d{2})\b/g,
    (full, month: string, day: string, year: string) =>
      expandDateSlash(month, day, year, full),
  )
  text = text.replace(
    /\b(\d{1,2}):(\d{2})\s*([AaPp]\.?\s*[Mm]\.?)?\b/g,
    (_, hour: string, minute: string, suffix: string | undefined) =>
      expandTime(hour, minute, suffix),
  )
  text = text.replace(
    /\b(\d{1,2})\s*([AaPp]\.?\s*[Mm]\.?)\b/g,
    (_, hour: string, suffix: string) => expandBareHourTime(hour, suffix),
  )
  text = text.replace(
    /\b(\d{3})-(\d{4})\b/g,
    (_, left: string, right: string) => expandPhone(left, right),
  )
  text = text.replace(/\b\d+(?:\.\d+){2,}\b/g, full => expandVersion(full))
  text = text.replace(/\b(\d+)\.(\d+)\b/g, (_, whole: string, frac: string) =>
    expandDecimal(whole, frac),
  )
  text = text.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, n: string) =>
    words(parseInt(n, 10), true),
  )
  text = text.replace(/\b\d[\d,]*\b/g, full => expandNumber(full))
  text = text.replace(/\b[A-Z]{2,}\b/g, full => expandAcronym(full))
  text = text.replace(/,(?:\s*,)+/g, ',')
  text = text.replace(/,\s*([.!?])/g, '$1')
  text = text.replace(/\s+([,;:.!?])/g, '$1')
  text = text.replace(/([,;:.!?])(?=\S)/g, '$1 ')
  return text.replace(/\s+/g, ' ').trim()
}

const CHARS_PER_SECOND = 18

/**
 * Empirically ~17-18.5 chars/sec of normalized text held steady across
 * very different content (short sentence, expanded numbers/money/time,
 * plain prose) when checked against actual synthesized durations, so it's
 * a decent buffering heuristic even though it isn't an exact predictor.
 */
export const estimateDurationSec = (normalizedText: string): number =>
  normalizedText.length / CHARS_PER_SECOND

/**
 * Blank lines (two or more trailing newlines -- a stanza/paragraph break)
 * get a longer pause on top of the punctuation-based one, the same way a
 * reader actually pauses longer between paragraphs than between sentences
 * within one. Chunk text can end with real trailing '\n's here because
 * splitSentences() attaches them rather than discarding them (see there).
 */
export const boundaryPauseSeconds = (chunk: string): number => {
  const trailingNewlines = chunk.match(/\n+$/)?.[0].length ?? 0
  const trimmed = chunk.replace(/\s+$/, '')
  const ending = trimmed.slice(-1)
  const pauseByEnding: Readonly<Record<string, number>> = {
    '?': 0.28,
    '!': 0.24,
    '.': 0.22,
    ';': 0.16,
    ':': 0.13,
    ',': 0.09,
  }
  const base = pauseByEnding[ending] ?? 0.08
  const stanzaBonus = trailingNewlines >= 2 ? 0.35 : 0
  return base + stanzaBonus
}

// Captures the separator so its newlines aren't just thrown away by
// String.split(): a sentence ending mid-line (poetry, mostly) gets a
// plain space separator here, but a sentence ending at a line break gets
// one that owns real '\n' characters -- see splitSentences below, which
// reattaches them to the sentence rather than losing them.
const SENTENCE_SPLIT_CAPTURE_RE = /((?<=[.!?;:])\s+)/

const splitSentences = (text: string): Array<string> => {
  const parts = text.split(SENTENCE_SPLIT_CAPTURE_RE)
  const naive: Array<string> = []
  // The regex's \s+ separator is greedy, so it swallows a following
  // line's leading indent along with the newline that ends the previous
  // sentence -- e.g. "worse.\n   Sounds" splits into "worse." and
  // "   Sounds" only inside the *separator* capture, never left over as
  // leading whitespace on the next sentence's own text. Carried forward
  // here so an indented line that starts a fresh chunk (any line ending
  // in punctuation) keeps its indent instead of silently losing it.
  let pendingIndent = ''
  for (let i = 0; i < parts.length; i += 2) {
    const bareText = (parts[i] ?? '')
      .replace(/^[ \t]+/, '')
      .replace(/[ \t]+$/, '')
    const sentenceText = pendingIndent + bareText
    const separator = parts[i + 1] ?? ''
    const newlineCount = (separator.match(/\n/g) ?? []).length
    pendingIndent =
      newlineCount > 0
        ? separator.slice(separator.lastIndexOf('\n') + 1).replace(/\t/g, '  ')
        : ''
    if (!sentenceText.trim()) {
      continue
    }
    naive.push(sentenceText + '\n'.repeat(newlineCount))
  }

  const abbreviationWords = new Set(
    Object.keys(ABBREVIATIONS).map(a => a.toLowerCase()),
  )
  const merged: Array<string> = []
  for (const part of naive) {
    const previous = merged.at(-1)
    if (previous !== undefined) {
      // A trailing '\n' (this sentence ends a line) leaves a trailing
      // empty string after split(/\s+/), so .at(-1) would grab that
      // instead of the actual last word -- strip it first.
      const previousWords = previous.replace(/\n+$/, '').split(/\s+/)
      const lastWord = (previousWords.at(-1) ?? '').toLowerCase()
      if (abbreviationWords.has(lastWord)) {
        // Not a real sentence end (e.g. "Dr."), so any trailing newline we
        // attached above was a false split too -- drop it before rejoining.
        merged[merged.length - 1] = `${previous.replace(/\n+$/, '')} ${part}`
        continue
      }
    }
    merged.push(part)
  }
  return merged
}

/**
 * Port of onnx_engine.py's split_text(): sentence-boundary split (with an
 * abbreviation-aware fix so "Dr. Smith" doesn't split into two chunks),
 * then hard-wrap anything still over `limit` chars at the nearest
 * punctuation or whitespace.
 */
/**
 * Collapses runs of spaces/tabs within a line, trims trailing horizontal
 * whitespace, but keeps newlines and leading indentation intact -- unlike
 * a blanket `\s+` collapse, which would flatten poetry (or anything else
 * with meaningful line breaks/indentation) into one run-on line.
 */
const normalizeWhitespace = (text: string): string =>
  text
    .split('\n')
    .map(line => {
      const leading = line.match(/^[ \t]*/)?.[0] ?? ''
      const rest = line
        .slice(leading.length)
        .replace(/[ \t]+/g, ' ')
        .trimEnd()
      return leading.replace(/\t/g, '  ') + rest
    })
    .join('\n')

export const splitText = (text: string, limit = 280): Array<string> => {
  const normalized = normalizeWhitespace(text)
  const sentences = splitSentences(normalized)
  const chunks: Array<string> = []
  for (let sentence of sentences.length > 0 ? sentences : [normalized]) {
    while (sentence.length > limit) {
      const search = sentence.slice(0, limit + 1)
      let punctuation = -1
      for (const mark of [',', ';', ':']) {
        punctuation = Math.max(punctuation, search.lastIndexOf(mark))
      }
      let splitAt =
        punctuation >= Math.floor(limit / 2)
          ? punctuation + 1
          : sentence.lastIndexOf(' ', limit)
      if (splitAt < Math.floor(limit / 2)) {
        splitAt = limit
      }
      chunks.push(sentence.slice(0, splitAt).trim())
      // Only strip leading spaces/tabs here, not a full .trim(): the
      // remainder keeps going until it's short enough to fall through to
      // the push below, so a trailing '\n'/'\n\n' that splitSentences
      // attached to mark a line/stanza end (the whole reason it's not
      // lost by String.split() in the first place) has to survive every
      // reassignment on the way there, not just the final one.
      sentence = sentence.slice(splitAt).replace(/^[ \t]+/, '')
    }
    if (sentence) {
      chunks.push(sentence)
    }
  }
  return chunks
}

export interface WordFraction {
  readonly word: string
  readonly startFraction: number
  readonly endFraction: number
}

/**
 * Approximates each word's [start, end) position within a chunk's total
 * duration, as fractions of that duration. There is no real alignment
 * data from the model (it only returns a chunk's total duration, no
 * internal timing) -- this distributes time proportionally to word length
 * plus a bit extra after punctuation, as a stand-in for the pause a real
 * speaker takes there. It won't be exact, but tracks closely enough for
 * following along, without requiring any change to the ONNX export.
 */
export const computeWordFractions = (
  chunkText: string,
): ReadonlyArray<WordFraction> => {
  const words = chunkText.split(/\s+/).filter(Boolean)
  const weights = words.map(word => {
    const bareLength = Math.max(word.replace(/[.,!?;:]+$/, '').length, 1)
    const punctuationWeight = /[.!?]$/.test(word)
      ? 3
      : /[,;:]$/.test(word)
        ? 1.5
        : 0
    return bareLength + punctuationWeight
  })
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1

  let accumulated = 0
  return words.map((word, i) => {
    const startFraction = accumulated / totalWeight
    accumulated += weights[i] ?? 0
    const endFraction = accumulated / totalWeight
    return { word, startFraction, endFraction }
  })
}

const bareWord = (word: string): string =>
  word.replace(/[.,!?;:]+$/, '').toLowerCase()

export interface DisplayWordFraction {
  readonly displayText: string
  readonly startFraction: number
  readonly endFraction: number
}

/**
 * Maps normalized-text word timing back onto the *original* typed words
 * for display -- "$42.50" instead of "forty two dollars and fifty cents".
 * normalizeText() only rewrites specific spans (numbers, dates, money,
 * abbreviations); everything else passes through untouched, so most raw
 * words match a normalized word directly. This walks both word lists in
 * parallel: on a match, advance both by one; on a mismatch (an expansion
 * happened), keep consuming normalized words -- and their combined timing
 * -- under the one raw word, until the *next* raw word matches again and
 * re-syncs the two lists. Not a real aligner, just a greedy heuristic, but
 * expansions are local enough that it holds up well in practice.
 */
export const computeDisplayWordFractions = (
  rawText: string,
  normalizedText: string,
): ReadonlyArray<DisplayWordFraction> => {
  const rawWords = rawText.split(/\s+/).filter(Boolean)
  const normFractions = computeWordFractions(normalizedText)

  const groups: Array<DisplayWordFraction> = []
  let j = 0
  for (let i = 0; i < rawWords.length; i++) {
    const rawWord = rawWords[i]
    if (rawWord === undefined) {
      continue
    }
    if (j >= normFractions.length) {
      const lastFraction = groups.at(-1)?.endFraction ?? 1
      groups.push({
        displayText: rawWord,
        startFraction: lastFraction,
        endFraction: lastFraction,
      })
      continue
    }

    const current = normFractions[j]
    if (!current) {
      continue
    }

    if (bareWord(rawWord) === bareWord(current.word)) {
      groups.push({
        displayText: rawWord,
        startFraction: current.startFraction,
        endFraction: current.endFraction,
      })
      j += 1
      continue
    }

    const nextRawBare =
      i + 1 < rawWords.length ? bareWord(rawWords[i + 1] ?? '') : undefined
    const startFraction = current.startFraction
    let endFraction = current.endFraction
    j += 1
    while (j < normFractions.length) {
      const candidate = normFractions[j]
      if (
        !candidate ||
        (nextRawBare !== undefined && bareWord(candidate.word) === nextRawBare)
      ) {
        break
      }
      endFraction = candidate.endFraction
      j += 1
    }
    groups.push({ displayText: rawWord, startFraction, endFraction })
  }
  return groups
}

export interface WordLayout {
  /** Newlines in the whitespace immediately before this word -- counted,
   * not just a boolean, so blank lines between stanzas (two newlines) get
   * two <br>s and don't collapse into one under CSS whitespace rules. */
  readonly breaksBefore: number
  /** Leading spaces on this word's line, if it's the first word on a new
   * line (0 otherwise) -- lets indentation like "The Chaos"'s indented
   * refrain lines survive into the rendered transcript. */
  readonly indent: number
}

/**
 * One entry per word in `rawText` (same split as computeDisplayWordFractions,
 * so the two line up index-for-index), describing the line break/indent
 * situation right before that word.
 */
export const computeWordLayout = (
  rawText: string,
): ReadonlyArray<WordLayout> => {
  const layout: Array<WordLayout> = []
  let searchFrom = 0
  let previousEnd = 0
  for (const word of rawText.split(/\s+/).filter(Boolean)) {
    const start = rawText.indexOf(word, searchFrom)
    const gap = rawText.slice(previousEnd, start)
    const lastNewline = gap.lastIndexOf('\n')
    // The start of rawText is a line start by definition, even with no
    // literal '\n' inside this string to find -- splitSentences() carries
    // a chunk-starting line's indent as literal leading spaces on the
    // chunk's own text (see there), with no accompanying '\n' since that
    // belongs to the *previous* chunk's trailing break count instead.
    const isLineStart = lastNewline !== -1 || previousEnd === 0
    layout.push({
      breaksBefore: (gap.match(/\n/g) ?? []).length,
      indent: isLineStart ? gap.length - (lastNewline + 1) : 0,
    })
    previousEnd = start + word.length
    searchFrom = previousEnd
  }
  return layout
}
