# Changelog

## 0.0.3 - 2026-02-03

### Fixed
- Encoder correctness: fixed `BLOCK_LENGTH_PREFIX_RANGES` table to match decoder spec, resolving bit misalignment in block splitting

### Added
- Full block splitting and context modeling for quality 5+
- FONT mode (`mode: 'FONT'`) with optimized distance parameters for font data

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
