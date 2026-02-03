import { bench, describe } from 'vitest'
import * as zlib from 'zlib'
import { brotliEncode } from '../src/encode/encode'

// Test data
const shortText = 'Hello, World!'
const mediumText = 'The quick brown fox jumps over the lazy dog. '.repeat(100)
const longText = mediumText.repeat(10)
const html = `<!DOCTYPE html><html><head><title>Test</title></head><body>${'<p>Content</p>'.repeat(500)}</body></html>`

const inputs = [
  { name: 'short (13 B)', data: new TextEncoder().encode(shortText) },
  { name: 'medium (4.5 KB)', data: new TextEncoder().encode(mediumText) },
  { name: 'long (45 KB)', data: new TextEncoder().encode(longText) },
  { name: 'html (8 KB)', data: new TextEncoder().encode(html) },
]

// Quick sanity check - print compression ratios
console.log('\nCompression ratios (quality 11):')
for (const { name, data } of inputs) {
  const ours = brotliEncode(data, { quality: 11 })
  const native = zlib.brotliCompressSync(data, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 }
  })
  console.log(`${name}: ours=${ours.length} native=${native.length} (${(ours.length/native.length).toFixed(2)}x)`)
}
console.log('')

for (const quality of [1, 5, 11]) {
  describe(`quality ${quality}`, () => {
    for (const { name, data } of inputs) {
      bench(`brotli-lib ${name}`, () => {
        brotliEncode(data, { quality })
      })

      bench(`node:zlib ${name}`, () => {
        zlib.brotliCompressSync(data, {
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality }
        })
      })
    }
  })
}
