// Static dictionary matching for Brotli compression
// Reference: woff2/brotli/c/enc/static_dict.c

import { BackwardMatch, findMatchLengthWithLimit, createBackwardMatch } from './match'

export const MIN_DICTIONARY_WORD_LENGTH = 4
export const MAX_DICTIONARY_WORD_LENGTH = 24
export const MAX_STATIC_DICTIONARY_MATCH_LEN = 37
export const INVALID_MATCH = 0xFFFFFFFF

export const OFFSETS_BY_LENGTH = new Uint32Array([
  0, 0, 0, 0, 0, 4096, 9216, 21504, 35840, 44032,
  53248, 63488, 74752, 87040, 93696, 100864, 104704, 106752, 108928, 113536,
  115968, 118528, 119872, 121280, 122016,
])

export const SIZE_BITS_BY_LENGTH = new Uint8Array([
  0, 0, 0, 0, 10, 10, 11, 11, 10, 10,
  10, 10, 10, 9, 9, 8, 7, 7, 8, 7,
  7, 6, 6, 5, 5,
])

// Can be loaded lazily from brotli-decompress
export interface StaticDictionary {
  getData(): Uint8Array
}

let globalDictionary: Uint8Array | null = null

export function setStaticDictionary(data: Uint8Array): void {
  globalDictionary = data
}

export function getStaticDictionary(): Uint8Array | null {
  return globalDictionary
}

function getNumWordsOfLength(length: number): number {
  return 1 << SIZE_BITS_BY_LENGTH[length]
}

// Simplified version: exact matches only
// A full implementation would handle transforms (uppercase, suffixes, prefixes)
export function findStaticDictionaryMatches(
  dictionary: Uint8Array,
  data: Uint8Array,
  pos: number,
  minLength: number,
  maxLength: number,
  maxDistance: number
): BackwardMatch[] {
  const matches: BackwardMatch[] = []
  
  if (maxLength < MIN_DICTIONARY_WORD_LENGTH) {
    return matches
  }
  
  // Limit search to valid dictionary word lengths
  const searchMinLen = Math.max(minLength, MIN_DICTIONARY_WORD_LENGTH)
  const searchMaxLen = Math.min(maxLength, MAX_DICTIONARY_WORD_LENGTH)
  
  // For each possible word length
  for (let len = searchMinLen; len <= searchMaxLen; len++) {
    const numWords = getNumWordsOfLength(len)
    const baseOffset = OFFSETS_BY_LENGTH[len]
    
    // Linear search through words of this length
    // (A production implementation would use a hash table or trie)
    for (let idx = 0; idx < numWords; idx++) {
      const offset = baseOffset + len * idx
      
      // Quick first-byte check
      if (dictionary[offset] !== data[pos]) {
        continue
      }
      
      // Check full match
      const matchLen = findMatchLengthWithLimit(
        dictionary, offset,
        data, pos,
        len
      )
      
      if (matchLen === len) {
        // Full match found
        // Distance is encoded as: max_distance + word_index + 1
        const distance = maxDistance + idx + 1
        const match = createBackwardMatch(distance, len)
        match.lenCodeDelta = 0  // No transform
        matches.push(match)
      }
    }
  }
  
  // Sort by length (ascending)
  matches.sort((a, b) => a.length - b.length)
  
  return matches
}

export function findBestStaticDictionaryMatch(
  dictionary: Uint8Array,
  data: Uint8Array,
  pos: number,
  minLength: number,
  maxLength: number,
  maxDistance: number
): BackwardMatch | null {
  if (maxLength < MIN_DICTIONARY_WORD_LENGTH) {
    return null
  }
  
  let bestMatch: BackwardMatch | null = null
  let bestLen = minLength - 1
  
  const searchMinLen = Math.max(minLength, MIN_DICTIONARY_WORD_LENGTH)
  const searchMaxLen = Math.min(maxLength, MAX_DICTIONARY_WORD_LENGTH)
  
  // Search from longest to shortest (more efficient for finding best match)
  for (let len = searchMaxLen; len >= searchMinLen; len--) {
    if (len <= bestLen) break  // Can't improve
    
    const numWords = getNumWordsOfLength(len)
    const baseOffset = OFFSETS_BY_LENGTH[len]
    
    for (let idx = 0; idx < numWords; idx++) {
      const offset = baseOffset + len * idx
      
      if (dictionary[offset] !== data[pos]) {
        continue
      }
      
      const matchLen = findMatchLengthWithLimit(
        dictionary, offset,
        data, pos,
        len
      )
      
      if (matchLen === len && len > bestLen) {
        const distance = maxDistance + idx + 1
        bestMatch = createBackwardMatch(distance, len)
        bestLen = len
        break  // Found a match at this length, try longer
      }
    }
  }
  
  return bestMatch
}

export const NUM_TRANSFORMS = 121

export const enum TransformType {
  IDENTITY = 0,
  OMIT_LAST_1 = 12,
  OMIT_LAST_2 = 13,
  OMIT_LAST_3 = 14,
  UPPERCASE_FIRST = 10,
  UPPERCASE_ALL = 44,
}

export function getOmitLastTransform(omitCount: number): number {
  if (omitCount < 1 || omitCount > 9) return -1
  return 11 + omitCount  // Transforms 12-20 are OMIT_LAST_1 through OMIT_LAST_9
}

export function encodeDictionaryDistance(
  wordIndex: number,
  transformId: number,
  wordLength: number
): number {
  const numWords = getNumWordsOfLength(wordLength)
  return wordIndex + transformId * numWords
}
