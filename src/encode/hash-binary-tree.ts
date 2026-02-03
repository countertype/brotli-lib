// Binary tree hasher for Brotli compression (Quality 10-11)
// Reference: woff2/brotli/c/enc/hash_to_binary_tree_inc.h

import {
  BackwardMatch,
  findMatchLength,
  hashBytes4,
  createBackwardMatch,
} from './match'

export const BUCKET_BITS = 17
export const MAX_TREE_COMP_LENGTH = 128
export const MAX_TREE_SEARCH_DEPTH = 64
export const WINDOW_GAP = 16

// Binary tree hasher for quality 10-11
// Each bucket contains a binary tree of sequences sharing the same 4-byte hash prefix,
// sorted lexicographically and also a max-heap by position. Finds all matches in O(log n)
export class BinaryTreeHasher {
  private buckets: Uint32Array
  private forest: Uint32Array // [2*pos] = left child, [2*pos+1] = right child
  private windowMask: number
  private invalidPos: number
  private bucketSize: number

  constructor(lgwin: number, inputSize?: number) {
    this.windowMask = (1 << lgwin) - 1
    this.invalidPos = (0 - this.windowMask) >>> 0
    this.bucketSize = 1 << BUCKET_BITS
    this.buckets = new Uint32Array(this.bucketSize)
    
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
    
    for (let depthRemaining = MAX_TREE_SEARCH_DEPTH; depthRemaining > 0; depthRemaining--) {
      if (prevIx === this.invalidPos) {
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
        result.push(createBackwardMatch(backward, len))
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

  // Also stores the current position in the hash table
  findAllMatches(
    data: Uint8Array,
    ringBufferMask: number,
    curIx: number,
    maxLength: number,
    maxBackward: number
  ): BackwardMatch[] {
    const curIxMasked = curIx & ringBufferMask
    const matches: BackwardMatch[] = []
    let bestLen = 1
    
    // First check short matches (up to 64 positions back for Q11, 16 for Q10)
    const shortMatchMaxBackward = 64
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
        matches.push(createBackwardMatch(backward, len))
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
    
    // Sort by length (ascending)
    matches.sort((a, b) => a.length - b.length)
    
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

export function createBinaryTreeHasher(lgwin: number, inputSize?: number): BinaryTreeHasher {
  return new BinaryTreeHasher(lgwin, inputSize)
}
