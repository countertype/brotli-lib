# Changelog

## 0.1.0 - 2026-11-18

### Fixes

- Decoder
  - Valid streams could be rejected with error -4 when the distance context map was smaller than the literal one (seen with the reference encoder's quality 10 and 11 output on fonts); a decode after a failed one could fail the same way
  - A stream ending inside a literal run could loop forever
  - A copy ending exactly at the output buffer boundary could skip the buffer wrap (streams larger than their window)
- Encoder
  - Quality 10 and 11 could produce corrupt streams (match tree depth limit, distance cache, cost table indexing, commands with more than 32 extra bits)
  - Inputs larger than the window, and inputs spanning several metablocks (over 16 MB, or any size at small `lgwin`), could produce corrupt streams at quality 5 and up
  - `BrotliEncoder` produced corrupt output for an `update()` larger than its buffer and for windows smaller than a block
  - The hash chain search could fail to terminate

### Compression

- Output is now within about 1% of the reference C encoder at every quality, and smaller at 5 to 9 (text 1.6% smaller; fonts 3.5 to 5% smaller at 7 to 9). Before: 3 to 10% larger at 2 to 4, 7 to 10% larger on fonts at 10 and 11
- Static dictionary matching at all qualities
- Block splitting ported faithfully (cost sign, sampling, limits), plus the reference's greedy splitter below quality 10 and block splitting at quality 4
- Distance parameter search (NPOSTFIX, NDIRECT) and signed literal contexts for binary data
- Lazy matching, short copies at recent distances, multi-slot hashing at quality 3 and 4, short metablocks at quality 2 and 3
- `BrotliEncoder` shares everything after the match search with `brotliEncode` and compresses within a fraction of a percent of it (was 2 to 12% worse)

### Performance

- Encoder
  - 4-byte loads for hashing, candidate filtering and match length (quality 5 to 9 about 25% faster on text)
  - Dedicated search loop for quality 2 to 4 (about 20 to 27% faster)
  - Hash tables reused across calls at quality 5 to 9, the large ones held weakly (a 4.5 KB input at quality 9: 2 ms to 0.03 ms)
  - Histogram cost visits only nonzero symbols, with early exit; clustering allocates nothing per candidate
  - Zopfli nodes held in typed arrays; no `BigInt`
  - `BrotliEncoder` no longer retains output it has already returned
- Decoder
  - Command loop moved to its own function, hot state in locals, 4-byte copies

### Changed

- `brotli-lib/encode` now includes the static dictionary and the decoder that unpacks it (104 KB gzipped, was 25 KB). `brotli-lib/decode` is unchanged
- `BrotliEncoder.update()` throws after `finish()`
- Removed unused decoder modules `bit-reader` and `streams`

## 0.0.7 - 2026-02-11

### Performance

- Encoder
  - Eliminate redundant hash stores and reduce store frequency in backward references (Q1 ~40% faster)
  - Cache `SimpleHasher` across encode calls (avoids 512KB alloc per encode)
  - Reuse `ZopfliNode[]` and pre-allocate arrays across Zopfli DP iterations (Q11 ~20% faster)
  - Remove unnecessary `BigInt` from `encodeMlen`

## 0.0.6 - 2026-02-07

### Performance

- Decoder
  - Command pipeline fusion: fuse command decode, literal loop, and copy loop into a single tight `while` loop, eliminating switch dispatches and intermediate state write-backs
  - Generalized doubling copy: extend optimized `copyWithin` doubling for all small distances (d ≤ 8)
  - Context-tree-base table: fuse context map and literal tree group lookups into a single 64-entry precomputed table, replacing 4 dependent array loads with 1

## 0.0.5 - 2026-02-06

### Performance

- Decoder
  - Zero-allocation `peekDecodedSize` header peek (eliminates redundant `BrotliBitReader` + `BrotliInput` allocation per decode)
  - Batched literal decode loops: compute batch size to skip per-iteration guard checks for input refill, block switch, and fence
  - Eliminate `bytesToNibbles` memcpy on little-endian by sharing `ArrayBuffer` between `byteBuffer` and `shortBuffer`
  - Merge command decode (case 4) into literal loop (case 7): shared hoisted locals across both, eliminates switch dispatch
  - Inline `readSymbol` + `readFewBits`/`readManyBits` in command decode (eliminates function call overhead + State property access for ~30K calls per font)
  - Command pipeline fusion: fuse case 4 (command), case 7 (literal+distance), and case 8 (copy) into single tight `commandLoop` with local `_phase` control flow, eliminating 2 switch dispatches and ~30 property write-backs per command cycle
  - Generalized doubling copy for small distances (d <= 8): seed d bytes then `copyWithin` doubling
  - Context-tree-base table: pre-build 64-entry `context → Huffman tree base offset` lookup at each literal block boundary, fusing context map + tree group indirection into a single array access per literal (~20% faster than Google's JS decoder)

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
