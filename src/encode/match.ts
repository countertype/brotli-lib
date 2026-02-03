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

// Performance-critical match length finder
export function findMatchLength(
  data: Uint8Array,
  s1: number,
  s2: number,
  limit: number
): number {
  let matched = 0
  
  // Fast path: check 4 bytes at a time
  while (matched + 4 <= limit) {
    if (data[s1 + matched] !== data[s2 + matched] ||
        data[s1 + matched + 1] !== data[s2 + matched + 1] ||
        data[s1 + matched + 2] !== data[s2 + matched + 2] ||
        data[s1 + matched + 3] !== data[s2 + matched + 3]) {
      break
    }
    matched += 4
  }
  
  // Slow path: byte by byte
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
export const HASH_MUL_64 = 0x1E35A7BDn

export function hashBytes4(data: Uint8Array, pos: number, bucketBits: number): number {
  // Read 4 bytes as little-endian 32-bit integer (handle out of bounds)
  const b0 = pos < data.length ? data[pos] : 0
  const b1 = pos + 1 < data.length ? data[pos + 1] : 0
  const b2 = pos + 2 < data.length ? data[pos + 2] : 0
  const b3 = pos + 3 < data.length ? data[pos + 3] : 0
  const h32 = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0
  
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
  // Read 8 bytes as little-endian 64-bit integer
  let h64 = 0n
  for (let i = 0; i < 8; i++) {
    const byte = pos + i < data.length ? data[pos + i] : 0
    h64 |= BigInt(byte) << BigInt(i * 8)
  }
  
  // Shift to keep only hashLen bytes, then multiply
  const shift = BigInt(64 - 8 * hashLen)
  h64 = (h64 << shift) * HASH_MUL_64
  
  // Take high bits
  return Number(h64 >> BigInt(64 - bucketBits))
}
