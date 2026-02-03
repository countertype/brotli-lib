// Simple hash table for Brotli compression (Quality 2-4)
// Reference: woff2/brotli/c/enc/hash_longest_match_quickly_inc.h

import {
  HasherSearchResult,
  findMatchLength,
  backwardReferenceScore,
  backwardReferenceScoreUsingLastDistance,
  hashBytes8,
} from './match'

export const Q2_BUCKET_BITS = 16
export const Q3_BUCKET_BITS = 17
export const HASH_LEN = 5
export const MIN_MATCH_LEN = 4
export const STORE_LOOKAHEAD = 8

// Forgetful hash table for quality 2-4
// Fast but may miss some matches since new entries overwrite old ones
export class SimpleHasher {
  private buckets: Uint32Array
  private bucketBits: number

  constructor(bucketBits: number, _lgwin: number) {
    this.bucketBits = bucketBits
    const bucketSize = 1 << bucketBits
    this.buckets = new Uint32Array(bucketSize)
  }

  reset(): void {
    this.buckets.fill(0)
  }

  // Partial reset optimization for small inputs
  prepare(data: Uint8Array, inputSize: number): void {
    const partialThreshold = this.buckets.length >> 5
    if (inputSize <= partialThreshold) {
      // Only clear buckets that will be used
      for (let i = 0; i < inputSize; i++) {
        const key = this.hashBytes(data, i)
        this.buckets[key] = 0
      }
    } else {
      this.buckets.fill(0)
    }
  }

  private hashBytes(data: Uint8Array, pos: number): number {
    return hashBytes8(data, pos, HASH_LEN, this.bucketBits)
  }

  store(data: Uint8Array, mask: number, ix: number): void {
    const key = this.hashBytes(data, ix & mask)
    this.buckets[key] = ix
  }

  storeRange(data: Uint8Array, mask: number, ixStart: number, ixEnd: number): void {
    for (let i = ixStart; i < ixEnd; i++) {
      this.store(data, mask, i)
    }
  }

  // Also stores the current position in the hash table
  findLongestMatch(
    data: Uint8Array,
    ringBufferMask: number,
    distanceCache: Int32Array,
    curIx: number,
    maxLength: number,
    maxBackward: number,
    out: HasherSearchResult
  ): void {
    const curIxMasked = curIx & ringBufferMask
    let bestLen = out.len
    const key = this.hashBytes(data, curIxMasked)
    let bestScore = out.score
    
    out.lenCodeDelta = 0
    
    // Check distance cache first (cached distances are cheap to encode)
    const cachedBackward = distanceCache[0]
    if (cachedBackward > 0 && cachedBackward <= maxBackward) {
      let prevIx = curIx - cachedBackward
      prevIx &= ringBufferMask
      
      if (data[prevIx + bestLen] === data[curIxMasked + bestLen]) {
        const len = findMatchLength(data, prevIx, curIxMasked, maxLength)
        if (len >= MIN_MATCH_LEN) {
          const score = backwardReferenceScoreUsingLastDistance(len)
          if (score > bestScore) {
            bestLen = len
            out.len = len
            out.distance = cachedBackward
            out.score = score
            bestScore = score
          }
        }
      }
    }
    
    // Check hash table
    let prevIx = this.buckets[key]
    this.buckets[key] = curIx
    
    const backward = curIx - prevIx
    if (backward === 0 || backward > maxBackward) {
      return
    }
    
    prevIx &= ringBufferMask
    
    // Quick check: compare last byte of best match
    if (data[prevIx + bestLen] !== data[curIxMasked + bestLen]) {
      return
    }
    
    const len = findMatchLength(data, prevIx, curIxMasked, maxLength)
    if (len >= MIN_MATCH_LEN) {
      const score = backwardReferenceScore(len, backward)
      if (score > bestScore) {
        out.len = len
        out.distance = backward
        out.score = score
      }
    }
  }
}

export function createSimpleHasher(quality: number, lgwin: number): SimpleHasher {
  const bucketBits = quality === 2 ? Q2_BUCKET_BITS : Q3_BUCKET_BITS
  return new SimpleHasher(bucketBits, lgwin)
}
