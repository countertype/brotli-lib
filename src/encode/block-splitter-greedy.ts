// Greedy block splitting, used below quality 10.
// Reference: c/enc/metablock_inc.h (BlockSplitter) and
// c/enc/metablock.c (BrotliBuildMetaBlockGreedy).
//
// One pass over the symbols: collect a block, then either start a new block
// type, reuse the type from two blocks back, or merge into the previous block,
// whichever the entropy estimate favours. Far cheaper than the iterative
// splitter in block-splitter.ts, at a small cost in ratio

import { Command, commandCopyLen } from './command'
import { bitsEntropy } from './bit-cost'
import type { BlockSplit } from './block-splitter'

const MAX_NUMBER_OF_BLOCK_TYPES = 256

class GreedyBlockSplitter {
  private numBlocks = 0
  private histograms: Uint32Array[] = []
  private combined: [Uint32Array, Uint32Array]
  private targetBlockSize: number
  private blockSize = 0
  private current: Uint32Array
  private currIx = 0
  private lastIx0 = 0
  private lastIx1 = 0
  private lastEntropy0 = 0
  private lastEntropy1 = 0
  private mergeLastCount = 0

  constructor(
    private alphabetSize: number,
    private minBlockSize: number,
    private splitThreshold: number,
    numSymbols: number,
    private split: BlockSplit
  ) {
    const maxNumBlocks = Math.floor(numSymbols / minBlockSize) + 1
    if (split.types.length < maxNumBlocks) {
      split.types = new Uint8Array(maxNumBlocks)
      split.lengths = new Uint32Array(maxNumBlocks)
    }
    split.numTypes = 0
    split.numBlocks = 0
    this.targetBlockSize = minBlockSize
    this.combined = [new Uint32Array(alphabetSize), new Uint32Array(alphabetSize)]
    this.current = this.histogramAt(0)
  }

  // One more histogram than the maximum number of block types can be live,
  // for the block still being collected
  private histogramAt(ix: number): Uint32Array {
    let h = this.histograms[ix]
    if (h === undefined) {
      h = new Uint32Array(this.alphabetSize)
      this.histograms[ix] = h
    } else {
      h.fill(0)
    }
    return h
  }

  addSymbol(symbol: number): void {
    this.current[symbol]++
    if (++this.blockSize === this.targetBlockSize) {
      this.finishBlock(false)
    }
  }

  finishBlock(isFinal: boolean): void {
    const split = this.split
    const histograms = this.histograms
    this.blockSize = Math.max(this.blockSize, this.minBlockSize)

    if (this.numBlocks === 0) {
      split.lengths[0] = this.blockSize
      split.types[0] = 0
      this.lastEntropy0 = bitsEntropy(histograms[0])
      this.lastEntropy1 = this.lastEntropy0
      this.numBlocks++
      split.numTypes++
      this.currIx++
      this.current = this.histogramAt(this.currIx)
      this.blockSize = 0
    } else if (this.blockSize > 0) {
      const cur = this.current
      const entropy = bitsEntropy(cur)
      const c0 = this.combined[0]
      const c1 = this.combined[1]
      const h0 = histograms[this.lastIx0]
      const h1 = histograms[this.lastIx1]
      for (let i = 0; i < this.alphabetSize; i++) {
        c0[i] = cur[i] + h0[i]
        c1[i] = cur[i] + h1[i]
      }
      const combinedEntropy0 = bitsEntropy(c0)
      const combinedEntropy1 = bitsEntropy(c1)
      const diff0 = combinedEntropy0 - entropy - this.lastEntropy0
      const diff1 = combinedEntropy1 - entropy - this.lastEntropy1

      if (split.numTypes < MAX_NUMBER_OF_BLOCK_TYPES &&
          diff0 > this.splitThreshold && diff1 > this.splitThreshold) {
        // New block type
        split.lengths[this.numBlocks] = this.blockSize
        split.types[this.numBlocks] = split.numTypes
        this.lastIx1 = this.lastIx0
        this.lastIx0 = split.numTypes
        this.lastEntropy1 = this.lastEntropy0
        this.lastEntropy0 = entropy
        this.numBlocks++
        split.numTypes++
        this.currIx++
        this.current = this.histogramAt(this.currIx)
        this.blockSize = 0
        this.mergeLastCount = 0
        this.targetBlockSize = this.minBlockSize
      } else if (diff1 < diff0 - 20.0) {
        // Same type as the block before last
        split.lengths[this.numBlocks] = this.blockSize
        split.types[this.numBlocks] = split.types[this.numBlocks - 2]
        const t = this.lastIx0
        this.lastIx0 = this.lastIx1
        this.lastIx1 = t
        histograms[this.lastIx0].set(c1)
        this.lastEntropy1 = this.lastEntropy0
        this.lastEntropy0 = combinedEntropy1
        this.numBlocks++
        this.blockSize = 0
        cur.fill(0)
        this.mergeLastCount = 0
        this.targetBlockSize = this.minBlockSize
      } else {
        // Extend the previous block
        split.lengths[this.numBlocks - 1] += this.blockSize
        histograms[this.lastIx0].set(c0)
        this.lastEntropy0 = combinedEntropy0
        if (split.numTypes === 1) {
          this.lastEntropy1 = this.lastEntropy0
        }
        this.blockSize = 0
        cur.fill(0)
        if (++this.mergeLastCount > 1) {
          this.targetBlockSize += this.minBlockSize
        }
      }
    }
    if (isFinal) {
      split.numBlocks = this.numBlocks
    }
  }
}

export function splitBlockGreedy(
  commands: Command[],
  data: Uint8Array,
  offset: number,
  mask: number,
  literalSplit: BlockSplit,
  insertAndCopySplit: BlockSplit,
  distSplit: BlockSplit
): void {
  let numLiterals = 0
  for (let i = 0; i < commands.length; i++) numLiterals += commands[i].insertLen

  const lit = new GreedyBlockSplitter(256, 512, 400.0, numLiterals, literalSplit)
  const cmd = new GreedyBlockSplitter(704, 1024, 500.0, commands.length, insertAndCopySplit)
  const dist = new GreedyBlockSplitter(544, 512, 100.0, commands.length, distSplit)

  let pos = offset
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i]
    cmd.addSymbol(c.cmdPrefix)
    for (let j = c.insertLen; j !== 0; j--) {
      lit.addSymbol(data[pos & mask])
      pos++
    }
    const copyLen = commandCopyLen(c)
    pos += copyLen
    if (copyLen !== 0 && c.cmdPrefix >= 128) {
      dist.addSymbol(c.distPrefix & 0x3FF)
    }
  }

  lit.finishBlock(true)
  cmd.finishBlock(true)
  dist.finishBlock(true)
}
