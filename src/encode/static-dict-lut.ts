// Hash lookup over the static dictionary, for the encoder's match search.
// Reference: c/enc/encoder_dict.c (BuildDictionaryLut)
//
// Built at runtime from the dictionary rather than shipped as a generated
// table, to keep it out of the bundle

import {
  getDictionaryData,
  numWordsOfLength,
  OFFSETS_BY_LENGTH,
  MIN_DICTIONARY_WORD_LENGTH,
  MAX_DICTIONARY_WORD_LENGTH,
} from './dictionary-data'

export const NUM_HASH_BITS = 15
export const NUM_HASH_BUCKETS = 1 << NUM_HASH_BITS
const HASH_MUL32 = 0x1E35A7BD

// Transform *types*, as stored in each entry's transform field
export const TRANSFORM_TYPE_IDENTITY = 0
export const TRANSFORM_TYPE_UPPERCASE_FIRST = 10
export const TRANSFORM_TYPE_UPPERCASE_ALL = 11

// Transform *indices* into the RFC transform table. These are what match ids
// are built from; they are not the same numbers as the types above
export const TRANSFORM_IDX_IDENTITY = 0
export const TRANSFORM_IDX_UPPERCASE_FIRST = 9
export const TRANSFORM_IDX_UPPERCASE_ALL = 44

// Hash of the first 4 bytes, matching the reference's Hash() with 15 bits
export function hashDictionaryPrefix(data: Uint8Array, offset: number): number {
  const v = (data[offset] | (data[offset + 1] << 8) |
             (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0
  return (Math.imul(v, HASH_MUL32) >>> (32 - NUM_HASH_BITS))
}

// A dictionary word entry packed into one word:
//   bits 24-31 length, with 0x80 marking the last entry in its bucket
//   bits 16-23 transform index
//   bits  0-15 word index within its length class
export function dictWordLength(w: number): number { return (w >>> 24) & 0x1F }
export function dictWordIsLast(w: number): boolean { return ((w >>> 24) & 0x80) !== 0 }
export function dictWordTransform(w: number): number { return (w >>> 16) & 0xFF }
export function dictWordIndex(w: number): number { return w & 0xFFFF }

// Uppercase a dictionary word in place, mirroring the decoder's
// UPPERCASE_FIRST / UPPERCASE_ALL transforms so the encoder and decoder agree
// byte for byte. Both preserve the word's byte length
function uppercaseTransform(word: Uint8Array, wordLen: number, firstOnly: boolean): void {
  let offset = 0
  let len = firstOnly ? 1 : wordLen
  while (len > 0 && offset < wordLen) {
    const c0 = word[offset]
    if (c0 < 0xC0) {
      if (c0 >= 97 && c0 <= 122) {
        word[offset] = c0 ^ 32
      }
      offset += 1
      len -= 1
    } else if (c0 < 0xE0) {
      word[offset + 1] ^= 32
      offset += 2
      len -= 2
    } else {
      word[offset + 2] ^= 5
      offset += 3
      len -= 3
    }
  }
}

export interface DictionaryLut {
  buckets: Uint16Array
  words: Uint32Array
}

let lut: DictionaryLut | null = null

export function getDictionaryLut(): DictionaryLut {
  if (lut !== null) return lut

  const data = getDictionaryData()
  const byHash: number[][] = new Array(NUM_HASH_BUCKETS)
  // Smallest `idx + transform * n` seen for a given transformed word, so a word
  // reachable by several transforms is only stored under the cheapest one
  const seen = new Map<string, number>()
  const scratch = new Uint8Array(MAX_DICTIONARY_WORD_LENGTH)
  let total = 0

  const add = (key: number, entry: number): void => {
    let bucket = byHash[key]
    if (bucket === undefined) {
      bucket = []
      byHash[key] = bucket
    }
    bucket.push(entry)
    total++
  }
  const wordKey = (w: Uint8Array, len: number): string => {
    let s = ''
    for (let i = 0; i < len; i++) s += String.fromCharCode(w[i])
    return s
  }

  // Identity transform for every word
  for (let l = MIN_DICTIONARY_WORD_LENGTH; l <= MAX_DICTIONARY_WORD_LENGTH; ++l) {
    const n = numWordsOfLength(l)
    const base = OFFSETS_BY_LENGTH[l]
    for (let idx = 0; idx < n; ++idx) {
      const off = base + l * idx
      scratch.set(data.subarray(off, off + l))
      seen.set(wordKey(scratch, l), idx)
      add(hashDictionaryPrefix(scratch, 0), (l << 24) | (TRANSFORM_TYPE_IDENTITY << 16) | idx)
    }
  }

  // Uppercase-first and uppercase-all, skipped when an earlier transform
  // already produced the same bytes with a lower id
  for (let l = MIN_DICTIONARY_WORD_LENGTH; l <= MAX_DICTIONARY_WORD_LENGTH; ++l) {
    const n = numWordsOfLength(l)
    const base = OFFSETS_BY_LENGTH[l]
    for (let idx = 0; idx < n; ++idx) {
      const off = base + l * idx
      let isAscii = true
      for (let k = 0; k < l; ++k) {
        if (data[off + k] >= 128) { isAscii = false; break }
      }
      if (data[off] < 128) {
        scratch.set(data.subarray(off, off + l))
        uppercaseTransform(scratch, l, true)
        const key = wordKey(scratch, l)
        const ix = idx + TRANSFORM_IDX_UPPERCASE_FIRST * n
        const prev = seen.get(key)
        if (prev === undefined || prev > ix) {
          seen.set(key, ix)
          add(hashDictionaryPrefix(scratch, 0), (l << 24) | (TRANSFORM_TYPE_UPPERCASE_FIRST << 16) | idx)
        }
      }
      if (isAscii) {
        scratch.set(data.subarray(off, off + l))
        uppercaseTransform(scratch, l, false)
        const key = wordKey(scratch, l)
        const ix = idx + TRANSFORM_IDX_UPPERCASE_ALL * n
        const prev = seen.get(key)
        if (prev === undefined || prev > ix) {
          seen.set(key, ix)
          add(hashDictionaryPrefix(scratch, 0), (l << 24) | (TRANSFORM_TYPE_UPPERCASE_ALL << 16) | idx)
        }
      }
    }
  }

  // Flatten. Index 0 is unused so that a bucket value of 0 means "empty"
  const buckets = new Uint16Array(NUM_HASH_BUCKETS)
  const words = new Uint32Array(total + 1)
  let pos = 1
  for (let i = 0; i < NUM_HASH_BUCKETS; ++i) {
    const bucket = byHash[i]
    if (bucket === undefined || bucket.length === 0) {
      buckets[i] = 0
      continue
    }
    buckets[i] = pos
    for (let j = 0; j < bucket.length; ++j) words[pos++] = bucket[j]
    words[pos - 1] |= 0x80 << 24
  }

  lut = { buckets, words }
  return lut
}
