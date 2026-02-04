// Metablock structure and encoding for Brotli compression
// Reference: woff2/brotli/c/enc/metablock.h, brotli_bit_stream.c

import { BitWriter } from './bit-writer'
import { log2FloorNonZero } from './fast-log'
import { BlockSplit, splitBlock, createBlockSplit } from './block-splitter'
import {
  HistogramLiteral,
  HistogramCommand,
  HistogramDistance,
  createHistogramLiteral,
  createHistogramCommand,
  createHistogramDistance,
  histogramAdd,
} from './histogram'
import {
  Command,
  commandCopyLen,
  commandCopyLenCode,
  getInsertLengthCode,
  getCopyLengthCode,
  getInsertBase,
  getInsertExtra,
  getCopyBase,
  getCopyExtra,
} from './command'
import {
  buildAndStoreHuffmanTree,
  storeVarLenUint8,
  encodeContextMap,
} from './context-map'
import { NUM_LITERAL_CODES, NUM_COMMAND_CODES } from './enc-constants'
import { ContextType, getContextLut, getContext, chooseContextMode, NUM_LITERAL_CONTEXTS, NUM_DISTANCE_CONTEXTS } from './context'
import { clusterHistograms, createClusterHistogram, computeClusterBitCost } from './cluster'

// Block length prefix code table - must match decoder exactly
const BLOCK_LENGTH_PREFIX_RANGES = [
  { offset: 1, nbits: 2 },
  { offset: 5, nbits: 2 },
  { offset: 9, nbits: 2 },
  { offset: 13, nbits: 2 },
  { offset: 17, nbits: 3 },
  { offset: 25, nbits: 3 },
  { offset: 33, nbits: 3 },
  { offset: 41, nbits: 3 },
  { offset: 49, nbits: 4 },
  { offset: 65, nbits: 4 },
  { offset: 81, nbits: 4 },
  { offset: 97, nbits: 4 },
  { offset: 113, nbits: 5 },
  { offset: 145, nbits: 5 },
  { offset: 177, nbits: 5 },
  { offset: 209, nbits: 5 },
  { offset: 241, nbits: 6 },
  { offset: 305, nbits: 6 },
  { offset: 369, nbits: 7 },
  { offset: 497, nbits: 8 },
  { offset: 753, nbits: 9 },
  { offset: 1265, nbits: 10 },
  { offset: 2289, nbits: 11 },
  { offset: 4337, nbits: 12 },
  { offset: 8433, nbits: 13 },
  { offset: 16625, nbits: 24 },
]

export const NUM_BLOCK_LEN_SYMBOLS = 26
export const MAX_BLOCK_TYPE_SYMBOLS = 258
export const LITERAL_CONTEXT_BITS = 6
export const DISTANCE_CONTEXT_BITS = 2

// MetaBlockSplit Structure

export interface MetaBlockSplit {
  literalSplit: BlockSplit
  commandSplit: BlockSplit
  distanceSplit: BlockSplit
  
  literalContextMap: Uint32Array | null
  literalContextMapSize: number
  distanceContextMap: Uint32Array | null
  distanceContextMapSize: number
  
  literalHistograms: HistogramLiteral[]
  commandHistograms: HistogramCommand[]
  distanceHistograms: HistogramDistance[]
}

export function createMetaBlockSplit(): MetaBlockSplit {
  return {
    literalSplit: {
      numTypes: 1,
      types: new Uint8Array(1),
      lengths: new Uint32Array(1),
      numBlocks: 0,
    },
    commandSplit: {
      numTypes: 1,
      types: new Uint8Array(1),
      lengths: new Uint32Array(1),
      numBlocks: 0,
    },
    distanceSplit: {
      numTypes: 1,
      types: new Uint8Array(1),
      lengths: new Uint32Array(1),
      numBlocks: 0,
    },
    literalContextMap: null,
    literalContextMapSize: 0,
    distanceContextMap: null,
    distanceContextMapSize: 0,
    literalHistograms: [],
    commandHistograms: [],
    distanceHistograms: [],
  }
}

export function blockLengthPrefixCode(len: number): number {
  let code = len >= 177 ? (len >= 753 ? 20 : 14) : (len >= 41 ? 7 : 0)
  while (code < NUM_BLOCK_LEN_SYMBOLS - 1 &&
         len >= BLOCK_LENGTH_PREFIX_RANGES[code + 1].offset) {
    code++
  }
  return code
}

export function getBlockLengthPrefixCode(len: number): [number, number, number] {
  const code = blockLengthPrefixCode(len)
  const range = BLOCK_LENGTH_PREFIX_RANGES[code]
  return [code, range.nbits, len - range.offset]
}

export class BlockTypeCodeCalculator {
  lastType = 1
  secondLastType = 0
  
  nextCode(type: number): number {
    let typeCode: number
    if (type === this.lastType + 1) {
      typeCode = 1
    } else if (type === this.secondLastType) {
      typeCode = 0
    } else {
      typeCode = type + 2
    }
    this.secondLastType = this.lastType
    this.lastType = type
    return typeCode
  }
}

export interface BlockSplitCode {
  typeDepths: Uint8Array
  typeBits: Uint16Array
  lengthDepths: Uint8Array
  lengthBits: Uint16Array
  typeCalculator: BlockTypeCodeCalculator
}

// Build block split code and store to bitstream. Returns the code for later use.
export function buildAndStoreBlockSplitCode(
  writer: BitWriter,
  types: Uint8Array,
  lengths: Uint32Array,
  numBlocks: number,
  numTypes: number
): BlockSplitCode {
  const code: BlockSplitCode = {
    typeDepths: new Uint8Array(numTypes + 2),
    typeBits: new Uint16Array(numTypes + 2),
    lengthDepths: new Uint8Array(NUM_BLOCK_LEN_SYMBOLS),
    lengthBits: new Uint16Array(NUM_BLOCK_LEN_SYMBOLS),
    typeCalculator: new BlockTypeCodeCalculator(),
  }
  
  // Build histograms
  const typeHisto = new Uint32Array(numTypes + 2)
  const lengthHisto = new Uint32Array(NUM_BLOCK_LEN_SYMBOLS)
  
  const calc = new BlockTypeCodeCalculator()
  for (let i = 0; i < numBlocks; i++) {
    const typeCode = calc.nextCode(types[i])
    if (i !== 0) typeHisto[typeCode]++
    lengthHisto[blockLengthPrefixCode(lengths[i])]++
  }
  
  // Store number of block types - 1
  storeVarLenUint8(writer, numTypes - 1)
  
  if (numTypes > 1) {
    // Build and store type Huffman tree
    buildAndStoreHuffmanTree(writer, typeHisto, numTypes + 2, code.typeDepths, code.typeBits)
    
    // Build and store length Huffman tree
    buildAndStoreHuffmanTree(writer, lengthHisto, NUM_BLOCK_LEN_SYMBOLS, code.lengthDepths, code.lengthBits)
    
    // Store first block switch
    storeBlockSwitch(writer, code, lengths[0], types[0], true)
  }
  
  return code
}

export function storeBlockSwitch(
  writer: BitWriter,
  code: BlockSplitCode,
  blockLen: number,
  blockType: number,
  isFirstBlock: boolean
): void {
  const typeCode = code.typeCalculator.nextCode(blockType)
  
  if (!isFirstBlock) {
    writer.writeBits(code.typeDepths[typeCode], code.typeBits[typeCode])
  }
  
  const [lenCode, lenNExtra, lenExtra] = getBlockLengthPrefixCode(blockLen)
  writer.writeBits(code.lengthDepths[lenCode], code.lengthBits[lenCode])
  writer.writeBits(lenNExtra, lenExtra)
}

export function encodeMlen(length: number): { bits: bigint; numBits: number; nibblesBits: number } {
  const lg = length === 1 ? 1 : log2FloorNonZero(length - 1) + 1
  const mnibbles = Math.floor((lg < 16 ? 16 : lg + 3) / 4)
  
  return {
    bits: BigInt(length - 1),
    numBits: mnibbles * 4,
    nibblesBits: mnibbles - 4,
  }
}

export function storeCompressedMetaBlockHeader(
  writer: BitWriter,
  isLast: boolean,
  length: number
): void {
  // ISLAST
  writer.writeBits(1, isLast ? 1 : 0)
  
  // ISEMPTY (only for last block)
  if (isLast) {
    writer.writeBits(1, 0) // Not empty
  }
  
  // MLEN
  const { bits, numBits, nibblesBits } = encodeMlen(length)
  writer.writeBits(2, nibblesBits)
  writer.writeBitsLong(numBits, bits)
  
  // ISUNCOMPRESSED (only for non-last blocks)
  if (!isLast) {
    writer.writeBits(1, 0) // Compressed
  }
}

export function storeUncompressedMetaBlockHeader(
  writer: BitWriter,
  length: number
): void {
  // ISLAST = 0 (uncompressed cannot be last)
  writer.writeBits(1, 0)
  
  // MLEN
  const { bits, numBits, nibblesBits } = encodeMlen(length)
  writer.writeBits(2, nibblesBits)
  writer.writeBitsLong(numBits, bits)
  
  // ISUNCOMPRESSED = 1
  writer.writeBits(1, 1)
}

export function storeCommandExtra(writer: BitWriter, cmd: Command): void {
  const copyLenCode = commandCopyLenCode(cmd)
  const insCode = getInsertLengthCode(cmd.insertLen)
  const copyCode = getCopyLengthCode(copyLenCode)
  
  const insNumExtra = getInsertExtra(insCode)
  const insExtraVal = cmd.insertLen - getInsertBase(insCode)
  const copyExtraVal = copyLenCode - getCopyBase(copyCode)
  
  // Pack both extra values together
  const totalBits = insNumExtra + getCopyExtra(copyCode)
  const combinedBits = (copyExtraVal << insNumExtra) | insExtraVal
  
  writer.writeBits(totalBits, combinedBits)
}

// Store a trivial (no block splitting) metablock
export function storeMetaBlockTrivial(
  writer: BitWriter,
  input: Uint8Array,
  startPos: number,
  length: number,
  mask: number,
  isLast: boolean,
  commands: Command[],
  distanceAlphabetSize: number
): void {
  // Store header
  storeCompressedMetaBlockHeader(writer, isLast, length)
  
  // Build histograms from commands
  const litHisto = createHistogramLiteral()
  const cmdHisto = createHistogramCommand()
  const distHisto = createHistogramDistance()
  
  let pos = startPos
  for (const cmd of commands) {
    histogramAdd(cmdHisto, cmd.cmdPrefix)
    
    for (let j = 0; j < cmd.insertLen; j++) {
      histogramAdd(litHisto, input[(pos + j) & mask])
    }
    pos += cmd.insertLen
    
    const copyLen = commandCopyLen(cmd)
    pos += copyLen
    
    if (copyLen && cmd.cmdPrefix >= 128) {
      histogramAdd(distHisto, cmd.distPrefix & 0x3FF)
    }
  }
  
  // 13 zero bits: NBLTYPESL=1, NBLTYPESI=1, NBLTYPESD=1, NPOSTFIX=0, NDIRECT=0
  writer.writeBits(13, 0)
  
  // Build and store Huffman trees
  const litDepths = new Uint8Array(NUM_LITERAL_CODES)
  const litBits = new Uint16Array(NUM_LITERAL_CODES)
  const cmdDepths = new Uint8Array(NUM_COMMAND_CODES)
  const cmdBits = new Uint16Array(NUM_COMMAND_CODES)
  const distDepths = new Uint8Array(distanceAlphabetSize)
  const distBits = new Uint16Array(distanceAlphabetSize)
  
  buildAndStoreHuffmanTree(writer, litHisto.data, NUM_LITERAL_CODES, litDepths, litBits)
  buildAndStoreHuffmanTree(writer, cmdHisto.data, NUM_COMMAND_CODES, cmdDepths, cmdBits)
  buildAndStoreHuffmanTree(writer, distHisto.data, distanceAlphabetSize, distDepths, distBits)
  
  // Store commands and data
  pos = startPos
  for (const cmd of commands) {
    // Store command
    writer.writeBits(cmdDepths[cmd.cmdPrefix], cmdBits[cmd.cmdPrefix])
    storeCommandExtra(writer, cmd)
    
    // Store literals
    for (let j = 0; j < cmd.insertLen; j++) {
      const literal = input[(pos + j) & mask]
      writer.writeBits(litDepths[literal], litBits[literal])
    }
    pos += cmd.insertLen
    
    // Store distance
    const copyLen = commandCopyLen(cmd)
    pos += copyLen
    
    if (copyLen && cmd.cmdPrefix >= 128) {
      const distCode = cmd.distPrefix & 0x3FF
      const distNumExtra = cmd.distPrefix >>> 10
      const distExtra = cmd.distExtra
      
      writer.writeBits(distDepths[distCode], distBits[distCode])
      writer.writeBits(distNumExtra, distExtra)
    }
  }
  
  // Finalize
  if (isLast) {
    writer.alignToByte()
  }
}

// BlockEncoder - manages encoding of one block category with block switches
class BlockEncoder {
  // Public for debug logging
  histogramLength: number
  numBlockTypes: number
  numBlocks: number
  
  private blockTypes: Uint8Array
  private blockLengths: Uint32Array
  private splitCode: BlockSplitCode | null = null
  
  private blockIdx = 0
  private blockLen = 0
  private entropyIdx = 0
  
  // Flattened depths/bits arrays: [cluster0_sym0, cluster0_sym1, ..., cluster1_sym0, ...]
  depths: Uint8Array | null = null
  bits: Uint16Array | null = null
  
  constructor(
    histogramLength: number,
    numBlockTypes: number,
    blockTypes: Uint8Array,
    blockLengths: Uint32Array,
    numBlocks: number
  ) {
    this.histogramLength = histogramLength
    this.numBlockTypes = numBlockTypes
    this.blockTypes = blockTypes
    this.blockLengths = blockLengths
    this.numBlocks = numBlocks
    this.blockLen = numBlocks > 0 ? blockLengths[0] : 0
    this.entropyIdx = 0
  }
  
  // Build and store block switch entropy codes
  buildAndStoreEntropyCodes(writer: BitWriter): void {
    if (this.numBlockTypes > 1) {
      this.splitCode = buildAndStoreBlockSplitCode(
        writer,
        this.blockTypes,
        this.blockLengths,
        this.numBlocks,
        this.numBlockTypes
      )
    } else {
      // Single block type - just write 0 for NBLTYPES-1
      storeVarLenUint8(writer, 0)
    }
  }
  
  // Build Huffman trees from histograms and store them
  buildAndStoreHuffmanTrees(
    writer: BitWriter,
    histograms: Uint32Array[],
    numHistograms: number
  ): void {
    // Allocate flattened arrays
    this.depths = new Uint8Array(numHistograms * this.histogramLength)
    this.bits = new Uint16Array(numHistograms * this.histogramLength)
    
    for (let i = 0; i < numHistograms; i++) {
      const offset = i * this.histogramLength
      const depths = this.depths.subarray(offset, offset + this.histogramLength)
      const bits = this.bits.subarray(offset, offset + this.histogramLength)
      buildAndStoreHuffmanTree(writer, histograms[i], this.histogramLength, depths, bits)
    }
  }
  
  // Store a symbol (for commands - no context)
  storeSymbol(writer: BitWriter, symbol: number): void {
    // Check for block switch
    if (this.blockLen === 0 && this.splitCode && this.blockIdx + 1 < this.numBlocks) {
      this.blockIdx++
      const blockType = this.blockTypes[this.blockIdx]
      this.blockLen = this.blockLengths[this.blockIdx]
      this.entropyIdx = blockType * this.histogramLength
      storeBlockSwitch(writer, this.splitCode, this.blockLen, blockType, false)
    }
    
    this.blockLen--
    
    const ix = this.entropyIdx + symbol
    writer.writeBits(this.depths![ix], this.bits![ix])
  }
  
  // Store a symbol with context (for literals and distances)
  storeSymbolWithContext(
    writer: BitWriter,
    symbol: number,
    context: number,
    contextMap: Uint32Array,
    contextBits: number
  ): void {
    // Check for block switch
    if (this.blockLen === 0 && this.splitCode && this.blockIdx + 1 < this.numBlocks) {
      this.blockIdx++
      const blockType = this.blockTypes[this.blockIdx]
      this.blockLen = this.blockLengths[this.blockIdx]
      this.entropyIdx = blockType << contextBits
      storeBlockSwitch(writer, this.splitCode, this.blockLen, blockType, false)
    }
    
    this.blockLen--
    
    const contextMapIdx = this.entropyIdx + context
    const histoIdx = contextMap[contextMapIdx]
    const ix = histoIdx * this.histogramLength + symbol
    writer.writeBits(this.depths![ix], this.bits![ix])
  }
}

// Full metablock encoding with block splitting and context modeling
export function storeMetaBlock(
  writer: BitWriter,
  input: Uint8Array,
  startPos: number,
  length: number,
  mask: number,
  isLast: boolean,
  commands: Command[],
  distanceAlphabetSize: number,
  quality: number
): void {
  // For short inputs or low quality, use trivial encoding
  if (length < 128 || quality < 5 || commands.length < 6) {
    storeMetaBlockTrivial(writer, input, startPos, length, mask, isLast, commands, distanceAlphabetSize)
    return
  }

  // Split blocks
  const literalSplit = createBlockSplit(1024)
  const commandSplit = createBlockSplit(1024)
  const distanceSplit = createBlockSplit(1024)

  splitBlock(commands, input, startPos, mask, quality, literalSplit, commandSplit, distanceSplit)

  // If splitting didn't produce multiple block types, use trivial encoding
  if (literalSplit.numTypes <= 1 && commandSplit.numTypes <= 1 && distanceSplit.numTypes <= 1) {
    storeMetaBlockTrivial(writer, input, startPos, length, mask, isLast, commands, distanceAlphabetSize)
    return
  }

  // Choose context mode for literals
  const contextMode = chooseContextMode(input, startPos, Math.min(length, 4096))
  const contextLut = getContextLut(contextMode)

  // Build histograms per context
  const numLiteralContexts = literalSplit.numTypes * NUM_LITERAL_CONTEXTS
  const literalHistograms: Uint32Array[] = []
  for (let i = 0; i < numLiteralContexts; i++) {
    literalHistograms.push(new Uint32Array(NUM_LITERAL_CODES))
  }

  const commandHistograms: Uint32Array[] = []
  for (let i = 0; i < commandSplit.numTypes; i++) {
    commandHistograms.push(new Uint32Array(NUM_COMMAND_CODES))
  }

  const numDistanceContexts = distanceSplit.numTypes * NUM_DISTANCE_CONTEXTS
  const distanceHistograms: Uint32Array[] = []
  for (let i = 0; i < numDistanceContexts; i++) {
    distanceHistograms.push(new Uint32Array(distanceAlphabetSize))
  }

  // Populate histograms by walking through commands
  let pos = startPos
  let litBlockIdx = 0
  let litBlockLen = literalSplit.numBlocks > 0 ? literalSplit.lengths[0] : length
  let litBlockType = literalSplit.numBlocks > 0 ? literalSplit.types[0] : 0
  let litCount = 0

  let cmdBlockIdx = 0
  let cmdBlockLen = commandSplit.numBlocks > 0 ? commandSplit.lengths[0] : commands.length
  let cmdBlockType = commandSplit.numBlocks > 0 ? commandSplit.types[0] : 0
  let cmdCount = 0

  let distBlockIdx = 0
  let distBlockLen = distanceSplit.numBlocks > 0 ? distanceSplit.lengths[0] : commands.length
  let distBlockType = distanceSplit.numBlocks > 0 ? distanceSplit.types[0] : 0
  let distCount = 0

  let prevByte1 = 0
  let prevByte2 = 0

  for (const cmd of commands) {
    // Update command block
    while (cmdCount >= cmdBlockLen && cmdBlockIdx + 1 < commandSplit.numBlocks) {
      cmdBlockIdx++
      cmdBlockType = commandSplit.types[cmdBlockIdx]
      cmdBlockLen = commandSplit.lengths[cmdBlockIdx]
      cmdCount = 0
    }
    commandHistograms[cmdBlockType][cmd.cmdPrefix]++
    cmdCount++

    // Process literals
    for (let j = 0; j < cmd.insertLen; j++) {
      // Update literal block
      while (litCount >= litBlockLen && litBlockIdx + 1 < literalSplit.numBlocks) {
        litBlockIdx++
        litBlockType = literalSplit.types[litBlockIdx]
        litBlockLen = literalSplit.lengths[litBlockIdx]
        litCount = 0
      }

      const literal = input[(pos + j) & mask]
      const context = getContext(prevByte1, prevByte2, contextLut)
      const histoIdx = litBlockType * NUM_LITERAL_CONTEXTS + context
      literalHistograms[histoIdx][literal]++
      litCount++

      prevByte2 = prevByte1
      prevByte1 = literal
    }
    pos += cmd.insertLen

    // Process distance
    const copyLen = commandCopyLen(cmd)
    if (copyLen && cmd.cmdPrefix >= 128) {
      // Update distance block
      while (distCount >= distBlockLen && distBlockIdx + 1 < distanceSplit.numBlocks) {
        distBlockIdx++
        distBlockType = distanceSplit.types[distBlockIdx]
        distBlockLen = distanceSplit.lengths[distBlockIdx]
        distCount = 0
      }

      const distCode = cmd.distPrefix & 0x3FF
      const distContext = copyLen > 4 ? 3 : copyLen - 2
      const histoIdx = distBlockType * NUM_DISTANCE_CONTEXTS + distContext
      distanceHistograms[histoIdx][distCode]++
      distCount++
    }

    // Update prev bytes after copy
    if (copyLen > 0) {
      const copyEnd = pos + copyLen
      const p1 = (copyEnd - 1) & mask
      const p2 = (copyEnd - 2) & mask
      prevByte1 = input[p1]
      prevByte2 = input[p2]
    }
    pos += copyLen
  }

  // Cluster literal histograms
  const literalContextMap = new Uint32Array(numLiteralContexts)
  const numLiteralClusters = clusterAndBuildContextMap(
    literalHistograms, numLiteralContexts, NUM_LITERAL_CODES, literalContextMap
  )

  // Cluster distance histograms
  const distanceContextMap = new Uint32Array(numDistanceContexts)
  const numDistanceClusters = clusterAndBuildContextMap(
    distanceHistograms, numDistanceContexts, distanceAlphabetSize, distanceContextMap
  )

  // Build clustered histograms
  const clusteredLitHistos = buildClusteredHistograms(literalHistograms, literalContextMap, numLiteralClusters, NUM_LITERAL_CODES)
  const clusteredDistHistos = buildClusteredHistograms(distanceHistograms, distanceContextMap, numDistanceClusters, distanceAlphabetSize)

  // Command histograms don't use context - one per block type
  // We need to cluster them too if there are multiple block types
  let numCommandClusters = commandSplit.numTypes
  const commandContextMap = new Uint32Array(commandSplit.numTypes)
  for (let i = 0; i < commandSplit.numTypes; i++) {
    commandContextMap[i] = i  // Identity mapping - no clustering for commands
  }

  // Store metablock header
  storeCompressedMetaBlockHeader(writer, isLast, length)

  // Create block encoders
  const literalEnc = new BlockEncoder(
    NUM_LITERAL_CODES,
    literalSplit.numTypes,
    literalSplit.types,
    literalSplit.lengths,
    literalSplit.numBlocks
  )
  const commandEnc = new BlockEncoder(
    NUM_COMMAND_CODES,
    commandSplit.numTypes,
    commandSplit.types,
    commandSplit.lengths,
    commandSplit.numBlocks
  )
  const distanceEnc = new BlockEncoder(
    distanceAlphabetSize,
    distanceSplit.numTypes,
    distanceSplit.types,
    distanceSplit.lengths,
    distanceSplit.numBlocks
  )

  // Store block switch entropy codes
  literalEnc.buildAndStoreEntropyCodes(writer)
  commandEnc.buildAndStoreEntropyCodes(writer)
  distanceEnc.buildAndStoreEntropyCodes(writer)

  // Store NPOSTFIX and NDIRECT (both 0)
  writer.writeBits(2, 0) // NPOSTFIX
  writer.writeBits(4, 0) // NDIRECT >> NPOSTFIX

  // Store context modes for literal (one per block type)
  for (let i = 0; i < literalSplit.numTypes; i++) {
    writer.writeBits(2, contextMode)
  }

  // Store literal context map
  encodeContextMap(writer, literalContextMap, numLiteralContexts, numLiteralClusters)

  // Store distance context map
  encodeContextMap(writer, distanceContextMap, numDistanceContexts, numDistanceClusters)

  // Build and store Huffman trees
  literalEnc.buildAndStoreHuffmanTrees(writer, clusteredLitHistos, numLiteralClusters)
  commandEnc.buildAndStoreHuffmanTrees(writer, commandHistograms, numCommandClusters)
  distanceEnc.buildAndStoreHuffmanTrees(writer, clusteredDistHistos, numDistanceClusters)

  // Store commands and data
  pos = startPos
  prevByte1 = 0
  prevByte2 = 0

  for (const cmd of commands) {
    // Store command
    commandEnc.storeSymbol(writer, cmd.cmdPrefix)
    storeCommandExtra(writer, cmd)

    // Store literals
    for (let j = 0; j < cmd.insertLen; j++) {
      const literal = input[(pos + j) & mask]
      const context = getContext(prevByte1, prevByte2, contextLut)
      literalEnc.storeSymbolWithContext(writer, literal, context, literalContextMap, LITERAL_CONTEXT_BITS)

      prevByte2 = prevByte1
      prevByte1 = literal
    }
    pos += cmd.insertLen

    // Store distance
    const copyLen = commandCopyLen(cmd)
    if (copyLen && cmd.cmdPrefix >= 128) {
      const distCode = cmd.distPrefix & 0x3FF
      const distNumExtra = cmd.distPrefix >>> 10
      const distExtra = cmd.distExtra
      const distContext = copyLen > 4 ? 3 : copyLen - 2
      
      distanceEnc.storeSymbolWithContext(writer, distCode, distContext, distanceContextMap, DISTANCE_CONTEXT_BITS)
      writer.writeBits(distNumExtra, distExtra)
    }

    // Update prev bytes after copy
    if (copyLen > 0) {
      const copyEnd = pos + copyLen
      const p1 = (copyEnd - 1) & mask
      const p2 = (copyEnd - 2) & mask
      prevByte1 = input[p1]
      prevByte2 = input[p2]
    }
    pos += copyLen
  }

  if (isLast) {
    writer.alignToByte()
  }
}

function clusterAndBuildContextMap(
  histograms: Uint32Array[],
  numHistograms: number,
  alphabetSize: number,
  contextMap: Uint32Array
): number {
  if (numHistograms <= 1) {
    contextMap[0] = 0
    return 1
  }

  // Convert to ClusterHistogram format
  const clusterHistos = histograms.map(h => {
    const ch = createClusterHistogram(alphabetSize)
    for (let i = 0; i < alphabetSize; i++) {
      ch.data[i] = h[i]
      ch.totalCount += h[i]
    }
    ch.bitCost = computeClusterBitCost(ch)
    return ch
  })

  // Output
  const out = histograms.map(() => createClusterHistogram(alphabetSize))

  // Cluster
  clusterHistograms(clusterHistos, numHistograms, 64, out, contextMap)

  // Count clusters
  let maxCluster = 0
  for (let i = 0; i < numHistograms; i++) {
    if (contextMap[i] > maxCluster) maxCluster = contextMap[i]
  }

  return maxCluster + 1
}

function buildClusteredHistograms(
  histograms: Uint32Array[],
  contextMap: Uint32Array,
  numClusters: number,
  alphabetSize: number
): Uint32Array[] {
  const result: Uint32Array[] = []
  for (let i = 0; i < numClusters; i++) {
    result.push(new Uint32Array(alphabetSize))
  }

  for (let i = 0; i < histograms.length; i++) {
    const cluster = contextMap[i]
    for (let j = 0; j < alphabetSize; j++) {
      result[cluster][j] += histograms[i][j]
    }
  }

  return result
}

export function storeUncompressedMetaBlock(
  writer: BitWriter,
  input: Uint8Array,
  position: number,
  mask: number,
  length: number,
  isFinal: boolean
): void {
  // Store header
  storeUncompressedMetaBlockHeader(writer, length)
  
  // Align to byte boundary
  writer.alignToByte()
  
  // Copy raw bytes
  let maskedPos = position & mask
  if (maskedPos + length > mask + 1) {
    // Wrap around
    const len1 = mask + 1 - maskedPos
    writer.writeBytes(input.subarray(maskedPos, maskedPos + len1))
    length -= len1
    maskedPos = 0
  }
  writer.writeBytes(input.subarray(maskedPos, maskedPos + length))
  
  // Prepare for more writes
  writer.prepareStorage()
  
  // If final, add empty final block
  if (isFinal) {
    writer.writeBits(1, 1) // ISLAST
    writer.writeBits(1, 1) // ISEMPTY
    writer.alignToByte()
  }
}
