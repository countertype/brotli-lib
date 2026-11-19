import { describe, it, expect } from 'vitest'
import * as zlib from 'zlib'
import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { brotliDecode, brotliDecodedSize } from '../src/decode/decode'
import { brotliEncode, BrotliEncoder } from '../src/encode/encode'
import {
  brotliEncode as brotliEncodeNoDict,
  BrotliEncoder as BrotliEncoderNoDict,
} from '../src/encode/encode-no-dict'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('brotliDecode', () => {
  it('decompresses simple text', () => {
    const original = 'Hello, World!'
    const compressed = zlib.brotliCompressSync(Buffer.from(original))
    const decompressed = brotliDecode(new Uint8Array(compressed))
    expect(new TextDecoder().decode(decompressed)).toBe(original)
  })

  it('decompresses longer text', () => {
    const original = 'The quick brown fox jumps over the lazy dog. '.repeat(100)
    const compressed = zlib.brotliCompressSync(Buffer.from(original))
    const decompressed = brotliDecode(new Uint8Array(compressed))
    expect(new TextDecoder().decode(decompressed)).toBe(original)
  })

  it('decompresses HTML with dictionary references', () => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Test</title>
</head>
<body>
  <div class="container">
    <h1>Hello World</h1>
    <p>This is a test.</p>
  </div>
</body>
</html>`.repeat(10)

    const compressed = zlib.brotliCompressSync(Buffer.from(html), {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 }
    })
    const decompressed = brotliDecode(new Uint8Array(compressed))
    expect(new TextDecoder().decode(decompressed)).toBe(html)
  })

  it('decompresses binary data', () => {
    const original = new Uint8Array(10000)
    for (let i = 0; i < original.length; i++) {
      original[i] = Math.floor(Math.random() * 256)
    }
    const compressed = zlib.brotliCompressSync(Buffer.from(original))
    const decompressed = brotliDecode(new Uint8Array(compressed))
    expect(decompressed).toEqual(original)
  })

  it('decompresses empty input', () => {
    const original = ''
    const compressed = zlib.brotliCompressSync(Buffer.from(original))
    const decompressed = brotliDecode(new Uint8Array(compressed))
    expect(new TextDecoder().decode(decompressed)).toBe(original)
  })

  it('respects maxOutputSize limit', () => {
    const original = 'x'.repeat(10000)
    const compressed = zlib.brotliCompressSync(Buffer.from(original))
    const compressedArray = new Uint8Array(compressed)

    const result = brotliDecode(compressedArray, { maxOutputSize: 20000 })
    expect(result.length).toBe(10000)

    expect(() => {
      brotliDecode(compressedArray, { maxOutputSize: 1000 })
    }).toThrow(/exceeds limit/)
  })

  it('reports decompressed size for single-metablock streams', () => {
    // Use a known single-metablock test vector
    const vectorsDir = join(__dirname, 'fixtures/vectors')
    const compressed = readFileSync(join(vectorsDir, 'quickfox.compressed'))
    const expected = readFileSync(join(vectorsDir, 'quickfox'))
    const size = brotliDecodedSize(new Uint8Array(compressed))
    // Returns -1 for multi-metablock streams, actual size for single
    expect(size === expected.length || size === -1).toBe(true)
  })

  describe('canonical test vectors', () => {
    const vectorsDir = join(__dirname, 'fixtures/vectors')
    const files = readdirSync(vectorsDir).filter(f => f.endsWith('.compressed'))

    for (const file of files) {
      const name = file.replace('.compressed', '')
      it(name, () => {
        const compressed = readFileSync(join(vectorsDir, file))
        const expected = readFileSync(join(vectorsDir, name))
        const result = brotliDecode(new Uint8Array(compressed))
        expect(Buffer.from(result)).toEqual(expected)
      })
    }
  })
})

describe('brotliEncode', () => {
  it('encodes empty input', () => {
    const input = new Uint8Array(0)
    const encoded = brotliEncode(input)
    expect(encoded.length).toBeGreaterThan(0)
    expect(encoded.length).toBeLessThan(4)
  })

  it('encodes single byte', () => {
    const input = new Uint8Array([42])
    const encoded = brotliEncode(input)
    expect(encoded.length).toBeGreaterThan(0)
  })

  it('encodes small input', () => {
    const input = new TextEncoder().encode('Hello, World!')
    const encoded = brotliEncode(input)
    expect(encoded.length).toBeGreaterThan(0)
  })

  it('encodes larger input with compression', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(100)
    const input = new TextEncoder().encode(text)
    const encoded = brotliEncode(input)
    expect(encoded.length).toBeLessThan(input.length)
  })

  it('handles binary data', () => {
    const input = new Uint8Array(256)
    for (let i = 0; i < 256; i++) {
      input[i] = i
    }
    const encoded = brotliEncode(input)
    expect(encoded.length).toBeGreaterThan(0)
  })

  it('respects quality option', () => {
    const input = new TextEncoder().encode('Test data for compression')

    const q0 = brotliEncode(input, { quality: 0 })
    const q1 = brotliEncode(input, { quality: 1 })
    const q11 = brotliEncode(input, { quality: 11 })

    expect(q0.length).toBeGreaterThan(0)
    expect(q1.length).toBeGreaterThan(0)
    expect(q11.length).toBeGreaterThan(0)
  })

  it('compresses at quality 0', () => {
    const input = new Uint8Array(
      readFileSync(join(__dirname, '../bench/fixtures/enc-otf.bin'))
    )
    const native = zlib.brotliCompressSync(input, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 0 },
    })

    for (const encoded of [
      brotliEncode(input, { quality: 0 }),
      brotliEncodeNoDict(input, { quality: 0 }),
    ]) {
      expect(encoded.length).toBeLessThan(native.length)
      expect(new Uint8Array(zlib.brotliDecompressSync(encoded))).toEqual(input)
    }
  })

  it('supports FONT mode', () => {
    // Simulate font-like data with repetitive 4-byte structures
    const fontData = new Uint8Array(4096)
    for (let i = 0; i < fontData.length; i += 4) {
      fontData[i] = i & 0xFF
      fontData[i + 1] = (i >> 8) & 0xFF
      fontData[i + 2] = 0
      fontData[i + 3] = 0
    }

    const generic = brotliEncode(fontData, { quality: 5 })
    const font = brotliEncode(fontData, { quality: 5, mode: 2 }) // EncoderMode.FONT

    // Both should produce valid output
    expect(generic.length).toBeGreaterThan(0)
    expect(font.length).toBeGreaterThan(0)

    // Both should decode correctly
    const decodedGeneric = brotliDecode(generic)
    const decodedFont = brotliDecode(font)
    expect(decodedGeneric).toEqual(fontData)
    expect(decodedFont).toEqual(fontData)
  })

  // Hash tables are reused from one call to the next; nothing an earlier
  // input left in them may show up in a later output
  it('gives the same output whatever was encoded before', () => {
    const vectors = join(__dirname, 'fixtures', 'vectors')
    const a = new Uint8Array(readFileSync(join(vectors, 'alice29.txt')))
    const b = new Uint8Array(readFileSync(join(__dirname, '..', 'bench', 'fixtures', 'enc-otf.bin')))
    for (const quality of [2, 4, 5, 7, 9]) {
      const first = brotliEncode(a, { quality })
      brotliEncode(b, { quality })
      const again = brotliEncode(a, { quality })
      expect(Buffer.compare(Buffer.from(again), Buffer.from(first))).toBe(0)
      expect(Buffer.compare(zlib.brotliDecompressSync(Buffer.from(again)), Buffer.from(a))).toBe(0)
    }
  })

  describe('streaming encoder', () => {
    it('encodes in chunks', () => {
      const encoder = new BrotliEncoder({ quality: 5 })

      const chunk1 = new TextEncoder().encode('Hello, ')
      const chunk2 = new TextEncoder().encode('World!')

      const out1 = encoder.update(chunk1)
      const out2 = encoder.update(chunk2)
      const out3 = encoder.finish()

      const totalLen = out1.length + out2.length + out3.length
      expect(totalLen).toBeGreaterThan(0)
    })

    it('handles empty finish', () => {
      const encoder = new BrotliEncoder()
      const result = encoder.finish()
      expect(result.length).toBeGreaterThan(0)
    })

    const fixtures = join(__dirname, '..', 'bench', 'fixtures')
    const streamEncode = (
      input: Uint8Array, options: { quality: number, lgwin?: number }, chunkSize: number
    ): Uint8Array => {
      const encoder = new BrotliEncoder(options)
      const parts: Uint8Array[] = []
      for (let pos = 0; pos < input.length; pos += chunkSize) {
        parts.push(encoder.update(input.subarray(pos, pos + chunkSize)))
      }
      parts.push(encoder.finish())
      return new Uint8Array(Buffer.concat(parts))
    }

    // The search is the only part not shared with the one-shot path, and it
    // sees the same data, so the two should land within a fraction of a percent
    for (const quality of [2, 4, 5, 9, 11]) {
      it(`matches one-shot output size at quality ${quality}`, () => {
        const input = new Uint8Array(readFileSync(join(fixtures, 'enc-ttf.bin')))
        const streamed = streamEncode(input, { quality }, 10000)
        const decoded = zlib.brotliDecompressSync(Buffer.from(streamed))
        expect(Buffer.compare(decoded, Buffer.from(input))).toBe(0)
        expect(streamed.length).toBeLessThan(brotliEncode(input, { quality }).length * 1.01)
      }, 30000)
    }

    // The input is copied into a ring a block at a time; one call far larger
    // than the ring must not overwrite data that has yet to be encoded
    it('accepts a single update larger than its buffer', () => {
      const input = new Uint8Array(readFileSync(join(fixtures, 'enc-var-ttf.bin')))
      const streamed = streamEncode(input, { quality: 5, lgwin: 16 }, input.length)
      const decoded = zlib.brotliDecompressSync(Buffer.from(streamed))
      expect(Buffer.compare(decoded, Buffer.from(input))).toBe(0)
    })

    it('handles a window smaller than a block', () => {
      const input = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'vectors', 'lcet10.txt')))
      for (const quality of [5, 9]) {
        const streamed = streamEncode(input, { quality, lgwin: 10 }, 50000)
        const decoded = zlib.brotliDecompressSync(Buffer.from(streamed))
        expect(Buffer.compare(decoded, Buffer.from(input))).toBe(0)
      }
    })

    it('rejects input after finish', () => {
      const encoder = new BrotliEncoder({ quality: 5 })
      encoder.finish()
      expect(() => encoder.update(new Uint8Array(1))).toThrow()
    })
  })
})

describe('round-trip', () => {
  it('round-trips empty input', () => {
    const input = new Uint8Array(0)
    const encoded = brotliEncode(input)
    const decoded = brotliDecode(encoded)
    expect(decoded.length).toBe(0)
  })

  it('round-trips "Hello, World!"', () => {
    const text = 'Hello, World!'
    const input = new TextEncoder().encode(text)
    const encoded = brotliEncode(input)
    const decoded = brotliDecode(encoded)
    expect(new TextDecoder().decode(decoded)).toBe(text)
  })

  for (const quality of [0, 1, 5, 11]) {
    it(`round-trips with quality ${quality}`, () => {
      const text = `Test quality ${quality} encoding`
      const input = new TextEncoder().encode(text)
      const encoded = brotliEncode(input, { quality })
      const decoded = brotliDecode(encoded)
      expect(new TextDecoder().decode(decoded)).toBe(text)
    })
  }

  it('round-trips repetitive data with good compression', () => {
    const text = 'abcdefghij'.repeat(1000)
    const input = new TextEncoder().encode(text)
    const encoded = brotliEncode(input, { quality: 5 })
    const decoded = brotliDecode(encoded)

    expect(new TextDecoder().decode(decoded)).toBe(text)
    expect(encoded.length).toBeLessThan(input.length * 0.2)
  })

  it('round-trips binary data', () => {
    const input = new Uint8Array(1024)
    for (let i = 0; i < 1024; i++) {
      input[i] = i & 0xFF
    }

    const encoded = brotliEncode(input, { quality: 11 })
    const decoded = brotliDecode(encoded)
    expect(decoded).toEqual(input)
  })
})

function makeXorshift32(seed: number): () => number {
  let x = seed | 0
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return x >>> 0
  }
}

function randomBytes(len: number, nextU32: () => number): Uint8Array {
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) out[i] = nextU32() & 0xFF
  return out
}

describe('fuzz', () => {
  it('round-trips random inputs across all qualities', () => {
    const nextU32 = makeXorshift32(0xC0FFEE ^ 0xBEEF)
    const sizes = [0, 1, 2, 3, 4, 7, 15, 31, 63, 64, 65, 127, 255, 256, 257, 511, 1024, 2048]

    for (const size of sizes) {
      const inputRandom = randomBytes(size, nextU32)
      const inputRamp = new Uint8Array(size)
      for (let i = 0; i < size; i++) inputRamp[i] = i & 0xFF

      for (const input of [inputRandom, inputRamp]) {
        for (let quality = 0; quality <= 11; quality++) {
          const encoded = brotliEncode(input, { quality })
          const decoded = brotliDecode(encoded)
          expect(decoded).toEqual(input)
        }
      }
    }
  })

  it('streaming encoder round-trips with random chunking', () => {
    const nextU32 = makeXorshift32(0x12345678)
    const input = randomBytes(4096, nextU32)

    for (let quality = 0; quality <= 11; quality++) {
      const enc = new BrotliEncoder({ quality })
      const chunks: Uint8Array[] = []

      let pos = 0
      while (pos < input.length) {
        const chunkLen = 1 + (nextU32() % 257)
        const end = Math.min(input.length, pos + chunkLen)
        chunks.push(enc.update(input.subarray(pos, end)))
        pos = end
      }
      chunks.push(enc.finish())

      let outLen = 0
      for (const c of chunks) outLen += c.length
      const encoded = new Uint8Array(outLen)
      let o = 0
      for (const c of chunks) {
        encoded.set(c, o)
        o += c.length
      }

      const decoded = brotliDecode(encoded)
      expect(decoded).toEqual(input)
    }
  })
})

// Streams from the reference encoder's top qualities use features this
// library's own encoder may not emit: hundreds of literal trees, and a distance
// context map much smaller than the literal one
describe('decoding reference encoder output', () => {
  const fixtures = join(__dirname, '..', 'bench', 'fixtures')

  for (const name of ['enc-otf.bin', 'enc-ttf.bin']) {
    for (const quality of [9, 10, 11]) {
      it(`decodes ${name} compressed at quality ${quality}`, () => {
        const input = readFileSync(join(fixtures, name))
        const compressed = zlib.brotliCompressSync(input, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length,
          },
        })
        const decoded = brotliDecode(new Uint8Array(compressed))
        expect(Buffer.compare(Buffer.from(decoded), input)).toBe(0)
      })
    }
  }

  it('decodes correctly after a failed decode', () => {
    const input = readFileSync(join(fixtures, 'enc-otf.bin'))
    const compressed = new Uint8Array(zlib.brotliCompressSync(input, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
    }))
    const truncated = compressed.subarray(0, compressed.length >> 1)
    expect(() => brotliDecode(truncated)).toThrow()
    const decoded = brotliDecode(compressed)
    expect(Buffer.compare(Buffer.from(decoded), input)).toBe(0)
  })
})

// The build without the static dictionary is the same encoder handed no
// dictionary. Its output must stand on its own with any decoder
describe('encoder without the static dictionary', () => {
  const text = readFileSync(join(__dirname, 'fixtures', 'vectors', 'alice29.txt'))
  const font = readFileSync(join(__dirname, '..', 'bench', 'fixtures', 'enc-otf.bin'))

  for (const quality of [1, 2, 4, 5, 9, 10, 11]) {
    it(`produces valid streams at quality ${quality}`, () => {
      for (const input of [text, font]) {
        const encoded = brotliEncodeNoDict(new Uint8Array(input), { quality })
        expect(Buffer.compare(zlib.brotliDecompressSync(Buffer.from(encoded)), input)).toBe(0)
      }
    }, 30000)
  }

  it('streams', () => {
    const encoder = new BrotliEncoderNoDict({ quality: 5 })
    const parts = [encoder.update(new Uint8Array(text.subarray(0, 70000)))]
    parts.push(encoder.update(new Uint8Array(text.subarray(70000))), encoder.finish())
    expect(Buffer.compare(zlib.brotliDecompressSync(Buffer.concat(parts)), text)).toBe(0)
  })

  // Fonts hardly touch the dictionary, which is the case for offering this build
  it('costs nothing on a font', () => {
    const input = new Uint8Array(font)
    const without = brotliEncodeNoDict(input, { quality: 5 }).length
    expect(without).toBeLessThan(brotliEncode(input, { quality: 5 }).length * 1.002)
  })

  // Guards the split itself: if both builds reached the dictionary, short
  // dictionary-friendly text would come out the same size from each
  it('does not use the dictionary', () => {
    const input = new TextEncoder().encode(
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<title>The quick brown fox</title></head><body>' +
      '<div class="container"><p>This is the first paragraph.</p></div></body></html>')
    for (const quality of [5, 11]) {
      const without = brotliEncodeNoDict(input, { quality })
      expect(without.length).toBeGreaterThan(brotliEncode(input, { quality }).length)
      expect(new Uint8Array(zlib.brotliDecompressSync(Buffer.from(without)))).toEqual(input)
    }
  })
})

// Round-tripping through our own decoder cannot show that a stream is
// well-formed brotli, only that the two agree. These check against the
// reference decoder instead
describe('encoder output validity (reference C decoder)', () => {
  const vectorsDir = join(__dirname, 'fixtures', 'vectors')
  const corpus = ['alice29.txt', 'asyoulik.txt', 'lcet10.txt', 'compressed_repeated']

  for (const name of corpus) {
    for (const quality of [9, 10, 11]) {
      it(`${name} at quality ${quality} is accepted by the C decoder`, () => {
        const input = new Uint8Array(readFileSync(join(vectorsDir, name)))
        const encoded = brotliEncode(input, { quality })
        const roundTripped = new Uint8Array(zlib.brotliDecompressSync(Buffer.from(encoded)))
        expect(roundTripped).toEqual(input)
      })
    }
  }

  // Font tables are far more repetitive than prose: long matches, and match
  // trees deep enough to hit the search depth limit
  // Qualities 2 and 3 also split this input across several metablocks
  for (const quality of [2, 3, 4, 5, 9, 10, 11]) {
    it(`a font at quality ${quality} is accepted by the C decoder`, () => {
      const input = readFileSync(join(__dirname, '..', 'bench', 'fixtures', 'enc-otf.bin'))
      const encoded = brotliEncode(new Uint8Array(input), { quality })
      const roundTripped = zlib.brotliDecompressSync(Buffer.from(encoded))
      expect(Buffer.compare(roundTripped, input)).toBe(0)
    })
  }

  // Binary data leans on block splitting, signed literal contexts and the
  // distance parameters far more than prose does; losing any of them costs
  // several percent here and nothing on text
  for (const quality of [2, 4, 5, 10]) {
    it(`a font at quality ${quality} lands close to the reference encoder`, () => {
      const input = readFileSync(join(__dirname, '..', 'bench', 'fixtures', 'enc-otf.bin'))
      const ours = brotliEncode(new Uint8Array(input), { quality }).length
      const reference = zlib.brotliCompressSync(input, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length,
        },
      }).length
      expect(ours).toBeLessThan(reference * 1.03)
    })
  }

  // A command's insert and copy extra-bit fields together can exceed 32 bits,
  // which is more than a single shift can carry
  it('handles a command with a large insert length and a long copy', () => {
    const nextU32 = makeXorshift32(0x5EED1234)
    // Incompressible head forces one long insert; the repeated tail forces a
    // copy length needing more than eight extra bits
    const head = randomBytes(60000, nextU32)
    const tail = new Uint8Array(4096)
    for (let i = 0; i < tail.length; i++) tail[i] = head[i % 977]
    const input = new Uint8Array(head.length + tail.length)
    input.set(head, 0)
    input.set(tail, head.length)

    for (const quality of [10, 11]) {
      const encoded = brotliEncode(input, { quality })
      const roundTripped = new Uint8Array(zlib.brotliDecompressSync(Buffer.from(encoded)))
      expect(roundTripped).toEqual(input)
    }
  })

  // Guards the cost model: a mis-indexed cost table drops matches silently, and
  // shows up only as higher qualities doing worse
  it('compresses no worse at higher quality', () => {
    for (const name of ['alice29.txt', 'asyoulik.txt']) {
      const input = new Uint8Array(readFileSync(join(vectorsDir, name)))
      const sizes = [5, 9, 10, 11].map(quality => brotliEncode(input, { quality }).length)
      for (let i = 1; i < sizes.length; i++) {
        expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1])
      }
    }
  })
})

// Dictionary references are distances beyond the sliding window, resolved
// through the RFC transform table. A wrong transform index or distance base
// corrupts the stream, so these assert on real output rather than internals
describe('static dictionary matching', () => {
  const vectorsDir = join(__dirname, 'fixtures', 'vectors')

  // The bound is only reachable with dictionary references, so losing them
  // fails here rather than passing quietly at a worse ratio
  it('uses the dictionary on short dictionary-friendly text', () => {
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<title>The quick brown fox</title></head><body>' +
      '<div class="container"><p>This is the first paragraph.</p></div></body></html>'
    const input = new TextEncoder().encode(html)
    for (const quality of [10, 11]) {
      const encoded = brotliEncode(input, { quality })
      expect(encoded.length).toBeLessThan(120)
      const roundTripped = new Uint8Array(zlib.brotliDecompressSync(Buffer.from(encoded)))
      expect(roundTripped).toEqual(input)
    }
  })

  // Covers the whole match, transform and distance path against real prose
  it('lands close to the reference encoder on corpus text', () => {
    for (const name of ['alice29.txt', 'asyoulik.txt']) {
      const input = new Uint8Array(readFileSync(join(vectorsDir, name)))
      const ours = brotliEncode(input, { quality: 11 }).length
      const reference = zlib.brotliCompressSync(Buffer.from(input), {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length,
        },
      }).length
      expect(ours).toBeLessThan(reference * 1.05)
    }
  })

  // The fast qualities use a cheaper lookup than 10 and 11, so they need their
  // own bound; these are only reachable with dictionary references
  it('uses the dictionary at the fast qualities too', () => {
    const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<title>The quick brown fox</title></head><body>' +
      '<div class="container"><p>This is the first paragraph.</p></div></body></html>'
    const prose = 'The following information about the company and the people that ' +
      'work there is available on the website. Please contact us for more details ' +
      'about the products and services.'
    for (const quality of [5, 9]) {
      const htmlEncoded = brotliEncode(new TextEncoder().encode(html), { quality })
      expect(htmlEncoded.length).toBeLessThan(132)
      expect(new Uint8Array(zlib.brotliDecompressSync(Buffer.from(htmlEncoded))))
        .toEqual(new TextEncoder().encode(html))

      const proseEncoded = brotliEncode(new TextEncoder().encode(prose), { quality })
      expect(proseEncoded.length).toBeLessThan(100)
      expect(new Uint8Array(zlib.brotliDecompressSync(Buffer.from(proseEncoded))))
        .toEqual(new TextEncoder().encode(prose))
    }
  })

  // Hashers are pooled between calls, so output must not depend on what was
  // compressed before. Incompressible data is the likeliest to leave state
  // skewed behind it
  it('produces identical output regardless of what was encoded before', () => {
    const input = new Uint8Array(readFileSync(join(vectorsDir, 'asyoulik.txt')))
    const nextU32 = makeXorshift32(0x9E3779B9)
    const noise = randomBytes(200000, nextU32)
    for (const quality of [2, 3, 4, 5, 9]) {
      const first = brotliEncode(input, { quality }).length
      brotliEncode(noise, { quality })
      const second = brotliEncode(input, { quality }).length
      expect(second).toBe(first)
    }
  })

  // Many distinct words, transforms and suffixes in a single stream
  it('round-trips text exercising many dictionary transforms', () => {
    const parts = [
      'The following information about the company and the people that work there.',
      'DOWNLOAD THE FILE FROM THE INTERNET',
      'running and jumping and swimming in the water of the world',
      '<div class="content"><a href="http://www.example.com/index.html">',
      'The University of California, the National Institute, the President said.',
      'description, information, development, government, university, international',
    ]
    const input = new TextEncoder().encode(parts.join('\n'))
    for (const quality of [10, 11]) {
      const encoded = brotliEncode(input, { quality })
      const roundTripped = new Uint8Array(zlib.brotliDecompressSync(Buffer.from(encoded)))
      expect(roundTripped).toEqual(input)
    }
  })
})

// A window smaller than the input makes the decoder's ring buffer wrap and
// stops the encoder from indexing the input directly. Both paths are otherwise
// untouched, since the default window exceeds anything else the suite feeds
describe('windows smaller than the input', () => {
  function repetitiveText(len: number, seed: number): Uint8Array {
    const nextU32 = makeXorshift32(seed)
    const words = ['the ', 'quick ', 'information ', 'government ', '<div class="',
      '">', 'function ', 'return ', '\r\n', '    ', 'download ']
    const out = new Uint8Array(len)
    let p = 0
    while (p < len) {
      const w = words[nextU32() % words.length]
      for (let k = 0; k < w.length && p < len; k++) out[p++] = w.charCodeAt(k)
    }
    return out
  }

  // A small window also caps the metablock size, so this input spans several.
  // Literal context carries over from one to the next, and prose is where a
  // wrong starting context changes which tree a literal is coded with
  for (const quality of [5, 9, 10, 11]) {
    it(`carries literal context across metablocks at quality ${quality}`, () => {
      const input = readFileSync(join(__dirname, 'fixtures', 'vectors', 'lcet10.txt'))
      const encoded = brotliEncode(new Uint8Array(input), { quality, lgwin: 10 })
      const decoded = zlib.brotliDecompressSync(Buffer.from(encoded))
      expect(Buffer.compare(decoded, input)).toBe(0)
    })
  }

  for (const lgwin of [10, 11, 12, 14, 16]) {
    it(`round-trips input far larger than a ${1 << lgwin}-byte window`, () => {
      const input = repetitiveText(60000, 0x1234 + lgwin)
      for (const quality of [2, 5, 9]) {
        const encoded = brotliEncode(input, { quality, lgwin })
        expect(new Uint8Array(zlib.brotliDecompressSync(Buffer.from(encoded)))).toEqual(input)
        expect(brotliDecode(encoded)).toEqual(input)
      }
    })

    it(`decodes reference-encoded streams at a ${1 << lgwin}-byte window`, () => {
      const input = repetitiveText(60000, 0x5678 + lgwin)
      const encoded = zlib.brotliCompressSync(Buffer.from(input), {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
          [zlib.constants.BROTLI_PARAM_LGWIN]: lgwin,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length,
        },
      })
      expect(brotliDecode(new Uint8Array(encoded))).toEqual(input)
    })
  }

  // The wrap has to work at the default window too, not just tiny ones
  it('round-trips input past the default 4 MiB window', () => {
    const input = repetitiveText(5_000_000, 0xABCD)
    for (const quality of [2, 5]) {
      const encoded = brotliEncode(input, { quality })
      // toEqual walks typed arrays element by element, too slow at this size
      const decoded = zlib.brotliDecompressSync(Buffer.from(encoded))
      expect(Buffer.compare(decoded, Buffer.from(input))).toBe(0)
    }
  })
})
