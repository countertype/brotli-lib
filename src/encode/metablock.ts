// Metablock structure and encoding for Brotli compression
// Reference: woff2/brotli/c/enc/metablock.h, brotli_bit_stream.c

import { BitWriter } from './bit-writer'
import { log2FloorNonZero } from './fast-log'
import { BlockSplit } from './block-splitter'
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
} from './context-map'
import { NUM_LITERAL_CODES, NUM_COMMAND_CODES } from './enc-constants'

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
  { offset: 177, nbits: 6 },
  { offset: 241, nbits: 6 },
  { offset: 305, nbits: 7 },
  { offset: 433, nbits: 8 },
  { offset: 561, nbits: 9 },
  { offset: 817, nbits: 10 },
  { offset: 1073, nbits: 11 },
  { offset: 2097, nbits: 12 },
  { offset: 4145, nbits: 13 },
  { offset: 8241, nbits: 14 },
  { offset: 16433, nbits: 15 },
  { offset: 32817, nbits: 16 },
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
