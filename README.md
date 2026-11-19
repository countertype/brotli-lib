# brotli-lib

[![npm version](https://img.shields.io/npm/v/brotli-lib)](https://www.npmjs.com/package/brotli-lib)

TypeScript Brotli encoder and decoder

## Install

```bash
npm install brotli-lib
```

## Usage

```typescript
import { brotliDecode } from 'brotli-lib/decode'

const decompressed = brotliDecode(compressed)
```

```typescript
import { brotliEncode } from 'brotli-lib/encode'

const compressed = brotliEncode(data, { quality: 11 })
```

```typescript
import { brotliEncode, brotliDecode } from 'brotli-lib'
```

```typescript
// Same encoder without the static dictionary: a third of the size
import { brotliEncode } from 'brotli-lib/encode-no-dict'
```

## API

### Decode

```typescript
function brotliDecode(
  data: Uint8Array,
  options?: { maxOutputSize?: number; customDictionary?: Uint8Array }
): Uint8Array

function brotliDecodedSize(data: Uint8Array): number  // -1 if multi-metablock
```

### Encode

```typescript
function brotliEncode(
  data: Uint8Array,
  options?: {
    quality?: number   // 0-11, default 11
    lgwin?: number     // window bits 10-24, default 22
    mode?: EncoderMode // GENERIC, TEXT, or FONT
  }
): Uint8Array

class BrotliEncoder {
  constructor(options?: BrotliEncodeOptions)
  update(chunk: Uint8Array): Uint8Array  // output ready so far, possibly empty
  finish(): Uint8Array                   // the rest of the stream
}
```

`BrotliEncoder` takes input in chunks of any size and compresses to within a fraction of a percent of `brotliEncode` at the same quality. Output is produced a metablock at a time, so `update` often returns an empty array; concatenate everything `update` and `finish` return

FONT mode uses distance coding parameters optimized for transformed font data. It doesn't improve compression on raw TTF/OTF files - the gains come from WOFF2's font-specific transforms (glyf, loca, hmtx) applied before brotli compression

## Performance

### Decode

|  | brotli-lib | brotli.js | Google decode.ts |
|--|------------|-----------|---------------|
| Speed (vs Google) | 1.3x | 0.6x | 1x |
| Custom dictionary | yes | no | yes |
| Compressed static dict | yes | yes | no |

Decode times (Apple M2 Max, Node 22):

| File | brotli-lib | brotli.js | Google decode.ts |
|------|------------|-----------|---------------|
| enc-ttf (305 KB) | 2.3 ms | 5.0 ms | 3.0 ms |
| enc-otf (253 KB) | 2.2 ms | 4.7 ms | 2.8 ms |
| enc-var-ttf (788 KB) | 5.7 ms | 12.6 ms | 7.4 ms |
| noto-tc (7 MB) | 46 ms | 99 ms | 60 ms |

2x faster than brotli.js, ~30% faster than Google's JS decoder. Node's native `zlib.brotliDecompressSync` is faster still: on these files it takes 1.4 to 1.5 ms, 3.9 ms and 33 ms, so warm decode here costs about 1.4 to 1.6 times native. The first call in a process also pays JIT warm-up (about 25 ms for a 300 KB font)

Run `npm run bench` to reproduce

### Encode

Output size and time against Node.js native `zlib.brotliCompressSync`, which is Google's C encoder, at the same quality. Size is relative to native output; negative is smaller

| Quality | Text size | Text time | Font size | Font time |
|---------|-----------|-----------|-----------|-----------|
| 2 | +0.3 to +0.5% | 3.5-4.5x | -0.7 to -0.6% | 3.5x |
| 5 | -1.7 to -1.6% | 3.5-4.5x | +0.1 to +0.9% | 3.5x |
| 9 | -1.7 to -1.6% | 3.5-4x | -5.0 to -3.6% | 6-8x |
| 11 | 0 to +0.1% | 2x | +0.3 to +0.5% | 2x |

Text is alice29.txt (149 KB) and lcet10.txt (417 KB) from the Canterbury corpus; fonts are enc-ttf and enc-otf from the decode table. Time is a multiple of native, warm, and moves by a few tenths from run to run

Absolute times at quality 11: 350 ms for alice29.txt, 1.1 s for lcet10.txt, 1.4 to 1.5 s for either font. At quality 5: 11 ms, 25 ms and 20 to 24 ms

At qualities 7 to 9 binary input gets literal context modelling that the C encoder leaves out, which is where the smaller fonts and the extra time both come from

Tiny inputs are much faster than native at any quality, since there is no binding overhead: a 13-byte input takes 0.0002 ms against 0.15 ms at quality 11. Inputs of a few KB take 0.03 to 0.08 ms at quality 5 to 9, about 2.5 to 4 times native

## Subpath exports

| Import | Export size (gzip) |
|--------|--------------------|
| `brotli-lib/decode` | 67 KB |
| `brotli-lib/encode` | 104 KB |
| `brotli-lib/encode-no-dict` | 32 KB |
| `brotli-lib` | 103 KB |

The 122 KB static dictionary is compressed to 52 KB and bootstrapped at runtime (à la Devon Govett's brotli.js). The encoder matches against the dictionary too, so `brotli-lib/encode` carries it along with the decoder that unpacks it; importing both costs nothing extra

`brotli-lib/encode-no-dict` is the same encoder and API with dictionary matching left out. Its output is ordinary brotli that any decoder reads. What it gives up, measured against `brotli-lib/encode`:

| Input | Quality 5 and 9 | Quality 11 |
|-------|-----------------|------------|
| Fonts | nothing | under 0.5% either way |
| JSON, source code | 0.2 to 1% larger | 1 to 3% larger |
| Prose | about 0.5% larger | 3.5 to 5% larger |
| Short HTML (under a few KB) | 30 to 45% larger | 55 to 75% larger |

Use it for fonts and other binary data, or wherever bundle size matters more than the last few percent. Keep the default for short text, where the dictionary does most of the work

## License

MIT

Derived from Google's [brotli](https://github.com/google/brotli) (MIT)

Maintained by [@jpt](https://github.com/jpt)
