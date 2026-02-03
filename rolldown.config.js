import { defineConfig } from 'rolldown'

export default defineConfig([
  // Main bundle (encode + decode)
  {
    input: 'src/index.ts',
    output: [
      { file: 'dist/index.js', format: 'esm' },
      { file: 'dist/index.cjs', format: 'cjs' },
    ],
  },
  // Encode-only bundle
  {
    input: 'src/encode.ts',
    output: [
      { file: 'dist/encode.js', format: 'esm' },
      { file: 'dist/encode.cjs', format: 'cjs' },
    ],
  },
  // Decode-only bundle
  {
    input: 'src/decode.ts',
    output: [
      { file: 'dist/decode.js', format: 'esm' },
      { file: 'dist/decode.cjs', format: 'cjs' },
    ],
  },
])
