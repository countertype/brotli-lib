// Main Brotli encoder API: the encoder with the static dictionary

import { encode, StreamEncoder, BrotliEncodeOptions } from './encoder'
import { STATIC_DICTIONARY } from './static-dict-matcher'

export type { BrotliEncodeOptions }

// Compress data using Brotli
export function brotliEncode(
  input: Uint8Array,
  options: BrotliEncodeOptions = {}
): Uint8Array {
  return encode(input, options, STATIC_DICTIONARY)
}

// Compress data arriving in chunks; see StreamEncoder
export class BrotliEncoder extends StreamEncoder {
  constructor(options: BrotliEncodeOptions = {}) {
    super(options, STATIC_DICTIONARY)
  }
}
