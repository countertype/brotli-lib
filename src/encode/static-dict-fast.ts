// Static dictionary lookup for the fast hashers, quality 2 to 9.
// Reference: c/enc/hash.h (SearchInStaticDictionary, TestStaticDictionaryItem)
// and c/enc/dictionary_hash.c (BrotliEncoderInitDictionaryHash).
//
// Probes at most two slots and considers only OMIT_LAST transforms, which is
// what keeps it affordable at these qualities. static-dict.ts has the full
// search used by quality 10 and 11

import {
  SIZE_BITS_BY_LENGTH,
  OFFSETS_BY_LENGTH,
  getDictionaryData,
  numWordsOfLength,
  MIN_DICTIONARY_WORD_LENGTH,
  MAX_DICTIONARY_WORD_LENGTH,
} from './dictionary-data'
import { backwardReferenceScore, HasherSearchResult } from './match'

const NUM_HASH_BITS = 14
const NUM_HASH_BUCKETS = 1 << (NUM_HASH_BITS + 1)
const HASH_MUL32 = 0x1E35A7BD

// transformId for an OMIT_LAST_<cut> transform is (cut << 2) + this table
const CUTOFF_TRANSFORMS = new Uint8Array([0, 8, 19, 11, 26, 43, 32, 20, 27, 28])
const CUTOFF_TRANSFORMS_COUNT = 10

// One bit per dictionary word, in the reference's iteration order. A set bit
// freezes that slot so a later (shorter) word cannot displace it. Carried over
// verbatim so our table matches the reference's byte for byte
const FROZEN_IDX_BASE64 =
  'AAAIpCA4H78kBIBRRISRgQAAABwACAEBQAMBAAAAAAAEQAECgACEMQAAAAAAAAAAEQAAAAEAJJgAAAAAgAgAAIAAAAgAAEAA' +
  'AAAAAAAAAAAIAAAAAQBAhQAgAACAAQAAAAAEBAQgEIIAgAgAAAAAAEAAQACgAJQ1AAAAAACAAIIAAAAIAAAAAAAwAAAAAAAA' +
  'IAEggQAMAAEAAAAAAAAAEAAAABAgAAAAAAAAAAABAAAIAAACAAAAAAAgAAAAAkKAAAAQAAAAAEABBoAIAMAYIAAACASAgAKg' +
  'AKAAQAAAAgAAAAAAAAAAACABAABAAAAAAAAAIABCAAIABAAIAAIAACEIAAAACACAogSAAAIhAKAACABAAKAAgQQAACAAACAA' +
  'AgAAAAAAAIAAAAAAAEAKAAAAACBAAAAAAAAQABAQAABQAgAAAAAIAAAQAAgAAAAIQIAAAAAI0AAAAAAAAAAgAAAAAAAAIAAI' +
  'AIAAAAABAAAAEAgBiAAAJABACQABIAgAQECDEOAgBAAEBaAAgwAEYAAAuMAAsc1gAAAAAAIAIAAAAAAAAAAAQAAAgAAACAAA' +
  'AAABBAABAAAABAAAAAAAAAQAAEBFAAAIAkIgQAAAAAAAAQCAEQAAAAAAAAAAAAAMABAAAASAQAAAAAAAAAAA4AAIAACCEECA' +
  'AkAAAACAAsBAAEEAAAAQAAAAIAQCAkwAAAAESDSDLEwAAAAAQAEQlAQAEApAAAIAAQCAQEQAAAAAAECQAAgAAgAAAAAAAANA' +
  'AAAAAAGAAAAgQgAAACgAEgAAAAAAIQAAIAAAIACABECRjAAAAIAAAgAAFABQJgAAIAAgQAQEAAQAAACBBAAAkBEgghCEGIYA' +
  'AEACBTIIwiEBRHUBCCChNgCCIgAAAECAAAACAAAAACABAAAAAw4AAAAAABAEAAAAAAAAAABgARgSAAGAGABAAAQAEIAAQAAA' +
  'AEAACAAAAAAAQoAAAAAAAAAAAAAAAAAAAAAQAEACAAAAAAYACAgCAEAAAAAAgAICDEAAQAAIAIAgAAAKAAAgAIAgIQiIAGBA' +
  'AAAAAABABBAECAAAABAAAgAAAYAAQBAAAAAAAAAAAAgAAAIAEAAEAAgAAAAAABQAAAAAAQAAAAAAAAAAAAAACIgAAAAAAAgA' +
  'AAAAAAIAAABAAAABAAIAAAAAAAAAAACAAAAAAAQAAAAAQQAAAAAAAAAAAAAEAAAAAAAAAAAAAAACgAAAAAgCAACAABACAAAE' +
  'ACAAAAEEQEAABAABABAAIEQEBEEKABQlEgGUACCAAwgAQAAAAAAAAAQAEAGAAAAAgBAAAAAAAYAAAIBAgEAAggCkCAAAAUCA' +
  'ABIAApYACAAAQABRAAAQgAIIJCCBBJANAAADCAEAAgAAQAAFAAEiASACEICAgAAAAAIABBIIDCIgwAZA4CEAAIlIQAAYCICA' +
  'ABAAIICAhAgAABAAQAAABAAAEAAEgEAAAAEABEAgkIICgADAAEBSQAEggIACAFQAIAAsGEhQIBAAACwQYEABSIMAAAAQAACl' +
  'AIECMTBAQAxAsEBUCIAUQNWIaAEpD1OqAAApAUBAAMFAQAgAgAAAQAhACAEQAAgAAAIBgBxUjWEAAEQAAIEIABAIIABAAAAA' +
  'GAAAAMAACIAAAAAAAEAAAQAAAAAoAYBAAAQCIAAAAAAAAAAAAAAAAIAgCAAgAAAAEBEAAgQAACGAAgAAAACBAAIAAAAkACAC' +
  'AAAAAAAAIAAAAAAEAAAAAAAAAAQgQAAAAAAAACAAACCAAAAAAAAAAAAAAIAQAAAAAAAAAAEAiAAAGMCAAwAREgIAQgAEGAAJ' +
  '0KcAkBRAAIJAAAIQiAhKIACoAEEgCAwBAwFAtAMAQAAIAAAgQQAEEAQQRCBAJCAYIQGAAAAIACBAUQABChMIAAAEBZAAAAiA' +
  'AAAEAAAAAAAAAQAAAAgAAAAAAFABAAAhACBCBAIAASsCAAAEIBAAQAADIAACQEB0AEE0QAARQMBgCAoIAgQAEUAABAAABIAA' +
  'AAkAAIICAMAAMIBAAGAAQAABECAAASAGgAIgAAwAADAgCAAAgAASAAAcGCkQBSAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAQAA' +
  'ABAAAAAAQAAAAAAIAAAAABCAAAAAEAAAAAAAAAgAAAAAAAAAAAAAAAAAIQAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

function hash14(data: Uint8Array, offset: number): number {
  const v = (data[offset] | (data[offset + 1] << 8) |
             (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0
  return Math.imul(v, HASH_MUL32) >>> (32 - NUM_HASH_BITS)
}

interface FastDictionaryTable {
  words: Uint16Array
  lengths: Uint8Array
}

let table: FastDictionaryTable | null = null

function getFastDictionaryTable(): FastDictionaryTable {
  if (table !== null) return table

  const binary = atob(FROZEN_IDX_BASE64)
  const frozen = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) frozen[i] = binary.charCodeAt(i)

  const data = getDictionaryData()
  const words = new Uint16Array(NUM_HASH_BUCKETS)
  const lengths = new Uint8Array(NUM_HASH_BUCKETS)
  let globalIdx = 0

  for (let len = MAX_DICTIONARY_WORD_LENGTH; len >= MIN_DICTIONARY_WORD_LENGTH; --len) {
    const lengthLt8 = len < 8 ? 1 : 0
    const n = numWordsOfLength(len)
    const base = OFFSETS_BY_LENGTH[len]
    for (let i = 0; i < n; ++i) {
      const j = n - 1 - i
      const key = hash14(data, base + len * j)
      const idx = (key << 1) + lengthLt8
      if ((lengths[idx] & 0x80) === 0) {
        const isFinal = (frozen[globalIdx >> 3] & (1 << (globalIdx & 7))) !== 0
        words[idx] = j
        lengths[idx] = len + (isFinal ? 0x80 : 0)
      }
      globalIdx++
    }
  }
  for (let i = 0; i < NUM_HASH_BUCKETS; ++i) lengths[i] &= 0x7F

  table = { words, lengths }
  return table
}

// Lookup throttling: the reference gives up once the hit rate falls below
// 1/128, which keeps incompressible input from paying for the probes
export interface DictionarySearchState {
  numLookups: number
  numMatches: number
}

export function createDictionarySearchState(): DictionarySearchState {
  return { numLookups: 0, numMatches: 0 }
}

function testItem(
  len: number, wordIdx: number, data: Uint8Array, pos: number,
  maxLength: number, maxBackward: number, maxDistance: number,
  out: HasherSearchResult
): boolean {
  if (len > maxLength) return false
  const dict = getDictionaryData()
  const offset = OFFSETS_BY_LENGTH[len] + len * wordIdx

  let matchlen = 0
  while (matchlen < len && data[pos + matchlen] === dict[offset + matchlen]) matchlen++
  // Only OMIT_LAST_<cut> transforms are reachable here, and only for cut < 10
  if (matchlen + CUTOFF_TRANSFORMS_COUNT <= len || matchlen === 0) return false

  const cut = len - matchlen
  const transformId = (cut << 2) + CUTOFF_TRANSFORMS[cut]
  const backward = maxBackward + 1 + wordIdx + (transformId << SIZE_BITS_BY_LENGTH[len])
  if (backward > maxDistance) return false

  const score = backwardReferenceScore(matchlen, backward)
  if (score < out.score) return false

  out.len = matchlen
  out.lenCodeDelta = len - matchlen
  out.distance = backward
  out.score = score
  out.fromDictionary = true
  return true
}

export function searchInStaticDictionary(
  data: Uint8Array,
  pos: number,
  maxLength: number,
  maxBackward: number,
  maxDistance: number,
  out: HasherSearchResult,
  shallow: boolean,
  state: DictionarySearchState
): void {
  if (state.numMatches < (state.numLookups >> 7)) return
  if (maxLength < MIN_DICTIONARY_WORD_LENGTH) return

  const { words, lengths } = getFastDictionaryTable()
  let key = hash14(data, pos) << 1
  const probes = shallow ? 1 : 2
  for (let i = 0; i < probes; ++i, ++key) {
    state.numLookups++
    const len = lengths[key]
    if (len !== 0) {
      if (testItem(len, words[key], data, pos, maxLength, maxBackward, maxDistance, out)) {
        state.numMatches++
      }
    }
  }
}
