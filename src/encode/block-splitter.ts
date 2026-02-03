// Block splitting for Brotli compression
// Reference: woff2/brotli/c/enc/block_splitter.h, block_splitter_inc.h

import { fastLog2 } from './fast-log'
import { Command, commandCopyLen } from './command'
import {
  ClusterHistogram,
  createClusterHistogram,
  clearClusterHistogram,
  addClusterHistograms,
  computeClusterBitCost,
  clusterHistograms,
} from './cluster'
const MIN_LENGTH_FOR_BLOCK_SPLITTING = 128
export const MAX_NUMBER_OF_BLOCK_TYPES = 256
const ITER_MUL_FOR_REFINING = 2
const MIN_ITERS_FOR_REFINING = 100

export interface BlockSplit {
  numTypes: number
  types: Uint8Array
  lengths: Uint32Array
  numBlocks: number
}

export function createBlockSplit(maxBlocks: number = 256): BlockSplit {
  return {
    numTypes: 1,
    types: new Uint8Array(maxBlocks),
    lengths: new Uint32Array(maxBlocks),
    numBlocks: 0,
  }
}

function myRand(seed: { value: number }): number {
  // Simple linear congruential generator
  seed.value = (seed.value * 16807) | 0
  if (seed.value < 0) seed.value += 0x7FFFFFFF
  return seed.value
}

// Block Splitting Core Algorithm

function initialEntropyCodes(
  data: Uint8Array | Uint16Array,
  length: number,
  stride: number,
  numHistograms: number,
  histograms: ClusterHistogram[]
): void {
  const seed = { value: 7 }
  const blockLength = Math.floor(length / numHistograms)
  
  for (let i = 0; i < numHistograms; i++) {
    clearClusterHistogram(histograms[i])
  }
  
  for (let i = 0; i < numHistograms; i++) {
    let pos = Math.floor(length * i / numHistograms)
    if (i !== 0) {
      pos += myRand(seed) % blockLength
    }
    if (pos + stride >= length) {
      pos = length - stride - 1
    }
    
    // Add vector to histogram
    for (let j = 0; j < stride && pos + j < length; j++) {
      const symbol = data[pos + j]
      histograms[i].data[symbol]++
      histograms[i].totalCount++
    }
  }
}

function refineEntropyCodes(
  data: Uint8Array | Uint16Array,
  length: number,
  stride: number,
  numHistograms: number,
  histograms: ClusterHistogram[],
  tmp: ClusterHistogram
): void {
  let iters = ITER_MUL_FOR_REFINING * Math.floor(length / stride) + MIN_ITERS_FOR_REFINING
  const seed = { value: 7 }
  
  iters = Math.floor((iters + numHistograms - 1) / numHistograms) * numHistograms
  
  for (let iter = 0; iter < iters; iter++) {
    clearClusterHistogram(tmp)
    
    // Random sample
    let pos = 0
    if (stride >= length) {
      // Use entire data
      for (let j = 0; j < length; j++) {
        tmp.data[data[j]]++
        tmp.totalCount++
      }
    } else {
      pos = myRand(seed) % (length - stride + 1)
      for (let j = 0; j < stride; j++) {
        tmp.data[data[pos + j]]++
        tmp.totalCount++
      }
    }
    
    addClusterHistograms(histograms[iter % numHistograms], tmp)
  }
}

function bitCost(count: number): number {
  return count === 0 ? fastLog2(1) + 2 : fastLog2(count)
}

// DP on insert costs
function findBlocks(
  data: Uint8Array | Uint16Array,
  length: number,
  blockSwitchBitcost: number,
  numHistograms: number,
  histograms: ClusterHistogram[],
  blockId: Uint8Array
): number {
  const alphabetSize = histograms[0].data.length
  const bitmapLen = (numHistograms + 7) >>> 3
  
  // Trivial case
  if (numHistograms <= 1) {
    for (let i = 0; i < length; i++) {
      blockId[i] = 0
    }
    return 1
  }
  
  // Pre-compute insert costs
  const insertCost = new Float64Array(alphabetSize * numHistograms)
  
  // First row: log2(total_count) for each histogram
  for (let i = 0; i < numHistograms; i++) {
    insertCost[i] = fastLog2(histograms[i].totalCount)
  }
  
  // Compute costs for each symbol
  for (let i = alphabetSize - 1; i >= 0; i--) {
    for (let j = 0; j < numHistograms; j++) {
      insertCost[i * numHistograms + j] = 
        insertCost[j] - bitCost(histograms[j].data[i])
    }
  }
  
  // DP to find best block assignment
  const cost = new Float64Array(numHistograms)
  const switchSignal = new Uint8Array(length * bitmapLen)
  
  let numBlocks = 1
  
  for (let byteIx = 0; byteIx < length; byteIx++) {
    const ix = byteIx * bitmapLen
    const symbol = data[byteIx]
    const insertCostIx = symbol * numHistograms
    let minCost = 1e99
    let blockSwitchCost = blockSwitchBitcost
    
    // Reduce block switch cost at the beginning
    const prologueLength = 2000
    const multiplier = 0.07 / 2000
    if (byteIx < prologueLength) {
      blockSwitchCost *= 0.77 + multiplier * byteIx
    }
    
    // Update costs
    for (let k = 0; k < numHistograms; k++) {
      cost[k] += insertCost[insertCostIx + k]
      if (cost[k] < minCost) {
        minCost = cost[k]
        blockId[byteIx] = k
      }
    }
    
    // Normalize costs and mark switches
    for (let k = 0; k < numHistograms; k++) {
      cost[k] -= minCost
      if (cost[k] >= blockSwitchCost) {
        const mask = 1 << (k & 7)
        cost[k] = blockSwitchCost
        switchSignal[ix + (k >>> 3)] |= mask
      }
    }
  }
  
  // Trace back to find block boundaries
  let byteIx = length - 1
  let curId = blockId[byteIx]
  
  while (byteIx > 0) {
    const mask = 1 << (curId & 7)
    byteIx--
    const ix = byteIx * bitmapLen
    
    if (switchSignal[ix + (curId >>> 3)] & mask) {
      if (curId !== blockId[byteIx]) {
        curId = blockId[byteIx]
        numBlocks++
      }
    }
    blockId[byteIx] = curId
  }
  
  return numBlocks
}

function remapBlockIds(
  blockIds: Uint8Array,
  length: number,
  numHistograms: number
): number {
  const newId = new Uint16Array(numHistograms)
  const INVALID_ID = 256
  newId.fill(INVALID_ID)
  
  let nextId = 0
  for (let i = 0; i < length; i++) {
    if (newId[blockIds[i]] === INVALID_ID) {
      newId[blockIds[i]] = nextId++
    }
  }
  
  for (let i = 0; i < length; i++) {
    blockIds[i] = newId[blockIds[i]]
  }
  
  return nextId
}

function buildBlockHistograms(
  data: Uint8Array | Uint16Array,
  length: number,
  blockIds: Uint8Array,
  numHistograms: number,
  histograms: ClusterHistogram[]
): void {
  for (let i = 0; i < numHistograms; i++) {
    clearClusterHistogram(histograms[i])
  }
  
  for (let i = 0; i < length; i++) {
    const h = histograms[blockIds[i]]
    h.data[data[i]]++
    h.totalCount++
  }
}

// Main entry point for block splitting
export function splitByteVector(
  data: Uint8Array | Uint16Array,
  length: number,
  alphabetSize: number,
  symbolsPerHistogram: number,
  maxHistograms: number,
  samplingStrideLength: number,
  blockSwitchCost: number,
  quality: number,
  split: BlockSplit
): void {
  // Calculate number of histograms
  let numHistograms = Math.floor(length / symbolsPerHistogram) + 1
  if (numHistograms > maxHistograms) {
    numHistograms = maxHistograms
  }
  
  // Corner case: no input
  if (length === 0) {
    split.numTypes = 1
    return
  }
  
  // Too short for block splitting
  if (length < MIN_LENGTH_FOR_BLOCK_SPLITTING) {
    split.numTypes = 1
    split.types[split.numBlocks] = 0
    split.lengths[split.numBlocks] = length
    split.numBlocks++
    return
  }
  
  // Allocate histograms
  const histograms: ClusterHistogram[] = []
  for (let i = 0; i < numHistograms + 1; i++) {
    histograms.push(createClusterHistogram(alphabetSize))
  }
  const tmp = histograms[numHistograms]
  
  // Find good entropy codes
  initialEntropyCodes(data, length, samplingStrideLength, numHistograms, histograms)
  refineEntropyCodes(data, length, samplingStrideLength, numHistograms, histograms, tmp)
  
  // Find blocks using the entropy codes
  const blockIds = new Uint8Array(length)
  const iters = quality < 10 ? 3 : 10
  let numBlocks = 0
  
  for (let i = 0; i < iters; i++) {
    numBlocks = findBlocks(
      data, length, blockSwitchCost,
      numHistograms, histograms, blockIds
    )
    numHistograms = remapBlockIds(blockIds, length, numHistograms)
    buildBlockHistograms(data, length, blockIds, numHistograms, histograms)
  }
  
  // Cluster blocks
  clusterBlocks(data, length, numBlocks, blockIds, histograms, alphabetSize, split)
}

function clusterBlocks(
  data: Uint8Array | Uint16Array,
  length: number,
  numBlocks: number,
  blockIds: Uint8Array,
  _histograms: ClusterHistogram[],
  alphabetSize: number,
  split: BlockSplit
): void {
  // Calculate block lengths
  const blockLengths = new Uint32Array(numBlocks)
  let blockIdx = 0
  
  for (let i = 0; i < length; i++) {
    blockLengths[blockIdx]++
    if (i + 1 === length || blockIds[i] !== blockIds[i + 1]) {
      blockIdx++
    }
  }
  
  // Build histogram for each block
  const blockHistograms: ClusterHistogram[] = []
  const histogramSymbols = new Uint32Array(numBlocks)
  let pos = 0
  
  for (let i = 0; i < numBlocks; i++) {
    const h = createClusterHistogram(alphabetSize)
    for (let j = 0; j < blockLengths[i]; j++) {
      h.data[data[pos++]]++
      h.totalCount++
    }
    h.bitCost = computeClusterBitCost(h)
    blockHistograms.push(h)
    histogramSymbols[i] = i
  }
  
  // Cluster the histograms
  const out: ClusterHistogram[] = []
  for (let i = 0; i < numBlocks; i++) {
    out.push(createClusterHistogram(alphabetSize))
  }
  
  clusterHistograms(
    blockHistograms, numBlocks, MAX_NUMBER_OF_BLOCK_TYPES,
    out, histogramSymbols
  )
  
  // Build final block split
  const newIndex = new Uint32Array(numBlocks)
  const INVALID_INDEX = 0xFFFFFFFF
  newIndex.fill(INVALID_INDEX)
  
  let nextIndex = 0
  let curLength = 0
  let splitBlockIdx = 0
  
  for (let i = 0; i < numBlocks; i++) {
    curLength += blockLengths[i]
    
    if (i + 1 === numBlocks || histogramSymbols[i] !== histogramSymbols[i + 1]) {
      const symbol = histogramSymbols[i]
      if (newIndex[symbol] === INVALID_INDEX) {
        newIndex[symbol] = nextIndex++
      }
      
      split.types[splitBlockIdx] = newIndex[symbol]
      split.lengths[splitBlockIdx] = curLength
      curLength = 0
      splitBlockIdx++
    }
  }
  
  split.numBlocks = splitBlockIdx
  split.numTypes = nextIndex
}

// High-Level Block Splitting

export function splitBlock(
  commands: Command[],
  data: Uint8Array,
  offset: number,
  mask: number,
  quality: number,
  literalSplit: BlockSplit,
  insertAndCopySplit: BlockSplit,
  distSplit: BlockSplit
): void {
  // Extract literals from commands
  const literals: number[] = []
  const insertAndCopyCodes: number[] = []
  const distanceCodes: number[] = []
  
  let pos = offset
  
  for (const cmd of commands) {
    // Collect literals
    for (let i = 0; i < cmd.insertLen; i++) {
      literals.push(data[pos & mask])
      pos++
    }
    
    // Collect insert-and-copy code
    insertAndCopyCodes.push(cmd.cmdPrefix)
    
    // Collect distance code (if not implicit)
    if (cmd.cmdPrefix >= 128) {
      distanceCodes.push(cmd.distPrefix & 0x3FF)
    }
    
    pos += commandCopyLen(cmd)
  }
  
  // Split literals (alphabet size 256)
  if (literals.length > 0) {
    const literalData = new Uint8Array(literals)
    splitByteVector(
      literalData, literals.length, 256,
      512, 64, 70, 26.0, quality, literalSplit
    )
  } else {
    literalSplit.numTypes = 1
    literalSplit.numBlocks = 0
  }
  
  // Split insert-and-copy commands (alphabet size 704)
  if (insertAndCopyCodes.length > 0) {
    const cmdData = new Uint16Array(insertAndCopyCodes)
    splitByteVector(
      cmdData, insertAndCopyCodes.length, 704,
      1024, 64, 50, 28.1, quality, insertAndCopySplit
    )
  } else {
    insertAndCopySplit.numTypes = 1
    insertAndCopySplit.numBlocks = 0
  }
  
  // Split distances (alphabet size depends on params)
  if (distanceCodes.length > 0) {
    const distData = new Uint16Array(distanceCodes)
    splitByteVector(
      distData, distanceCodes.length, 544,
      512, 64, 50, 28.1, quality, distSplit
    )
  } else {
    distSplit.numTypes = 1
    distSplit.numBlocks = 0
  }
}
