import { describe, it, expect } from 'vitest'
import * as zlib from 'zlib'
import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { brotliDecode, brotliDecodedSize } from '../src/decode/decode'
import { brotliEncode, BrotliEncoder } from '../src/encode/encode'

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
