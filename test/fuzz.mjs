// Round-trip fuzzer for the built bundles
//
//   npm run fuzz -- [cases] [seed] [first case]
//
// Every case derives from (seed, case number) alone, so a failure replays with
//   npm run fuzz -- 1 <seed> <case>

import * as zlib from 'node:zlib'
import { readFileSync } from 'node:fs'
import { brotliDecode } from '../dist/decode.js'
import * as withDict from '../dist/encode.js'
import * as noDict from '../dist/encode-no-dict.js'

const cases = Number(process.argv[2] ?? 2000)
const seed = Number(process.argv[3] ?? Date.now() % 1e9) >>> 0
const first = Number(process.argv[4] ?? 0)

const fixture = (name) => readFileSync(new URL(`../bench/fixtures/${name}`, import.meta.url))
const FONT = fixture('enc-ttf.bin')
const HTML = fixture('html-content.bin')

const WORDS = (
  'the of and to in is that for with as on by this be are from or have an was not ' +
  'which their has been will one all would there what about when more other time ' +
  'function return const let import export class value length index number string ' +
  '<div class=" </div> <span> </span> <a href="https:// <p> </p> <li> </li> ' +
  '{"id": "name": "type": true false null }, ], \n \n\n \t'
).split(' ')

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeCase(n) {
  const rand = mulberry32(Math.imul(seed ^ 0x9e3779b9, n + 1) ^ n)
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1))
  const pick = (list) => list[int(0, list.length - 1)]

  const quality = int(0, 11)
  const lgwin = rand() < 0.5 ? int(10, 16) : int(10, 24)

  // Zopfli is slow, so the largest sizes are left to quality 9 and below
  const sizeClass = rand()
  let size =
    sizeClass < 0.1 ? int(0, 80) :
    sizeClass < 0.5 ? int(0, 4096) :
    sizeClass < 0.85 ? int(0, 65536) :
    int(0, 1 << 20)
  if (quality >= 10) size = Math.min(size, 48 << 10)

  const segments = {
    random(out, at, len) {
      for (let i = 0; i < len; i++) out[at + i] = int(0, 255)
    },
    text(out, at, len) {
      let i = 0
      while (i < len) {
        const word = pick(WORDS) + ' '
        for (let j = 0; j < word.length && i < len; j++) out[at + i++] = word.charCodeAt(j)
      }
    },
    repeat(out, at, len) {
      const period = int(1, 64)
      for (let i = 0; i < len; i++) {
        out[at + i] = i < period || rand() < 0.002 ? int(0, 255) : out[at + i - period]
      }
    },
    fewSymbols(out, at, len) {
      const symbols = Array.from({ length: int(1, 16) }, () => int(0, 255))
      for (let i = 0; i < len; i++) out[at + i] = pick(symbols)
    },
    font(out, at, len) {
      const from = int(0, FONT.length - 1)
      for (let i = 0; i < len; i++) out[at + i] = FONT[(from + i) % FONT.length]
    },
    html(out, at, len) {
      const from = int(0, HTML.length - 1)
      for (let i = 0; i < len; i++) out[at + i] = HTML[(from + i) % HTML.length]
    },
    // Copies from anywhere earlier, for matches at long and repeated distances
    history(out, at, len) {
      if (at === 0) return segments.text(out, at, len)
      const from = int(0, at - 1)
      for (let i = 0; i < len; i++) out[at + i] = out[from + i]
    },
  }
  const kinds = Object.keys(segments)
  const kind = rand() < 0.4 ? 'mixed' : pick(kinds)

  const input = Buffer.alloc(size)
  for (let at = 0; at < size; ) {
    const len = kind === 'mixed' ? Math.min(size - at, int(1, Math.max(1, size >> 2))) : size
    segments[kind === 'mixed' ? pick(kinds) : kind](input, at, len)
    at += len
  }

  const dictionary = rand() < 0.7
  const mode = int(0, 2)
  const chunkLimit = rand() < 0.35 ? pick([16, 1024, 65536, 1 << 20]) : 0

  return { n, quality, lgwin, mode, dictionary, chunkLimit, kind, size, input, int }
}

function encode(c) {
  const lib = c.dictionary ? withDict : noDict
  const options = { quality: c.quality, lgwin: c.lgwin, mode: c.mode }
  if (c.chunkLimit === 0) return lib.brotliEncode(c.input, options)

  const encoder = new lib.BrotliEncoder(options)
  const parts = []
  for (let at = 0; at < c.size; ) {
    const len = Math.min(c.size - at, c.int(0, c.chunkLimit))
    parts.push(encoder.update(c.input.subarray(at, at + len)))
    at += len
  }
  parts.push(encoder.finish())
  return Buffer.concat(parts)
}

const same = (bytes, input) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).equals(input)

function check(c) {
  const failures = []
  const attempt = (name, run) => {
    try {
      if (!same(run(), c.input)) failures.push(`${name}: output differs`)
    } catch (err) {
      failures.push(`${name}: ${err.message}`)
    }
  }

  let encoded = null
  try {
    encoded = encode(c)
  } catch (err) {
    failures.push(`encode: ${err.message}`)
  }
  if (encoded) {
    attempt('native decode of our stream', () => zlib.brotliDecompressSync(encoded))
    attempt('our decode of our stream', () => brotliDecode(encoded))
  }

  const native = zlib.brotliCompressSync(c.input, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: c.quality,
      [zlib.constants.BROTLI_PARAM_LGWIN]: c.lgwin,
    },
  })
  attempt('our decode of native stream', () => brotliDecode(native))
  return failures
}

const started = Date.now()
let failed = 0
for (let n = first; n < first + cases; n++) {
  const c = makeCase(n)
  const failures = check(c)
  if (failures.length === 0) continue
  failed++
  const how = c.chunkLimit ? `stream chunks<=${c.chunkLimit}` : 'one-shot'
  console.log(
    `FAIL case ${n} seed ${seed}: q${c.quality} lgwin ${c.lgwin} mode ${c.mode} ` +
    `${c.dictionary ? 'dict' : 'no-dict'} ${how} ${c.kind} ${c.size} bytes`
  )
  for (const failure of failures) console.log(`  ${failure}`)
}

const seconds = ((Date.now() - started) / 1000).toFixed(1)
console.log(`${cases} cases, ${failed} failed, seed ${seed}, ${seconds} s`)
process.exit(failed ? 1 : 0)
