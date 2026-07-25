# Inflect TTS -- entirely in-browser

A text-to-speech app that runs completely client-side: [ONNX Runtime Web](https://github.com/microsoft/onnxruntime)
for the [Inflect-Nano-v2](https://huggingface.co/owensong/Inflect-Nano-v2) / [Inflect-Micro-v2](https://huggingface.co/owensong/Inflect-Micro-v2)
VITS-style models, and [espeak-ng](https://github.com/espeak-ng/espeak-ng) compiled to WASM (via
[`phonemizer`](https://www.npmjs.com/package/phonemizer)) for phonemization. There's no server round-trip for
synthesis -- once the page and model weights are loaded, everything runs locally, including offline.

**All credit for the actual text-to-speech models goes to [owensong](https://huggingface.co/owensong)** --
this app is just a client-side runner built around their work. Inflect-Nano-v2 and Inflect-Micro-v2 are tiny,
fast, genuinely good-sounding VITS-style models, and the text normalization this app uses (numbers, dates,
money, abbreviations) is a direct port of their own Python frontend. Go check out their
[Inflect-Nano-v2](https://huggingface.co/owensong/Inflect-Nano-v2) and
[Inflect-Micro-v2](https://huggingface.co/owensong/Inflect-Micro-v2) model cards.

Built with [Foldkit](https://foldkit.dev) (an Elm-architecture framework on top of [Effect-TS](https://effect.website)).

## Features

- Streams playback while synthesizing: each chunk predicts the next chunk's synthesis time from its own
  just-measured speed, and only waits when there's a real risk of an audible gap.
- A separate "Generate" mode synthesizes the whole text up front and only starts playback once everything's
  ready -- gapless, at the cost of upfront latency.
- Word-level playback highlighting, approximated by distributing each chunk's measured duration across its
  words (the model doesn't return real alignment data).
- Text normalization (numbers, dates, money, abbreviations) ported from
  [owensong](https://huggingface.co/owensong)'s own Python frontend, with the original typed text (not the
  expanded form) shown during highlighting.
- Preserves line breaks and indentation in the transcript, so poetry and other structured text render as typed.
- Replay re-runs playback against already-synthesized audio instantly, no re-synthesis.

## Getting started

```bash
npm install
npm run dev
```

Multi-threaded WASM (faster synthesis) requires cross-origin isolation (COOP/COEP headers). `npm run dev` and
`npm run preview` don't set these by default; `public/coi-serviceworker.js` (MIT, gzuidhof/coi-serviceworker)
is included so it also works on static hosts like GitHub Pages that can't set custom response headers.

## Scripts

- `npm run dev` -- start the Vite dev server
- `npm run build` -- production build
- `npm run typecheck` -- `tsc --noEmit`
- `npm run lint` -- oxlint

## License

Apache-2.0 for this app's own code -- see [LICENSE](./LICENSE).

Bundled third-party components keep their own licenses: `phonemizer` (MIT) bundles espeak-ng (GPL-3.0) as WASM
data; ONNX Runtime Web, Effect, Foldkit, and n2words are MIT; `public/coi-serviceworker.js` is MIT. Model
weights in `public/nano` and `public/micro` are from
[owensong/Inflect-Nano-v2](https://huggingface.co/owensong/Inflect-Nano-v2) and
[owensong/Inflect-Micro-v2](https://huggingface.co/owensong/Inflect-Micro-v2) -- see their model cards for
license terms.
