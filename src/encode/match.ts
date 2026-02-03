// Match finding utilities for Brotli compression
// Reference: woff2/brotli/c/enc/hash.h, find_match_length.h

import { log2FloorNonZero } from './fast-log'

export interface BackwardMatch {
  distance: number     // backward distance to match start
  length: number       // match length
  score: number        // higher = better
  lenCodeDelta: number // for dictionary matches
}

export interface HasherSearchResult {
  len: number
  distance: number
  score: number
  lenCodeDelta: number
}

export const LITERAL_BYTE_SCORE = 135
export const DISTANCE_BIT_PENALTY = 30
export const SCORE_BASE = DISTANCE_BIT_PENALTY * 8 * 4 // must be positive after max penalty
export const INVALID_MATCH = 0xFFFFFFFF

// Score balances copy length against distance cost
export function backwardReferenceScore(copyLength: number, backwardDistance: number): number {
  return SCORE_BASE + 
         LITERAL_BYTE_SCORE * copyLength - 
         DISTANCE_BIT_PENALTY * log2FloorNonZero(backwardDistance)
}

// Score for match using last distance cache entry (cheaper to encode)
export function backwardReferenceScoreUsingLastDistance(copyLength: number): number {
  return LITERAL_BYTE_SCORE * copyLength + SCORE_BASE + 15
}

export function backwardReferencePenaltyUsingLastDistance(distanceShortCode: number): number {
  return 39 + ((0x1CA10 >> (distanceShortCode & 0xE)) & 0xE)
}

// 4-byte unrolled comparison with early exit
export function findMatchLength(
  data: Uint8Array,
  s1: number,
  s2: number,
  limit: number
): number {
  let matched = 0
  
  // Compare 4 bytes at a time
  while (matched + 4 <= limit) {
    const a0 = data[s1 + matched]
    const b0 = data[s2 + matched]
    if (a0 !== b0) return matched
    
    const a1 = data[s1 + matched + 1]
    const b1 = data[s2 + matched + 1]
    if (a1 !== b1) return matched + 1
    
    const a2 = data[s1 + matched + 2]
    const b2 = data[s2 + matched + 2]
    if (a2 !== b2) return matched + 2
    
    const a3 = data[s1 + matched + 3]
    const b3 = data[s2 + matched + 3]
    if (a3 !== b3) return matched + 3
    
    matched += 4
  }
  
  // Handle remaining bytes
  while (matched < limit && data[s1 + matched] === data[s2 + matched]) {
    matched++
  }
  
  return matched
}

export function findMatchLengthWithLimit(
  s1: Uint8Array,
  s1Offset: number,
  s2: Uint8Array,
  s2Offset: number,
  limit: number
): number {
  let matched = 0
  
  while (matched < limit && s1[s1Offset + matched] === s2[s2Offset + matched]) {
    matched++
  }
  
  return matched
}

export function createBackwardMatch(distance: number, length: number): BackwardMatch {
  return {
    distance,
    length,
    score: backwardReferenceScore(length, distance),
    lenCodeDelta: 0,
  }
}

export function createDictionaryBackwardMatch(
  distance: number,
  length: number,
  lenCodeDelta: number
): BackwardMatch {
  return {
    distance,
    length,
    score: backwardReferenceScore(length, distance),
    lenCodeDelta,
  }
}

export function createSearchResult(): HasherSearchResult {
  return {
    len: 0,
    distance: 0,
    score: 0,
    lenCodeDelta: 0,
  }
}

// Prepare distance cache with extended entries:
// [0-3] recent distances, [4-9] last ± 1,2,3, [10-15] second-last ± 1,2,3
export function prepareDistanceCache(distanceCache: Int32Array, numDistances: number): void {
  if (numDistances > 4) {
    const lastDistance = distanceCache[0]
    distanceCache[4] = lastDistance - 1
    distanceCache[5] = lastDistance + 1
    distanceCache[6] = lastDistance - 2
    distanceCache[7] = lastDistance + 2
    distanceCache[8] = lastDistance - 3
    distanceCache[9] = lastDistance + 3
    
    if (numDistances > 10) {
      const nextLastDistance = distanceCache[1]
      distanceCache[10] = nextLastDistance - 1
      distanceCache[11] = nextLastDistance + 1
      distanceCache[12] = nextLastDistance - 2
      distanceCache[13] = nextLastDistance + 2
      distanceCache[14] = nextLastDistance - 3
      distanceCache[15] = nextLastDistance + 3
    }
  }
}

export function createDistanceCache(): Int32Array {
  const cache = new Int32Array(16)
  // Initialize with typical distances
  cache[0] = 4
  cache[1] = 11
  cache[2] = 15
  cache[3] = 16
  return cache
}

export const HASH_MUL_32 = 0x1E35A7BD

export function hashBytes4(data: Uint8Array, pos: number, bucketBits: number): number {
  // Read 4 bytes little-endian
  const h32 = (data[pos] | 
               (data[pos + 1] << 8) | 
               (data[pos + 2] << 16) | 
               (data[pos + 3] << 24)) >>> 0
  
  // Multiply and take high bits
  const h = Math.imul(h32, HASH_MUL_32) >>> 0
  return h >>> (32 - bucketBits)
}

export function hashBytes8(
  data: Uint8Array,
  pos: number,
  hashLen: number, 
  bucketBits: number
): number {
  // Fast path for hashLen=5 (common case)
  if (hashLen === 5) {
    const h32 = (data[pos] |
                 (data[pos + 1] << 8) |
                 (data[pos + 2] << 16) |
                 (data[pos + 3] << 24)) >>> 0
    const b4 = data[pos + 4] | 0
    const h = Math.imul(h32 ^ (b4 << 24), HASH_MUL_32) >>> 0
    return h >>> (32 - bucketBits)
  }

  // Generic path for hashLen 1..8
  let h32 = (data[pos] |
             (data[pos + 1] << 8) |
             (data[pos + 2] << 16) |
             (data[pos + 3] << 24)) >>> 0

  // Mask to hashLen bytes
  if (hashLen <= 0) {
    h32 = 0
  } else if (hashLen === 1) {
    h32 &= 0xFF
  } else if (hashLen === 2) {
    h32 &= 0xFFFF
  } else if (hashLen === 3) {
    h32 &= 0xFFFFFF
  }

  // Mix in bytes 4..7 if needed
  if (hashLen > 4) {
    const keep = hashLen - 4
    let tail = (data[pos + 4] |
                (data[pos + 5] << 8) |
                (data[pos + 6] << 16) |
                (data[pos + 7] << 24)) >>> 0
    if (keep === 1) tail &= 0xFF
    else if (keep === 2) tail &= 0xFFFF
    else if (keep === 3) tail &= 0xFFFFFF
    h32 ^= tail
  }

  const h = Math.imul(h32, HASH_MUL_32) >>> 0
  return h >>> (32 - bucketBits)
}
