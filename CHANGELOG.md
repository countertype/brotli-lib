# Changelog

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
