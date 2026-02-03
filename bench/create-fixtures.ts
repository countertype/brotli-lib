// Create brotli-compressed test fixtures
// Run with: npx tsx bench/create-fixtures.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as zlib from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesPath = join(__dirname, 'fixtures')

mkdirSync(fixturesPath, { recursive: true })

const sources: Array<{ name: string; getData: () => Buffer }> = [
  {
    name: 'enc-ttf',
    getData: () => {
      const woff2Path = join(__dirname, '../../woff2-decode/test/fixtures/dec-enc-ttf.ttf')
      if (existsSync(woff2Path)) return readFileSync(woff2Path)
      console.log('  [fallback] Creating synthetic TTF-like data')
      return Buffer.alloc(100 * 1024, 0x41)
    },
  },
  {
    name: 'enc-otf',
    getData: () => {
      const woff2Path = join(__dirname, '../../woff2-decode/test/fixtures/dec-enc-otf.otf')
      if (existsSync(woff2Path)) return readFileSync(woff2Path)
      console.log('  [fallback] Creating synthetic OTF-like data')
      return Buffer.alloc(110 * 1024, 0x42)
    },
  },
  {
    name: 'enc-var-ttf',
    getData: () => {
      const woff2Path = join(__dirname, '../../woff2-decode/test/fixtures/dec-enc-var-ttf.ttf')
      if (existsSync(woff2Path)) return readFileSync(woff2Path)
      console.log('  [fallback] Creating synthetic variable font data')
      return Buffer.alloc(320 * 1024, 0x43)
    },
  },
  {
    name: 'html-content',
    getData: () => {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Test</title>
  <style>body { font-family: sans-serif; margin: 0; padding: 20px; }</style>
</head>
<body>
  <div class="container"><h1>Hello</h1><p>Content here.</p></div>
</body>
</html>`.repeat(100)
      return Buffer.from(html)
    },
  },
  {
    name: 'random-binary',
    getData: () => {
      const data = Buffer.alloc(50 * 1024)
      for (let i = 0; i < data.length; i++) data[i] = Math.floor(Math.random() * 256)
      return data
    },
  },
]

console.log('Creating brotli-compressed test fixtures...\n')

for (const source of sources) {
  console.log(`Processing: ${source.name}`)
  const data = source.getData()
  console.log(`  Original: ${(data.length / 1024).toFixed(1)} KB`)

  const compressed = zlib.brotliCompressSync(data, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  })

  console.log(`  Compressed: ${(compressed.length / 1024).toFixed(1)} KB (${(compressed.length / data.length * 100).toFixed(1)}%)`)

  writeFileSync(join(fixturesPath, `${source.name}.bin`), data)
  writeFileSync(join(fixturesPath, `${source.name}.br`), compressed)
  console.log('')
}

console.log('Done!')
