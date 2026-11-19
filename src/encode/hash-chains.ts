// Hasher for Brotli compression (Quality 5-9)
// Reference: woff2/brotli/c/enc/hash_longest_match_inc.h

import {
  HasherSearchResult,
  findMatchLength,
  findMatchLengthWide,
  hashWord,
  HASH_MUL_32,
  backwardReferenceScore,
  backwardReferenceScoreUsingLastDistance,
  backwardReferencePenaltyUsingLastDistance,
  hashBytes4,
  prepareDistanceCache,
} from './match'

import {
  searchInStaticDictionary,
  createDictionarySearchState,
  DictionarySearchState,
} from './static-dict-fast'
import { MAX_ENCODABLE_DISTANCE } from './enc-constants'


export const MIN_MATCH_LEN = 4
export const HASH_TYPE_LENGTH = 4

const EMPTY_VIEW = new DataView(new ArrayBuffer(0))

// Each hash key owns a fixed block of slots holding its most recent positions,
// written round-robin. A search reads one contiguous block instead of chasing
// links through memory, which is what makes deep searches affordable
export class HashChainHasher {
  private dictState: DictionarySearchState = createDictionarySearchState()
  // Slot blocks, one per key
  private buckets: Uint32Array
  // Positions ever stored under each key; the low bits pick the next slot
  private num: Uint32Array
  private bucketBits: number
  private blockBits: number
  private blockSize: number
  private blockMask: number
  private numLastDistancesToCheck: number
  private viewData: Uint8Array | null = null
  private view: DataView = EMPTY_VIEW

  constructor(
    bucketBits: number,
    blockBits: number,
    _lgwin: number,
    numLastDistancesToCheck: number = 4
  ) {
    this.bucketBits = bucketBits
    this.blockBits = blockBits
    this.blockSize = 1 << blockBits
    this.blockMask = this.blockSize - 1
    this.numLastDistancesToCheck = numLastDistancesToCheck

    this.num = new Uint32Array(1 << bucketBits)
    this.buckets = new Uint32Array(1 << (bucketBits + blockBits))
  }

  reset(): void {
    // Slots beyond a key's count are never read
    this.num.fill(0)
    this.dictState = createDictionarySearchState()
  }

  // Drops the reference to the caller's input, which a pooled instance would
  // otherwise keep alive until its next use
  release(): void {
    this.viewData = null
    this.view = EMPTY_VIEW
  }

  store(data: Uint8Array, mask: number, ix: number): void {
    const p = ix & mask
    const key = p + 4 <= data.length
      ? hashWord(this.viewOf(data).getUint32(p, true), this.bucketBits)
      : hashBytes4(data, p, this.bucketBits)
    const n = this.num[key]
    this.buckets[(key << this.blockBits) + (n & this.blockMask)] = ix
    this.num[key] = n + 1
  }

  storeRange(data: Uint8Array, mask: number, ixStart: number, ixEnd: number): void {
    if (ixStart >= ixEnd) return
    // Unwrapped and far enough from the end for every word read: one view
    // lookup and no per-position checks
    if (ixEnd - 1 <= mask && ixEnd + 3 <= data.length) {
      const view = this.viewOf(data)
      const buckets = this.buckets
      const num = this.num
      const shift = 32 - this.bucketBits
      const blockBits = this.blockBits
      const blockMask = this.blockMask
      for (let i = ixStart; i < ixEnd; i++) {
        const key = (Math.imul(view.getUint32(i, true), HASH_MUL_32) >>> 0) >>> shift
        const n = num[key]
        buckets[(key << blockBits) + (n & blockMask)] = i
        num[key] = n + 1
      }
      return
    }
    for (let i = ixStart; i < ixEnd; i++) {
      this.store(data, mask, i)
    }
  }

  // One view per input buffer; building it per call would cost more than it saves
  private viewOf(data: Uint8Array): DataView {
    if (data !== this.viewData) {
      this.viewData = data
      this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    }
    return this.view
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
    const minScore = out.score
    let bestLen = out.len
    let bestScore = out.score
    const view = this.viewOf(data)
    // Word reads throw past the end where byte reads return undefined, so
    // they are only used when the whole candidate range is in bounds
    // An unwrapped position also means every earlier one is unwrapped
    const wide = maxLength >= 4 && curIx === curIxMasked && curIx + maxLength <= data.length
    const key = wide
      ? hashWord(view.getUint32(curIxMasked, true), this.bucketBits)
      : hashBytes4(data, curIxMasked, this.bucketBits)

    out.lenCodeDelta = 0
    out.fromDictionary = false

    // Prepare extended distance cache
    prepareDistanceCache(distanceCache, this.numLastDistancesToCheck)

    // Check distance cache entries first
    for (let i = 0; i < this.numLastDistancesToCheck; i++) {
      const cachedBackward = distanceCache[i]
      if (cachedBackward <= 0 || cachedBackward > maxBackward) {
        continue
      }

      const prevIx = (curIx - cachedBackward) & ringBufferMask

      // Quick check
      if (data[prevIx + bestLen] !== data[curIxMasked + bestLen]) {
        continue
      }

      const len = wide
        ? findMatchLengthWide(view, data, prevIx, curIxMasked, maxLength)
        : findMatchLength(data, prevIx, curIxMasked, maxLength)
      // A recent distance costs so little to code that copies shorter than
      // the usual minimum still pay off; binary formats are full of them
      if (len >= 3 || (len === 2 && i < 2)) {
        let score = backwardReferenceScoreUsingLastDistance(len)
        if (score > bestScore) {
          if (i !== 0) score -= backwardReferencePenaltyUsingLastDistance(i)
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

    // Newest first, so the first position out of range ends the search
    const buckets = this.buckets
    const blockMask = this.blockMask
    const base = key << this.blockBits
    const n = this.num[key]
    const down = n > this.blockSize ? n - this.blockSize : 0
    if (wide) {
      // A candidate only matters if it is longer than the best so far and at
      // least the minimum length; both require the four bytes ending at
      // `probe` to agree, which one comparison settles
      let probe = bestLen < 3 ? 3 : bestLen
      if (probe < maxLength) {
        let curTail = view.getUint32(curIxMasked + probe - 3, true)
        for (let i = n; i > down;) {
          const prevIx = buckets[base + (--i & blockMask)]
          const backward = curIx - prevIx
          if (backward === 0 || backward > maxBackward) {
            break
          }
          const prevIxMasked = prevIx & ringBufferMask
          if (view.getUint32(prevIxMasked + probe - 3, true) !== curTail) continue

          const len = findMatchLengthWide(view, data, prevIxMasked, curIxMasked, maxLength)
          if (len >= MIN_MATCH_LEN) {
            const score = backwardReferenceScore(len, backward)
            if (score > bestScore) {
              bestLen = len
              out.len = len
              out.distance = backward
              out.score = score
              bestScore = score
              probe = len
              if (probe >= maxLength) break
              curTail = view.getUint32(curIxMasked + probe - 3, true)
            }
          }
        }
      }
    } else {
      for (let i = n; i > down;) {
        const prevIx = buckets[base + (--i & blockMask)]
        const backward = curIx - prevIx
        if (backward === 0 || backward > maxBackward) {
          break
        }
        const prevIxMasked = prevIx & ringBufferMask

        if (data[prevIxMasked + bestLen] === data[curIxMasked + bestLen]) {
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
        }
      }
    }
    buckets[base + (n & blockMask)] = curIx
    this.num[key] = n + 1

    // Only worth consulting when no backward reference beat the incoming score
    if (minScore === out.score) {
      searchInStaticDictionary(
        data, curIxMasked, maxLength, maxBackward, MAX_ENCODABLE_DISTANCE,
        out, false, this.dictState
      )
    }
  }
}

// Tables are reused across one-shot calls: for a small input, allocating them
// costs more than the encode itself. Small ones are simply kept. Large ones
// (tens of megabytes at the top qualities) are held weakly, so a run of calls
// shares one and an idle process gives it back
const POOL_KEEP_BYTES = 4 << 20
const pooled = new Map<number, HashChainHasher | WeakHolder<HashChainHasher>>()

// Newer than the library this package compiles against, and missing from old
// runtimes, where large tables are simply not pooled
interface WeakHolder<T> { deref(): T | undefined }
declare const WeakRef: (new <T extends object>(target: T) => WeakHolder<T>) | undefined

// `shared` hands out the pooled instance, which is only safe for a caller that
// is done with it before anyone else can ask
export function createHashChainHasher(
  quality: number, lgwin: number, shared = true
): HashChainHasher {
  // Configuration based on quality level (from reference implementation)
  const bucketBits = quality < 7 ? 14 : 15
  const blockBits = quality - 1
  const numLastDistancesToCheck = quality < 7 ? 4 : quality < 9 ? 10 : 16

  if (!shared) {
    return new HashChainHasher(bucketBits, blockBits, lgwin, numLastDistancesToCheck)
  }

  // Quality fixes all three parameters
  const entry = pooled.get(quality)
  const existing = entry instanceof HashChainHasher ? entry : entry?.deref()
  if (existing !== undefined) {
    existing.reset()
    return existing
  }

  const hasher = new HashChainHasher(bucketBits, blockBits, lgwin, numLastDistancesToCheck)
  const bytes = 4 << (bucketBits + blockBits)
  if (bytes <= POOL_KEEP_BYTES) {
    pooled.set(quality, hasher)
  } else if (typeof WeakRef !== 'undefined') {
    pooled.set(quality, new WeakRef(hasher))
  }
  return hasher
}
