import { describe, test } from 'vitest'
import * as zlib from 'node:zlib'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliEncode } from '../dist/encode.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

type FixtureName = 'enc-var-ttf' | 'noto-tc' | 'enc-ttf' | 'enc-otf' | 'mapsdatazrh'

const FIXTURE = (process.env.BENCH_FIXTURE ?? 'enc-var-ttf') as FixtureName
const INCLUDE_ZLIB = process.env.BENCH_ZLIB === '1'

function loadFixture(name: FixtureName): { label: string; data: Uint8Array } {
  // Prefer bench fixtures (binary, stable), fall back to canonical vectors.
  if (name === 'mapsdatazrh') {
    const p = join(__dirname, '..', 'test', 'fixtures', 'vectors', 'mapsdatazrh')
    const buf = readFileSync(p)
    return { label: 'mapsdatazrh (vector)', data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) }
  }

  const p = join(__dirname, 'fixtures', `${name}.bin`)
  const buf = readFileSync(p)
  return { label: `${name}.bin`, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) }
}

const { label, data } = loadFixture(FIXTURE)
const sizeLabel = data.length >= 1024 * 1024
  ? `${(data.length / 1024 / 1024).toFixed(1)} MB`
  : `${(data.length / 1024).toFixed(0)} KB`

// One-time ratio sanity (don’t benchmark zlib unless requested; it can be very slow at Q11).
const oursOnce = brotliEncode(data, { quality: 11 })
const nativeOnce = zlib.brotliCompressSync(data, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
})

console.log(`\n[encode:q11] fixture=${label} size=${sizeLabel}`)
console.log(`[encode:q11] ratio ours=${oursOnce.length} native=${nativeOnce.length} (${(oursOnce.length / nativeOnce.length).toFixed(2)}x)\n`)

describe(`quality 11 (fixture: ${label}, ${sizeLabel})`, () => {
  test('encode', async ({ bench }) => {
    const ours = bench('brotli-lib', () => {
      brotliEncode(data, { quality: 11 })
    })
    // One encode takes seconds, so the default of 64 iterations is out of reach
    const options = { iterations: 5, time: 0, warmupIterations: 1, warmupTime: 0 }
    if (!INCLUDE_ZLIB) {
      await ours.run(options)
      return
    }
    await bench.compare(ours, bench('node:zlib', () => {
      zlib.brotliCompressSync(data, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
      })
    }), options)
  })
})

