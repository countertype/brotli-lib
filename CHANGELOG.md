# Changelog

## 0.0.4 - 2026-02-06

### Performance

- Decoder
  - Hoist State properties into locals in literal decode loop (reduces megamorphic property access)
  - Reuse scratch buffers for Huffman table construction (reduces GC pressure)
  - Scratch table for `decodeContextMap`
  - `distance=1` fill and `distance=4` doubling copy in copy loop
  - `TypedArray.fill()` for RLE zeros, repeat deltas, and single-symbol Huffman tables
  - `copyWithin` for move-to-front transform
  - Minimize state write-backs before `readMoreInput`
  - Exponential output buffer growth for unknown-size decodes

## 0.0.3 - 2026-02-03

### Fixed
- Encoder correctness: fixed `BLOCK_LENGTH_PREFIX_RANGES` table to match decoder spec, resolving bit misalignment in block splitting
- FONT mode: correctly propagate `npostfix`/`ndirect` parameters through all encoder paths (commands, metablock header, fallback paths)

### Added
- Full block splitting and context modeling for quality 5+
- FONT mode (`mode: 'FONT'`) with optimized distance parameters (`npostfix=1`, `ndirect=12`) for WOFF2 transformed font data

## 0.0.2 - 2026-02-03

### Added
- Changelog

### Performance
- `findMatchLength`: unrolled 4-byte loop, early exit
- `hashBytes8`: 32-bit Math.imul, no BigInt
- `createBackwardReferences`: reuse result object
- Hashers: inline match creation, insertion sort
- `createHuffmanTree`: struct-of-arrays layout

## 0.0.1 - 2026-02-02

init
