// Simple hash table for Brotli compression (Quality 2-4)
// Reference: woff2/brotli/c/enc/hash_longest_match_quickly_inc.h

import { HASH_MUL_32, hashBytes8 } from './match'
import {
  StaticDictionary,
  createDictionarySearchState,
  DictionarySearchState,
} from './static-dict-types'

export const Q2_BUCKET_BITS = 16
export const Q4_BUCKET_BITS = 17
export const HASH_LEN = 5
export const MIN_MATCH_LEN = 4
export const STORE_LOOKAHEAD = 8

const EMPTY_VIEW = new DataView(new ArrayBuffer(0))

// Forgetful hash table for quality 2-4
// Fast but may miss some matches since new entries overwrite old ones
//
// This holds the table and keeps it filled. The search itself lives in the
// driver loop, createBackwardReferencesQuick, which reads these fields
// directly: at these qualities a call per position is a measurable cost
export class SimpleHasher {
  dictState: DictionarySearchState = createDictionarySearchState()
  // Null for H3, which runs without it, and in builds that leave it out
  dictionary: StaticDictionary | null = null
  readonly buckets: Uint32Array
  readonly bucketBits: number
  readonly bucketMask: number
  // Slots tried per key. A position lands in one of them, chosen by its low
  // bits, so a key keeps several candidates instead of only the newest
  sweep = 1
  sweepMask = 0
  private viewData: Uint8Array | null = null
  private view: DataView = EMPTY_VIEW

  constructor(bucketBits: number, _lgwin: number) {
    this.bucketBits = bucketBits
    const bucketSize = 1 << bucketBits
    this.bucketMask = bucketSize - 1
    this.buckets = new Uint32Array(bucketSize)
  }

  configure(sweep: number, dictionary: StaticDictionary | null): void {
    this.sweep = sweep
    this.sweepMask = (sweep - 1) << 3
    this.dictionary = dictionary
  }

  reset(): void {
    this.buckets.fill(0)
    // Pooled across calls, so the lookup throttle resets with the buckets
    this.dictState = createDictionarySearchState()
  }

  // Drops the reference to the caller's input, which a pooled instance would
  // otherwise keep alive until its next use
  release(): void {
    this.viewData = null
    this.view = EMPTY_VIEW
  }

  hashAt(data: Uint8Array, pos: number): number {
    if (pos + 4 > data.length) {
      return hashBytes8(data, pos, HASH_LEN, this.bucketBits)
    }
    // Same value as hashBytes8 at length 5, with one load for the first four
    const word = this.viewOf(data).getUint32(pos, true) ^ (data[pos + 4] << 24)
    return (Math.imul(word, HASH_MUL_32) >>> 0) >>> (32 - this.bucketBits)
  }

  // One view per input buffer; building it per call would cost more than it saves
  viewOf(data: Uint8Array): DataView {
    if (data !== this.viewData) {
      this.viewData = data
      this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    }
    return this.view
  }

  store(data: Uint8Array, mask: number, ix: number): void {
    const key = this.hashAt(data, ix & mask)
    this.buckets[(key + (ix & this.sweepMask)) & this.bucketMask] = ix
  }

  storeRange(data: Uint8Array, mask: number, ixStart: number, ixEnd: number): void {
    if (ixStart >= ixEnd) return
    // Unwrapped and far enough from the end for every word read: one view
    // lookup and no per-position checks
    if (ixEnd - 1 <= mask && ixEnd + 3 <= data.length) {
      const view = this.viewOf(data)
      const buckets = this.buckets
      const shift = 32 - this.bucketBits
      const sweepMask = this.sweepMask
      const bucketMask = this.bucketMask
      for (let i = ixStart; i < ixEnd; i++) {
        const word = view.getUint32(i, true) ^ (data[i + 4] << 24)
        const key = (Math.imul(word, HASH_MUL_32) >>> 0) >>> shift
        buckets[(key + (i & sweepMask)) & bucketMask] = i
      }
      return
    }
    for (let i = ixStart; i < ixEnd; i++) {
      this.store(data, mask, i)
    }
  }
}

// Cache hashers to avoid re-allocating large typed arrays
let _cachedHasher17: SimpleHasher | null = null
let _cachedHasher16: SimpleHasher | null = null

// `shared` hands out the cached instance, which is only safe for a caller that
// is done with it before anyone else can ask
export function createSimpleHasher(
  quality: number,
  lgwin: number,
  dictionary: StaticDictionary | null = null,
  shared = true
): SimpleHasher {
  // Quality 2: one slot per key. Quality 3: two slots, no dictionary.
  // Quality 4: four slots and a larger table
  const sweep = quality <= 2 ? 1 : quality === 3 ? 2 : 4
  if (quality === 3) dictionary = null
  let hasher: SimpleHasher
  if (!shared) {
    hasher = new SimpleHasher(quality >= 4 ? Q4_BUCKET_BITS : Q2_BUCKET_BITS, lgwin)
  } else if (quality >= 4) {
    if (_cachedHasher17 === null) {
      _cachedHasher17 = new SimpleHasher(Q4_BUCKET_BITS, lgwin)
    } else {
      _cachedHasher17.reset()
    }
    hasher = _cachedHasher17
  } else {
    if (_cachedHasher16 === null) {
      _cachedHasher16 = new SimpleHasher(Q2_BUCKET_BITS, lgwin)
    } else {
      _cachedHasher16.reset()
    }
    hasher = _cachedHasher16
  }
  hasher.configure(sweep, dictionary)
  return hasher
}
