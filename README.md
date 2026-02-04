# brotli-lib

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
  update(chunk: Uint8Array): void
  finish(): Uint8Array
}
```

## Performance

### Decode

|  | brotli-lib | brotli.js | Google decode.ts |
|--|------------|-----------|---------------|
| Speed (vs Google) | 1.0x | 0.5-0.6x | 1x |
| Custom dictionary | yes | no | yes |
| Compressed static dict | yes | yes | no |

Decode times (Apple M2 Max, Node 22):

| File | brotli-lib | brotli.js | Google decode.ts |
|------|------------|-----------|---------------|
| enc-ttf (305 KB) | 3.0 ms | 5.2 ms | 3.1 ms |
| enc-otf (253 KB) | 3.0 ms | 5.2 ms | 3.1 ms |
| enc-var-ttf (788 KB) | 7.5 ms | 13.8 ms | 7.8 ms |
| noto-tc (7 MB) | 61 ms | 106 ms | 63 ms |

1.7x faster than brotli.js, on par with or slightly faster than Google's JS decoder

### Encode

Encoder vs Node.js native `zlib.brotliCompressSync` (quality 11):

| Input | brotli-lib | node:zlib | vs native |
|-------|-----------|-----------|-----------|
| 13 B | 0.001 ms | 0.16 ms | 160x faster |
| 4.5 KB | 0.27 ms | 0.33 ms | 1.2x faster |
| 45 KB | 3.0 ms | 1.4 ms | 2x slower |

Much faster for tiny inputs (no native binding overhead), faster for medium, ~2x slower for large

Run `npm run bench` to reproduce

## Subpath exports

| Import | Export size (gzip) |
|--------|--------------------|
| `brotli-lib/encode` | 25 KB |
| `brotli-lib/decode` | 66 KB |
| `brotli-lib` | 90 KB |

The 122 KB static dictionary is compressed to 52 KB and bootstrapped at runtime (à la Devon Govett's brotli.js).

## License

MIT

Derived from Google's [brotli](https://github.com/google/brotli) (MIT)

Maintained by [@jpt](https://github.com/jpt)
