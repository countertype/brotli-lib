// Decode benchmark with statistical significance testing (Welch's t-test)
// Usage: npm run bench
//        BENCH_SAMPLES=50 npm run bench
import { bench, describe } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { brotliDecode } from '../src/decode/decode'
const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

let originalDecompress: ((buf: Buffer) => Uint8Array) | null = null
try {
  originalDecompress = require('brotli/decompress')
} catch {
  console.log('[bench] brotli.js not available')
}

let googleDecompress: ((buf: Uint8Array) => Uint8Array) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = await import('./vendor/brotli/js/decode.js') as any
  const BrotliDecode = mod.BrotliDecode as (input: Int8Array) => Int8Array
  googleDecompress = (buf: Uint8Array): Uint8Array => {
    const input = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    const result = BrotliDecode(input)
    return new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
  }
} catch {
  console.log('[bench] Google brotli decoder not available (run: git submodule update --init)')
}

const fixturesPath = join(__dirname, 'fixtures')

const SAMPLE_COUNT = Number(process.env.BENCH_SAMPLES ?? '25')
const WARMUP_COUNT = Number(process.env.BENCH_WARMUP ?? '10')
const ALPHA = Number(process.env.BENCH_ALPHA ?? '0.05')

interface Fixture {
  name: string
  compressed: Uint8Array
  originalSize: number
}

const fixtures: Fixture[] = []
const fixtureNames = ['enc-ttf', 'enc-otf', 'enc-var-ttf', 'noto-tc', 'html-content', 'random-binary']

for (const name of fixtureNames) {
  const brPath = join(fixturesPath, `${name}.br`)
  const binPath = join(fixturesPath, `${name}.bin`)
  if (!existsSync(brPath)) continue
  fixtures.push({
    name,
    compressed: new Uint8Array(readFileSync(brPath)),
    originalSize: existsSync(binPath) ? readFileSync(binPath).length : 0,
  })
}

if (fixtures.length === 0) {
  console.log('\n[bench] No fixtures! Run: npx tsx bench/create-fixtures.ts\n')
}

console.log(`\n[bench] samples=${SAMPLE_COUNT} warmup=${WARMUP_COUNT} alpha=${ALPHA}`)
console.log(`[bench] brotli.js: ${originalDecompress ? 'yes' : 'no'}`)
console.log(`[bench] google brotli: ${googleDecompress ? 'yes' : 'no'}`)
console.log(`[bench] fixtures: ${fixtures.map(f => f.name).join(', ')}\n`)

// Statistical comparison
if (originalDecompress) {
  console.log('=== brotli-lib vs brotli.js ===')
  for (const fixture of fixtures) {
    const ours = collectSamples(() => brotliDecode(fixture.compressed), WARMUP_COUNT, SAMPLE_COUNT)
    const buffer = Buffer.from(fixture.compressed)
    const theirs = collectSamples(() => originalDecompress!(buffer), WARMUP_COUNT, SAMPLE_COUNT)
    printComparison(fixture.name, ours, theirs, 'brotli.js')
  }
}

if (googleDecompress) {
  console.log('\n=== brotli-lib vs Google brotli decoder ===')
  for (const fixture of fixtures) {
    const ours = collectSamples(() => brotliDecode(fixture.compressed), WARMUP_COUNT, SAMPLE_COUNT)
    const theirs = collectSamples(() => googleDecompress!(fixture.compressed), WARMUP_COUNT, SAMPLE_COUNT)
    printComparison(fixture.name, ours, theirs, 'google')
  }
}

console.log('')

// Vitest benchmarks
describe('brotli-lib decode', () => {
  for (const fixture of fixtures) {
    const sizeLabel = fixture.originalSize > 1024 * 1024
      ? `${(fixture.originalSize / 1024 / 1024).toFixed(1)} MB`
      : `${(fixture.originalSize / 1024).toFixed(0)} KB`
    bench(`${fixture.name} (${sizeLabel})`, () => {
      brotliDecode(fixture.compressed)
    })
  }
})

if (originalDecompress) {
  describe('brotli.js', () => {
    for (const fixture of fixtures) {
      const buffer = Buffer.from(fixture.compressed)
      const sizeLabel = `${(fixture.originalSize / 1024).toFixed(0)} KB`
      bench(`${fixture.name} (${sizeLabel})`, () => {
        originalDecompress!(buffer)
      })
    }
  })
}

if (googleDecompress) {
  describe('google brotli', () => {
    for (const fixture of fixtures) {
      const sizeLabel = `${(fixture.originalSize / 1024).toFixed(0)} KB`
      bench(`${fixture.name} (${sizeLabel})`, () => {
        googleDecompress!(fixture.compressed)
      })
    }
  })
}

// Stats helpers
function collectSamples(fn: () => void, warmup: number, samples: number): number[] {
  for (let i = 0; i < warmup; i++) fn()
  const data: number[] = []
  for (let i = 0; i < samples; i++) {
    const start = performance.now()
    fn()
    data.push(performance.now() - start)
  }
  return data
}

function mean(v: number[]): number {
  return v.reduce((a, b) => a + b, 0) / v.length
}

function variance(v: number[], m: number): number {
  if (v.length < 2) return 0
  return v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1)
}

function welchTTest(a: number[], b: number[]): number {
  const mA = mean(a), mB = mean(b)
  const vA = variance(a, mA), vB = variance(b, mB)
  const se = Math.sqrt(vA / a.length + vB / b.length)
  if (!se) return 1
  const t = Math.abs(mA - mB) / se
  return 2 * (1 - normalCdf(t))
}

function normalCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x)
  const t = 1 / (1 + p * absX)
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-absX * absX)
  return 0.5 * (1 + sign * y)
}

function printComparison(name: string, ours: number[], theirs: number[], label: string) {
  const ourMean = mean(ours)
  const theirMean = mean(theirs)
  const speedup = theirMean / ourMean
  const pValue = welchTTest(ours, theirs)
  const sig = pValue < ALPHA ? 'sig' : 'ns'
  const verdict = speedup > 1.05 ? 'FASTER' : speedup < 0.95 ? 'SLOWER' : 'SAME'
  console.log(
    `[cmp] ${name.padEnd(15)} ours=${ourMean.toFixed(2)}ms ${label}=${theirMean.toFixed(2)}ms ` +
    `${speedup.toFixed(2)}x p=${pValue.toFixed(3)} ${sig} ${verdict}`
  )
}
