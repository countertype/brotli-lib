// Brotli decoding

import { BrotliInput } from './streams'
import { BrotliBitReader } from './bit-reader'
import * as BrotliDictionary from './dictionary'
import { brotliDecode as engineDecode } from './engine'

// Header parsing for decompressedSize, allows pre-allocation without full decode
function decodeWindowBits(br: BrotliBitReader): number {
  if (br.readBits(1) === 0) {
    return 16;
  }

  let n = br.readBits(3);
  if (n > 0) {
    return 17 + n;
  }

  n = br.readBits(3);
  if (n > 0) {
    return 8 + n;
  }

  return 17;
}

interface MetaBlockLength {
  meta_block_length: number;
  input_end: number;
  is_uncompressed: number;
  is_metadata: boolean;
}

function decodeMetaBlockLength(br: BrotliBitReader): MetaBlockLength {
  const out: MetaBlockLength = {
    meta_block_length: 0,
    input_end: 0,
    is_uncompressed: 0,
    is_metadata: false,
  };

  out.input_end = br.readBits(1);
  if (out.input_end && br.readBits(1)) {
    return out;
  }

  const size_nibbles = br.readBits(2) + 4;
  if (size_nibbles === 7) {
    out.is_metadata = true;

    if (br.readBits(1) !== 0) {
      throw new Error('Invalid reserved bit');
    }

    const size_bytes = br.readBits(2);
    if (size_bytes === 0) {
      return out;
    }

    for (let i = 0; i < size_bytes; i++) {
      const next_byte = br.readBits(8);
      if (i + 1 === size_bytes && size_bytes > 1 && next_byte === 0) {
        throw new Error('Invalid size byte');
      }
      out.meta_block_length |= next_byte << (i * 8);
    }
  } else {
    for (let i = 0; i < size_nibbles; ++i) {
      const next_nibble = br.readBits(4);
      if (i + 1 === size_nibbles && size_nibbles > 4 && next_nibble === 0) {
        throw new Error('Invalid size nibble');
      }
      out.meta_block_length |= next_nibble << (i * 4);
    }
  }

  ++out.meta_block_length;

  if (!out.input_end && !out.is_metadata) {
    out.is_uncompressed = br.readBits(1);
  }

  return out;
}

// Reads uncompressed size from first metablock header
// Returns -1 if stream has multiple metablocks (can't determine total without decoding)
export function brotliDecodedSize(buffer: Uint8Array): number {
  const input = new BrotliInput(buffer);
  const br = new BrotliBitReader(input);
  decodeWindowBits(br);
  const out = decodeMetaBlockLength(br);
  // input_end=1 means this is the last (and only) metablock
  if (out.input_end) {
    return out.meta_block_length;
  }
  // Multiple metablocks - can't determine total size without full decode
  return -1;
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
    const estimatedSize = brotliDecodedSize(buffer)
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
