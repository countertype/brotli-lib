// What the encoder needs to know about static dictionary matching without
// importing it. The dictionary and the decoder that unpacks it are most of
// the encoder's size, so the core reaches them only through a value it is
// handed; an entry point that passes none leaves them out of the bundle

import type { HasherSearchResult } from './match'

export const MIN_DICTIONARY_WORD_LENGTH = 4
export const MAX_DICTIONARY_WORD_LENGTH = 24

// Longest match the dictionary can produce once transforms are applied
export const MAX_STATIC_DICTIONARY_MATCH_LEN = 37
export const INVALID_MATCH = 0xFFFFFFFF

// Lookup throttling: the reference gives up once the hit rate falls below
// 1/128, which keeps incompressible input from paying for the probes
export interface DictionarySearchState {
  numLookups: number
  numMatches: number
}

export function createDictionarySearchState(): DictionarySearchState {
  return { numLookups: 0, numMatches: 0 }
}

export interface StaticDictionary {
  // Best single match at `pos`, written to `out` if it beats what is there
  search(
    data: Uint8Array,
    pos: number,
    maxLength: number,
    maxBackward: number,
    maxDistance: number,
    out: HasherSearchResult,
    shallow: boolean,
    state: DictionarySearchState
  ): void

  // Every match at `pos`, indexed by length in `matches`
  findAll(
    data: Uint8Array,
    pos: number,
    minLength: number,
    maxLength: number,
    matches: Uint32Array
  ): boolean
}
