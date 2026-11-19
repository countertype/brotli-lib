// The encoder without the static dictionary
//
// Same API and a valid stream either way. Leaving the dictionary out drops
// most of the bundle, at no cost on binary data such as fonts and a few
// percent on text, most of it on short inputs and at the top quality

import { encode, StreamEncoder, BrotliEncodeOptions } from './encoder'

export type { BrotliEncodeOptions }

// Compress data using Brotli
export function brotliEncode(
  input: Uint8Array,
  options: BrotliEncodeOptions = {}
): Uint8Array {
  return encode(input, options, null)
}

// Compress data arriving in chunks; see StreamEncoder
export class BrotliEncoder extends StreamEncoder {
  constructor(options: BrotliEncodeOptions = {}) {
    super(options, null)
  }
}
