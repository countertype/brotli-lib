// Binary tree hasher for Brotli compression (Quality 10-11)
// Reference: woff2/brotli/c/enc/hash_to_binary_tree_inc.h

import {
  BackwardMatch,
  findMatchLength,
  hashBytes4,
  backwardReferenceScore,
} from './match'
import {
  StaticDictionary,
  MAX_STATIC_DICTIONARY_MATCH_LEN,
  INVALID_MATCH,
  MIN_DICTIONARY_WORD_LENGTH,
} from './static-dict-types'
import { MAX_ENCODABLE_DISTANCE } from './enc-constants'

export const BUCKET_BITS = 17
export const MAX_TREE_COMP_LENGTH = 128
export const MAX_TREE_SEARCH_DEPTH = 64
export const WINDOW_GAP = 16

// Binary tree hasher for quality 10-11
// Each bucket contains a binary tree of sequences sharing the same 4-byte hash prefix,
// sorted lexicographically and also a max-heap by position. Finds all matches in O(log n)
export class BinaryTreeHasher {
  private dictMatches = new Uint32Array(MAX_STATIC_DICTIONARY_MATCH_LEN + 1)
  private buckets: Uint32Array
  private forest: Uint32Array // [2*pos] = left child, [2*pos+1] = right child
  private windowMask: number
  private invalidPos: number
  private bucketSize: number
  // How far back the linear scan for length-2 matches looks
  private shortMatchMaxBackward: number

  private dictionary: StaticDictionary | null

  constructor(
    lgwin: number,
    inputSize?: number,
    shortMatchMaxBackward = 64,
    dictionary: StaticDictionary | null = null
  ) {
    this.dictionary = dictionary
    this.shortMatchMaxBackward = shortMatchMaxBackward
    this.windowMask = (1 << lgwin) - 1
    this.invalidPos = (0 - this.windowMask) >>> 0
    this.bucketSize = 1 << BUCKET_BITS
    // Zero is a real position, so empty buckets need the invalid marker;
    // otherwise every bucket shares position 0's node and the trees cross-link
    this.buckets = new Uint32Array(this.bucketSize).fill(this.invalidPos)

    // Forest size: 2 entries per position in window
    const numNodes = inputSize !== undefined 
      ? Math.min(inputSize, 1 << lgwin)
      : 1 << lgwin
    this.forest = new Uint32Array(2 * numNodes)

    // Forest must start out "empty" (invalid pointers).
    // Without this, we may traverse phantom nodes and produce invalid distances.
    this.forest.fill(this.invalidPos)
  }

  reset(): void {
    this.buckets.fill(this.invalidPos)
    this.forest.fill(this.invalidPos)
  }

  private leftChildIndex(pos: number): number {
    return 2 * (pos & this.windowMask)
  }

  private rightChildIndex(pos: number): number {
    return 2 * (pos & this.windowMask) + 1
  }

  // Core algorithm: traverse and re-root the binary tree
  storeAndFindMatches(
    data: Uint8Array,
    curIx: number,
    ringBufferMask: number,
    maxLength: number,
    maxBackward: number,
    matches: BackwardMatch[] | null
  ): BackwardMatch[] {
    const curIxMasked = curIx & ringBufferMask
    const maxCompLen = Math.min(maxLength, MAX_TREE_COMP_LENGTH)
    const shouldRerootTree = maxLength >= MAX_TREE_COMP_LENGTH
    const key = hashBytes4(data, curIxMasked, BUCKET_BITS)
    
    let prevIx = this.buckets[key]
    let nodeLeft = this.leftChildIndex(curIx)
    let nodeRight = this.rightChildIndex(curIx)
    let bestLenLeft = 0
    let bestLenRight = 0
    let bestLen = matches ? 1 : 0
    
    const result: BackwardMatch[] = matches || []
    
    if (shouldRerootTree) {
      this.buckets[key] = curIx
    }
    
    for (let depthRemaining = MAX_TREE_SEARCH_DEPTH; ; depthRemaining--) {
      // Running out of depth has to close off both pending subtrees, the same
      // as reaching a leaf; stale links left behind break the tree's ordering
      // and produce matches that are not real
      if (depthRemaining === 0 || prevIx === this.invalidPos) {
        if (shouldRerootTree) {
          this.forest[nodeLeft] = this.invalidPos
          this.forest[nodeRight] = this.invalidPos
        }
        break
      }

      const backward = curIx - prevIx
      const prevIxMasked = prevIx & ringBufferMask
      
      // backward must be in [1..maxBackward]; note that prevIx is uint32 and can
      // be > curIx when it is an invalid marker, producing a negative backward.
      if (backward <= 0 || backward > maxBackward) {
        if (shouldRerootTree) {
          this.forest[nodeLeft] = this.invalidPos
          this.forest[nodeRight] = this.invalidPos
        }
        break
      }
      
      // Find match length starting from the known common prefix
      const curLen = Math.min(bestLenLeft, bestLenRight)
      const len = curLen + findMatchLength(
        data, 
        curIxMasked + curLen, 
        prevIxMasked + curLen, 
        maxLength - curLen
      )
      
      if (matches && len > bestLen) {
        bestLen = len
        // Inline to avoid call overhead
        result.push({
          distance: backward,
          length: len,
          score: backwardReferenceScore(len, backward),
          lenCodeDelta: 0,
        })
      }
      
      if (len >= maxCompLen) {
        // Found a very long match - copy subtrees
        if (shouldRerootTree) {
          this.forest[nodeLeft] = this.forest[this.leftChildIndex(prevIx)]
          this.forest[nodeRight] = this.forest[this.rightChildIndex(prevIx)]
        }
        break
      }
      
      // Compare bytes to decide which subtree to explore
      if (data[curIxMasked + len] > data[prevIxMasked + len]) {
        bestLenLeft = len
        if (shouldRerootTree) {
          this.forest[nodeLeft] = prevIx
        }
        nodeLeft = this.rightChildIndex(prevIx)
        prevIx = this.forest[nodeLeft]
      } else {
        bestLenRight = len
        if (shouldRerootTree) {
          this.forest[nodeRight] = prevIx
        }
        nodeRight = this.leftChildIndex(prevIx)
        prevIx = this.forest[nodeRight]
      }
    }
    
    return result
  }

  // Also stores the current position in the hash table. Dictionary matches are
  // encoded relative to `dictionaryDistance`; pass 0 to skip them
  findAllMatches(
    data: Uint8Array,
    ringBufferMask: number,
    curIx: number,
    maxLength: number,
    maxBackward: number,
    dictionaryDistance: number = 0
  ): BackwardMatch[] {
    const curIxMasked = curIx & ringBufferMask
    const matches: BackwardMatch[] = []
    let bestLen = 1
    
    const shortMatchMaxBackward = this.shortMatchMaxBackward
    const stop = curIx > shortMatchMaxBackward ? curIx - shortMatchMaxBackward : 0
    
    for (let i = curIx - 1; i > stop && bestLen <= 2; i--) {
      const backward = curIx - i
      if (backward > maxBackward) break
      
      const prevIxMasked = i & ringBufferMask
      
      // Quick 2-byte check
      if (data[curIxMasked] !== data[prevIxMasked] ||
          data[curIxMasked + 1] !== data[prevIxMasked + 1]) {
        continue
      }
      
      const len = findMatchLength(data, prevIxMasked, curIxMasked, maxLength)
      if (len > bestLen) {
        bestLen = len
        // Inline
        matches.push({
          distance: backward,
          length: len,
          score: backwardReferenceScore(len, backward),
          lenCodeDelta: 0,
        })
      }
    }
    
    // Then use binary tree for longer matches
    if (bestLen < maxLength) {
      const treeMatches = this.storeAndFindMatches(
        data, curIx, ringBufferMask, maxLength, maxBackward, []
      )
      
      for (const m of treeMatches) {
        if (m.length > bestLen) {
          bestLen = m.length
          matches.push(m)
        }
      }
    } else {
      // Still need to update the tree even if we found a long match
      this.storeAndFindMatches(
        data, curIx, ringBufferMask, maxLength, maxBackward, null
      )
    }
    
    // All exceed bestLen and are appended in increasing length order, so the
    // array stays sorted
    const dictionary = this.dictionary
    if (dictionary !== null && dictionaryDistance > 0 && maxLength >= MIN_DICTIONARY_WORD_LENGTH) {
      const dictMatches = this.dictMatches
      dictMatches.fill(INVALID_MATCH)
      const minLen = Math.max(MIN_DICTIONARY_WORD_LENGTH, bestLen + 1)
      if (dictionary.findAll(data, curIxMasked, minLen, maxLength, dictMatches)) {
        const maxLen = Math.min(MAX_STATIC_DICTIONARY_MATCH_LEN, maxLength)
        for (let l = minLen; l <= maxLen; ++l) {
          const dictId = dictMatches[l]
          if (dictId === INVALID_MATCH) continue
          const distance = dictionaryDistance + (dictId >>> 5) + 1
          if (distance > MAX_ENCODABLE_DISTANCE) continue
          const lenCode = dictId & 31
          matches.push({
            distance,
            length: l,
            score: backwardReferenceScore(l, distance),
            lenCodeDelta: lenCode - l,
          })
        }
      }
    }

    // Insertion sort by length
    for (let i = 1; i < matches.length; i++) {
      const item = matches[i]
      let j = i - 1
      while (j >= 0 && matches[j].length > item.length) {
        matches[j + 1] = matches[j]
        j--
      }
      matches[j + 1] = item
    }
    
    return matches
  }

  store(data: Uint8Array, mask: number, ix: number): void {
    const maxBackward = this.windowMask - WINDOW_GAP + 1
    this.storeAndFindMatches(data, ix, mask, MAX_TREE_COMP_LENGTH, maxBackward, null)
  }

  storeRange(data: Uint8Array, mask: number, ixStart: number, ixEnd: number): void {
    // Optimization: for large ranges, store every 8th position first
    let i = ixStart
    let j = ixStart
    
    if (ixStart + 63 <= ixEnd) {
      i = ixEnd - 63
    }
    
    if (ixStart + 512 <= i) {
      for (; j < i; j += 8) {
        this.store(data, mask, j)
      }
    }
    
    for (; i < ixEnd; i++) {
      this.store(data, mask, i)
    }
  }

  // For streaming
  stitchToPreviousBlock(
    numBytes: number,
    position: number,
    ringBuffer: Uint8Array,
    ringBufferMask: number
  ): void {
    if (numBytes >= 3 && position >= MAX_TREE_COMP_LENGTH) {
      const iStart = position - MAX_TREE_COMP_LENGTH + 1
      const iEnd = Math.min(position, iStart + numBytes)
      
      for (let i = iStart; i < iEnd; i++) {
        const maxBackward = this.windowMask - Math.max(WINDOW_GAP - 1, position - i)
        this.storeAndFindMatches(
          ringBuffer, i, ringBufferMask, MAX_TREE_COMP_LENGTH, maxBackward, null
        )
      }
    }
  }
}

export function createBinaryTreeHasher(
  lgwin: number,
  inputSize?: number,
  quality = 11,
  dictionary: StaticDictionary | null = null
): BinaryTreeHasher {
  // Only the top quality pays for the wider scan
  return new BinaryTreeHasher(lgwin, inputSize, quality === 11 ? 64 : 16, dictionary)
}
