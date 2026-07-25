import { describe, expect, it } from 'vitest'

import { boundaryPauseSeconds, computeWordLayout, splitText } from './normalize'

describe('splitText -- newline preservation', () => {
  it('keeps a mid-sentence line break (enjambment) inside one chunk', () => {
    const chunks = splitText('Studying English pronunciation,\nI will teach you in my verse')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe('Studying English pronunciation,\nI will teach you in my verse')
  })

  it('attaches a single trailing newline to a chunk that ends a punctuated line', () => {
    const chunks = splitText('Sounds like corpse, corps, horse and worse.\nI will keep you, Susy, busy,')
    expect(chunks).toEqual(['Sounds like corpse, corps, horse and worse.\n', 'I will keep you, Susy, busy,'])
  })

  it('attaches two trailing newlines for a blank line (stanza break) between chunks', () => {
    const chunks = splitText('Sounds like corpse, corps, horse and worse.\n\nI will keep you, Susy, busy,')
    expect(chunks[0]).toBe('Sounds like corpse, corps, horse and worse.\n\n')
  })

  it('preserves indentation on a line that starts a fresh chunk', () => {
    // Only .!?;: trigger a chunk boundary (commas don't -- they'd cause
    // chunking on every clause), so the first line has to actually end a
    // sentence for this to split at all.
    const chunks = splitText('Studying English pronunciation.\n   I will teach you in my verse.')
    expect(chunks).toEqual(['Studying English pronunciation.\n', '   I will teach you in my verse.'])
  })

  it('does not attach a trailing newline for a false split at an abbreviation', () => {
    const chunks = splitText('Dr.\nSmith paid the bill.')
    expect(chunks).toEqual(['Dr. Smith paid the bill.'])
  })

  it('preserves a trailing stanza break even when the sentence gets hard-wrapped', () => {
    const longLine = 'a comma separated clause, '.repeat(15).trim()
    const chunks = splitText(`${longLine}.\n\nNext stanza starts here.`, 80)
    expect(chunks.length).toBeGreaterThan(1)
    const lastPieceOfFirstSentence = chunks[chunks.length - 2] ?? ''
    expect(lastPieceOfFirstSentence.endsWith('\n\n')).toBe(true)
  })

  it('round-trips the full "Chaos" excerpt with mixed enjambment, chunk-boundary breaks, indentation, and a stanza gap', () => {
    const input = [
      'Dearest creature in creation',
      'Studying English pronunciation,',
      '   I will teach you in my verse',
      '   Sounds like corpse, corps, horse and worse.',
      '',
      'I will keep you, Susy, busy,',
    ].join('\n')
    const chunks = splitText(input)
    expect(chunks).toEqual([
      'Dearest creature in creation\nStudying English pronunciation,\n   I will teach you in my verse\n   Sounds like corpse, corps, horse and worse.\n\n',
      'I will keep you, Susy, busy,',
    ])
  })
})

describe('boundaryPauseSeconds -- stanza gap bonus', () => {
  it('adds a bonus for a blank-line stanza break on top of the punctuation pause', () => {
    const plain = boundaryPauseSeconds('worse.')
    const withGap = boundaryPauseSeconds('worse.\n\n')
    expect(withGap).toBeGreaterThan(plain)
    expect(withGap - plain).toBeCloseTo(0.35, 5)
  })

  it('does not add the stanza bonus for a single trailing newline (ordinary line break)', () => {
    const plain = boundaryPauseSeconds('worse.')
    const withOneBreak = boundaryPauseSeconds('worse.\n')
    expect(withOneBreak).toBe(plain)
  })
})

describe('computeWordLayout -- break/indent placement', () => {
  it('places no break or indent before the first word of unbroken text', () => {
    const layout = computeWordLayout('hello there')
    expect(layout[0]).toEqual({ breaksBefore: 0, indent: 0 })
    expect(layout[1]).toEqual({ breaksBefore: 0, indent: 0 })
  })

  it('counts a mid-chunk line break and any indent on the new line', () => {
    const layout = computeWordLayout('worse.\n   Sounds like corpse')
    // words: worse. Sounds like corpse
    expect(layout[0]).toEqual({ breaksBefore: 0, indent: 0 })
    expect(layout[1]).toEqual({ breaksBefore: 1, indent: 3 })
    expect(layout[2]).toEqual({ breaksBefore: 0, indent: 0 })
  })

  it('treats a chunk that itself starts on an indented line as indented, with no newline required in its own text', () => {
    const layout = computeWordLayout('   Sounds like corpse')
    expect(layout[0]).toEqual({ breaksBefore: 0, indent: 3 })
    expect(layout[1]).toEqual({ breaksBefore: 0, indent: 0 })
  })

  it('counts a blank-line gap as two breaks', () => {
    const layout = computeWordLayout('worse.\n\nI will keep you')
    expect(layout[1]).toEqual({ breaksBefore: 2, indent: 0 })
  })
})
