// Brotli decoding

import * as BrotliDictionary from './dictionary'
import { brotliDecode as engineDecode, peekDecodedSize } from './engine'

// Reads uncompressed size from first metablock header
// Returns -1 if stream has multiple metablocks (can't determine total without decoding)
// Uses zero-allocation header peek (no BrotliBitReader/BrotliInput overhead)
export function brotliDecodedSize(buffer: Uint8Array): number {
  return peekDecodedSize(buffer);
}

export interface BrotliDecodeOptions {
  maxOutputSize?: number
  customDictionary?: Uint8Array | Int8Array
}

export function brotliDecode(
  buffer: Uint8Array,
  options?: BrotliDecodeOptions | number
): Uint8Array {
  // Legacy signature: brotliDecode(data, outputSize)
  let output_size: number | undefined
  let maxOutputSize: number | undefined
  let customDictionary: Uint8Array | undefined

  if (typeof options === 'number') {
    output_size = options
  } else {
    maxOutputSize = options?.maxOutputSize
    const dict = options?.customDictionary
    if (dict) {
      customDictionary = dict instanceof Uint8Array ? dict : new Uint8Array(dict.buffer, dict.byteOffset, dict.byteLength)
    }
  }
  
  // Try to pre-allocate output buffer if size is known
  if (output_size === undefined) {
    const estimatedSize = peekDecodedSize(buffer)
    // -1 means multiple metablocks, let chunked decoder handle it
    if (estimatedSize > 0) {
      output_size = estimatedSize
    }
  }

  if (maxOutputSize !== undefined && output_size !== undefined && output_size > maxOutputSize) {
    throw new Error(
      `Decompressed size ${output_size} exceeds limit ${maxOutputSize}`
    )
  }

  const decoded = engineDecode(buffer, { 
    customDictionary: customDictionary,
    outputSize: output_size
  })

  // Header can lie about size
  if (maxOutputSize !== undefined && decoded.length > maxOutputSize) {
    throw new Error(
      `Decompressed size ${decoded.length} exceeds limit ${maxOutputSize}`
    )
  }

  return decoded
}

// Dictionary is brotli-compressed; register decoder for bootstrap
BrotliDictionary.setDecoder(brotliDecode)
