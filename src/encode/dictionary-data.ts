// The shared brotli static dictionary, as the encoder sees it.
//
// It ships brotli-compressed, so reading it requires the decoder. That is what
// puts the decoder in the encode-only bundle. The decode-only bundle is
// unaffected: nothing under decode/ imports this

import { compressedDictionary } from '../decode/dictionary-bin'
import { brotliDecode } from '../decode/decode'

// Number of dictionary words of each length is 1 << SIZE_BITS_BY_LENGTH[len].
// Lengths 0-3 have no words: brotli dictionary words are 4..24 bytes
export const SIZE_BITS_BY_LENGTH = new Uint8Array([
  0, 0, 0, 0, 10, 10, 11, 11, 10, 10,
  10, 10, 10, 9, 9, 8, 7, 7, 8, 7,
  7, 6, 6, 5, 5,
])

export { MIN_DICTIONARY_WORD_LENGTH, MAX_DICTIONARY_WORD_LENGTH } from './static-dict-types'

export const OFFSETS_BY_LENGTH = new Uint32Array(32)
{
  let pos = 0
  for (let i = 0; i < SIZE_BITS_BY_LENGTH.length; ++i) {
    OFFSETS_BY_LENGTH[i] = pos
    const bits = SIZE_BITS_BY_LENGTH[i]
    if (bits !== 0) {
      pos += i << bits
    }
  }
  for (let i = SIZE_BITS_BY_LENGTH.length; i < 32; ++i) {
    OFFSETS_BY_LENGTH[i] = pos
  }
}

let dictionaryData: Uint8Array | null = null

// Inflated on first use so merely importing the encoder stays cheap
export function getDictionaryData(): Uint8Array {
  if (dictionaryData === null) {
    const binary = atob(compressedDictionary)
    const compressed = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      compressed[i] = binary.charCodeAt(i)
    }
    dictionaryData = brotliDecode(compressed)
  }
  return dictionaryData
}

export function numWordsOfLength(length: number): number {
  return SIZE_BITS_BY_LENGTH[length] ? 1 << SIZE_BITS_BY_LENGTH[length] : 0
}
