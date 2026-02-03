// Hash chain hasher for Brotli compression (Quality 5-9)
// Reference: woff2/brotli/c/enc/hash_longest_match_inc.h

import {
  BackwardMatch,
  HasherSearchResult,
  findMatchLength,
  backwardReferenceScore,
  backwardReferenceScoreUsingLastDistance,
  hashBytes4,
  prepareDistanceCache,
} from './match'

export const MIN_MATCH_LEN = 4
export const HASH_TYPE_LENGTH = 4

// Hash chain hasher for quality 5-9
// Each bucket has a chain of positions sharing the same hash
export class HashChainHasher {
  private buckets: Uint32Array
  private chains: Uint32Array
  private bucketBits: number
  private windowMask: number
  private blockBits: number
  private numLastDistancesToCheck: number

  constructor(
    bucketBits: number,
    blockBits: number,
    lgwin: number,
    numLastDistancesToCheck: number = 4
  ) {
    this.bucketBits = bucketBits
    this.blockBits = blockBits
    this.windowMask = (1 << lgwin) - 1
    this.numLastDistancesToCheck = numLastDistancesToCheck
    
    this.buckets = new Uint32Array(1 << bucketBits)
    this.chains = new Uint32Array(1 << lgwin)
  }

  reset(): void {
    this.buckets.fill(0)
    // Chains don't need explicit reset - invalid chains will be detected
  }

  private hashBytes(data: Uint8Array, pos: number): number {
    return hashBytes4(data, pos, this.bucketBits)
  }

  store(data: Uint8Array, mask: number, ix: number): void {
    const maskedIx = ix & mask
    const key = this.hashBytes(data, maskedIx)
    const minorKey = ix & this.windowMask
    
    // Link new position to previous head of chain
    this.chains[minorKey] = this.buckets[key]
    // Make new position the head
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
    let bestScore = out.score
    const key = this.hashBytes(data, curIxMasked)
    const minorKey = curIx & this.windowMask
    
    out.lenCodeDelta = 0
    
    // Prepare extended distance cache
    prepareDistanceCache(distanceCache, this.numLastDistancesToCheck)
    
    // Check distance cache entries first
    for (let i = 0; i < this.numLastDistancesToCheck; i++) {
      const cachedBackward = distanceCache[i]
      if (cachedBackward <= 0 || cachedBackward > maxBackward) {
        continue
      }
      
      let prevIx = curIx - cachedBackward
      prevIx &= ringBufferMask
      
      // Quick check
      if (data[prevIx + bestLen] !== data[curIxMasked + bestLen]) {
        continue
      }
      
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
    
    // Store current position
    this.chains[minorKey] = this.buckets[key]
    this.buckets[key] = curIx
    
    // Walk the chain
    const maxChainLength = 1 << this.blockBits
    let prevIx = this.chains[minorKey]
    
    for (let chainLen = 0; chainLen < maxChainLength; chainLen++) {
      const backward = curIx - prevIx
      if (backward === 0 || backward > maxBackward) {
        break
      }
      
      const prevIxMasked = prevIx & ringBufferMask
      
      // Quick check
      if (data[prevIxMasked + bestLen] !== data[curIxMasked + bestLen]) {
        prevIx = this.chains[prevIx & this.windowMask]
        continue
      }
      
      const len = findMatchLength(data, prevIxMasked, curIxMasked, maxLength)
      if (len >= MIN_MATCH_LEN) {
        const score = backwardReferenceScore(len, backward)
        if (score > bestScore) {
          bestLen = len
          out.len = len
          out.distance = backward
          out.score = score
          bestScore = score
        }
      }
      
      prevIx = this.chains[prevIx & this.windowMask]
    }
  }

  // For Zopfli-style optimization
  findAllMatches(
    data: Uint8Array,
    ringBufferMask: number,
    distanceCache: Int32Array,
    curIx: number,
    maxLength: number,
    maxBackward: number
  ): BackwardMatch[] {
    const curIxMasked = curIx & ringBufferMask
    const matches: BackwardMatch[] = []
    const key = this.hashBytes(data, curIxMasked)
    const minorKey = curIx & this.windowMask
    let bestLen = 0
    
    // Prepare extended distance cache
    prepareDistanceCache(distanceCache, this.numLastDistancesToCheck)
    
    // Check distance cache entries
    for (let i = 0; i < this.numLastDistancesToCheck; i++) {
      const cachedBackward = distanceCache[i]
      if (cachedBackward <= 0 || cachedBackward > maxBackward) {
        continue
      }
      
      let prevIx = curIx - cachedBackward
      prevIx &= ringBufferMask
      
      const len = findMatchLength(data, prevIx, curIxMasked, maxLength)
      if (len >= MIN_MATCH_LEN && len > bestLen) {
        bestLen = len
        matches.push({
          distance: cachedBackward,
          length: len,
          score: backwardReferenceScoreUsingLastDistance(len),
          lenCodeDelta: 0,
        })
      }
    }
    
    // Store current position
    this.chains[minorKey] = this.buckets[key]
    this.buckets[key] = curIx
    
    // Walk the chain
    const maxChainLength = 1 << this.blockBits
    let prevIx = this.chains[minorKey]
    
    for (let chainLen = 0; chainLen < maxChainLength; chainLen++) {
      const backward = curIx - prevIx
      if (backward === 0 || backward > maxBackward) {
        break
      }
      
      const prevIxMasked = prevIx & ringBufferMask
      const len = findMatchLength(data, prevIxMasked, curIxMasked, maxLength)
      
      if (len >= MIN_MATCH_LEN && len > bestLen) {
        bestLen = len
        matches.push({
          distance: backward,
          length: len,
          score: backwardReferenceScore(len, backward),
          lenCodeDelta: 0,
        })
      }
      
      prevIx = this.chains[prevIx & this.windowMask]
    }
    
    // Sort by length
    matches.sort((a, b) => a.length - b.length)
    
    return matches
  }
}

export function createHashChainHasher(quality: number, lgwin: number): HashChainHasher {
  // Configuration based on quality level (from reference implementation)
  let bucketBits: number
  let blockBits: number
  let numLastDistancesToCheck: number
  
  if (quality < 7) {
    bucketBits = 14
    blockBits = quality - 1
    numLastDistancesToCheck = 4
  } else if (quality < 9) {
    bucketBits = 15
    blockBits = quality - 1
    numLastDistancesToCheck = 10
  } else {
    bucketBits = 15
    blockBits = quality - 1
    numLastDistancesToCheck = 16
  }
  
  return new HashChainHasher(bucketBits, blockBits, lgwin, numLastDistancesToCheck)
}
