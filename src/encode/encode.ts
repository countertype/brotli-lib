// Main Brotli encoder API
// Reference: woff2/brotli/c/enc/encode.c

import { BitWriter, encodeWindowBits } from './bit-writer'
import { 
  EncoderParams, 
  EncoderMode,
  createDefaultParams, 
  sanitizeParams, 
  computeLgBlock,
  ZOPFLIFICATION_QUALITY,
  HQ_ZOPFLIFICATION_QUALITY,
} from './enc-constants'
import { SimpleHasher, createSimpleHasher } from './hash-simple'
import { HashChainHasher, createHashChainHasher } from './hash-chains'
import { BinaryTreeHasher, createBinaryTreeHasher } from './hash-binary-tree'
import { createBackwardReferences } from './backward-references'
import { createZopfliBackwardReferences, createHqZopfliBackwardReferences } from './backward-references-hq'
import { Command, createInsertCommand, commandCopyLen } from './command'
import { storeMetaBlockTrivial, storeUncompressedMetaBlock } from './metablock'

export interface BrotliEncodeOptions {
  quality?: number    // 0-11, default 11
  lgwin?: number      // 10-24, default 22
  mode?: EncoderMode  // default GENERIC
  sizeHint?: number   // default 0 (unknown)
}

export interface BrotliEncoderState {
  params: EncoderParams
  hasher: SimpleHasher | HashChainHasher | BinaryTreeHasher | null
  distCache: Int32Array
  lastInsertLen: number
  commands: Command[]
  numLiterals: number
  inputPos: number
  lastProcessedPos: number
  ringBuffer: Uint8Array
  ringBufferMask: number
  prevByte: number
  prevByte2: number
  isInitialized: boolean
  isLastBlockEmitted: boolean
  writer: BitWriter
}

// One-Shot Encoding

// Compress data using Brotli
export function brotliEncode(
  input: Uint8Array,
  options: BrotliEncodeOptions = {}
): Uint8Array {
  const params = createDefaultParams()
  
  // Apply options
  if (options.quality !== undefined) {
    params.quality = Math.max(0, Math.min(11, options.quality))
  }
  if (options.lgwin !== undefined) {
    params.lgwin = Math.max(10, Math.min(24, options.lgwin))
  }
  if (options.mode !== undefined) {
    params.mode = options.mode
  }
  if (options.sizeHint !== undefined) {
    params.sizeHint = options.sizeHint
  }
  
  sanitizeParams(params)
  params.lgblock = computeLgBlock(params)
  
  // For very small inputs or quality 0, use uncompressed
  if (input.length === 0) {
    return encodeEmptyInput()
  }
  
  // Use uncompressed for quality 0 or small inputs where compression overhead dominates
  if (params.quality === 0 || input.length < 64) {
    return encodeUncompressed(input)
  }
  
  // For quality 1, use fast compression
  if (params.quality === 1) {
    return encodeFast(input, params)
  }
  
  // Standard compression
  return encodeStandard(input, params)
}

function encodeEmptyInput(): Uint8Array {
  const writer = new BitWriter(16)
  // Write minimum window bits header (lgwin=10)
  const windowBits = encodeWindowBits(10, false)
  writer.writeBits(windowBits.bits, windowBits.value)
  // ISLAST = 1
  writer.writeBits(1, 1)
  // ISEMPTY = 1
  writer.writeBits(1, 1)
  writer.alignToByte()
  return writer.finish()
}

function encodeUncompressed(input: Uint8Array): Uint8Array {
  const writer = new BitWriter(input.length + 32)
  
  // Write window bits (use minimum window size that fits)
  const lgwin = Math.max(10, Math.min(24, 
    input.length <= 1 ? 10 : Math.ceil(Math.log2(input.length)) + 1
  ))
  const windowBits = encodeWindowBits(lgwin, false)
  writer.writeBits(windowBits.bits, windowBits.value)
  
  // Write uncompressed metablock
  const maxBlockSize = (1 << 24) - 1
  let pos = 0
  
  while (pos < input.length) {
    const blockSize = Math.min(input.length - pos, maxBlockSize)
    const isLast = pos + blockSize >= input.length
    
    if (isLast) {
      // Last block: write as uncompressed then add empty final
      storeUncompressedMetaBlock(
        writer, input, pos, input.length - 1, blockSize, true
      )
    } else {
      storeUncompressedMetaBlock(
        writer, input, pos, input.length - 1, blockSize, false
      )
    }
    
    pos += blockSize
  }
  
  return writer.finish()
}

function encodeFast(input: Uint8Array, params: EncoderParams): Uint8Array {
  const writer = new BitWriter(input.length)
  
  // Write window bits
  const windowBits = encodeWindowBits(params.lgwin, false)
  writer.writeBits(windowBits.bits, windowBits.value)
  
  // Create hasher
  const hasher = createSimpleHasher(params.quality, params.lgwin)
  const distCache = new Int32Array([4, 11, 15, 16])
  const ringBufferMask = (1 << params.lgwin) - 1
  
  // Process in blocks
  const blockSize = 1 << params.lgblock
  let pos = 0
  
  while (pos < input.length) {
    const blockLen = Math.min(input.length - pos, blockSize)
    const isLast = pos + blockLen >= input.length
    
    // Find backward references
    const [commands] = createBackwardReferences(
      blockLen, pos, input, ringBufferMask,
      hasher, distCache, 0, params.quality
    )
    
    // Store metablock
    const distAlphabetSize = 16 + (48 << params.dist.distancePostfixBits)
    storeMetaBlockTrivial(
      writer, input, pos, blockLen, ringBufferMask,
      isLast, commands, distAlphabetSize
    )
    
    pos += blockLen
  }
  
  return writer.finish()
}

function encodeStandard(input: Uint8Array, params: EncoderParams): Uint8Array {
  // Estimate output size
  const estimatedSize = Math.max(1024, Math.floor(input.length * 1.2))
  const writer = new BitWriter(estimatedSize)
  
  // Write window bits
  const windowBits = encodeWindowBits(params.lgwin, params.largeWindow)
  writer.writeBits(windowBits.bits, windowBits.value)
  
  // Create appropriate hasher based on quality
  let hasher: SimpleHasher | HashChainHasher | BinaryTreeHasher
  
  if (params.quality <= 4) {
    hasher = createSimpleHasher(params.quality, params.lgwin)
  } else if (params.quality <= 9) {
    hasher = createHashChainHasher(params.quality, params.lgwin)
  } else {
    hasher = createBinaryTreeHasher(params.lgwin, input.length)
  }
  
  // Initialize state
  const distCache = new Int32Array([4, 11, 15, 16])
  const ringBufferMask = (1 << params.lgwin) - 1
  
  // Process in metablocks
  const maxMetablockSize = 1 << 24
  let pos = 0
  
  while (pos < input.length) {
    const metablockLen = Math.min(input.length - pos, maxMetablockSize)
    const isLast = pos + metablockLen >= input.length
    
    // Find backward references
    let commands: Command[]
    let lastInsertLen = 0
    
    if (params.quality >= HQ_ZOPFLIFICATION_QUALITY && hasher instanceof BinaryTreeHasher) {
      // Quality 11: use HQ Zopfli
      [commands, , lastInsertLen] = createHqZopfliBackwardReferences(
        metablockLen, pos, input, ringBufferMask,
        hasher, distCache, 0
      )
    } else if (params.quality >= ZOPFLIFICATION_QUALITY && hasher instanceof BinaryTreeHasher) {
      // Quality 10: use Zopfli
      [commands, , lastInsertLen] = createZopfliBackwardReferences(
        metablockLen, pos, input, ringBufferMask,
        params.quality, hasher, distCache, 0
      )
    } else if (hasher instanceof HashChainHasher) {
      // Quality 5-9: use hash chains
      [commands, , lastInsertLen] = createBackwardReferences(
        metablockLen, pos, input, ringBufferMask,
        hasher, distCache, 0, params.quality
      )
    } else if (hasher instanceof SimpleHasher) {
      // Quality 2-4: use simple hasher
      [commands, , lastInsertLen] = createBackwardReferences(
        metablockLen, pos, input, ringBufferMask,
        hasher, distCache, 0, params.quality
      )
    } else {
      // Fallback
      commands = [createInsertCommand(metablockLen)]
    }
    
    // Handle trailing literals (Zopfli returns these separately).
    // Insert length is *before* the copy; we may only merge with an insert-only
    // command (copyLen == 0).
    if (lastInsertLen > 0) {
      if (commands.length === 0) {
        commands = [createInsertCommand(metablockLen)]
      } else {
        const lastCmd = commands[commands.length - 1]
        if (commandCopyLen(lastCmd) === 0) {
          lastCmd.insertLen += lastInsertLen
        } else {
          commands.push(createInsertCommand(lastInsertLen))
        }
      }
    } else if (commands.length === 0) {
      // All literals, no matches
      commands = [createInsertCommand(metablockLen)]
    }
    
    // Store metablock
    const distAlphabetSize = calculateDistanceAlphabetSize(params)
    storeMetaBlockTrivial(
      writer, input, pos, metablockLen, ringBufferMask,
      isLast, commands, distAlphabetSize
    )
    
    pos += metablockLen
  }
  
  return writer.finish()
}

function calculateDistanceAlphabetSize(params: EncoderParams): number {
  const npostfix = params.dist.distancePostfixBits
  const ndirect = params.dist.numDirectDistanceCodes
  return 16 + ndirect + (48 << npostfix)
}

// Streaming encoder for processing data in chunks
export class BrotliEncoder {
  private state: BrotliEncoderState
  
  constructor(options: BrotliEncodeOptions = {}) {
    const params = createDefaultParams()
    
    if (options.quality !== undefined) {
      params.quality = Math.max(0, Math.min(11, options.quality))
    }
    if (options.lgwin !== undefined) {
      params.lgwin = Math.max(10, Math.min(24, options.lgwin))
    }
    if (options.mode !== undefined) {
      params.mode = options.mode
    }
    if (options.sizeHint !== undefined) {
      params.sizeHint = options.sizeHint
    }
    
    sanitizeParams(params)
    params.lgblock = computeLgBlock(params)
    
    const ringBufferSize = 1 << params.lgwin
    
    this.state = {
      params,
      hasher: null,
      distCache: new Int32Array([4, 11, 15, 16]),
      lastInsertLen: 0,
      commands: [],
      numLiterals: 0,
      inputPos: 0,
      lastProcessedPos: 0,
      ringBuffer: new Uint8Array(ringBufferSize),
      ringBufferMask: ringBufferSize - 1,
      prevByte: 0,
      prevByte2: 0,
      isInitialized: false,
      isLastBlockEmitted: false,
      writer: new BitWriter(),
    }
  }
  
  private initialize(): void {
    if (this.state.isInitialized) return
    
    const { params, writer } = this.state
    
    // Write window bits
    const windowBits = encodeWindowBits(params.lgwin, params.largeWindow)
    writer.writeBits(windowBits.bits, windowBits.value)
    
    // Create hasher
    if (params.quality <= 4) {
      this.state.hasher = createSimpleHasher(params.quality, params.lgwin)
    } else if (params.quality <= 9) {
      this.state.hasher = createHashChainHasher(params.quality, params.lgwin)
    } else {
      this.state.hasher = createBinaryTreeHasher(params.lgwin)
    }
    
    this.state.isInitialized = true
  }
  
  update(input: Uint8Array): Uint8Array {
    this.initialize()
    
    const { ringBuffer, ringBufferMask } = this.state
    
    // Copy input to ring buffer
    for (let i = 0; i < input.length; i++) {
      ringBuffer[(this.state.inputPos + i) & ringBufferMask] = input[i]
    }
    this.state.inputPos += input.length
    
    // Process complete blocks
    const blockSize = 1 << this.state.params.lgblock
    const output: Uint8Array[] = []
    
    while (this.state.inputPos - this.state.lastProcessedPos >= blockSize) {
      const chunk = this.processBlock(blockSize, false)
      if (chunk.length > 0) {
        output.push(chunk)
      }
    }
    
    // Concatenate output
    if (output.length === 0) return new Uint8Array(0)
    if (output.length === 1) return output[0]
    
    const totalLen = output.reduce((sum, arr) => sum + arr.length, 0)
    const result = new Uint8Array(totalLen)
    let offset = 0
    for (const chunk of output) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  }
  
  finish(): Uint8Array {
    this.initialize()
    
    // Process any remaining data
    const remaining = this.state.inputPos - this.state.lastProcessedPos
    if (remaining > 0) {
      return this.processBlock(remaining, true)
    }
    
    // Emit empty final block if needed
    if (!this.state.isLastBlockEmitted) {
      const { writer } = this.state
      writer.writeBits(1, 1) // ISLAST
      writer.writeBits(1, 1) // ISEMPTY
      writer.alignToByte()
      this.state.isLastBlockEmitted = true
    }
    
    return this.state.writer.takeBytes()
  }
  
  private processBlock(blockLen: number, isLast: boolean): Uint8Array {
    const { params, ringBuffer, ringBufferMask, distCache, hasher, writer } = this.state
    const pos = this.state.lastProcessedPos
    
    if (!hasher) {
      throw new Error('Encoder not initialized')
    }
    
    // Find backward references
    let commands: Command[]
    let numLiterals: number
    let lastInsertLen: number
    
    if (hasher instanceof SimpleHasher || hasher instanceof HashChainHasher) {
      [commands, numLiterals, lastInsertLen] = createBackwardReferences(
        blockLen, pos, ringBuffer, ringBufferMask,
        hasher, distCache, this.state.lastInsertLen, params.quality
      )
    } else if (hasher instanceof BinaryTreeHasher) {
      if (params.quality >= HQ_ZOPFLIFICATION_QUALITY) {
        [commands, numLiterals, lastInsertLen] = createHqZopfliBackwardReferences(
          blockLen, pos, ringBuffer, ringBufferMask,
          hasher, distCache, this.state.lastInsertLen
        )
      } else {
        [commands, numLiterals, lastInsertLen] = createZopfliBackwardReferences(
          blockLen, pos, ringBuffer, ringBufferMask,
          params.quality, hasher, distCache, this.state.lastInsertLen
        )
      }
    } else {
      commands = [createInsertCommand(blockLen)]
      numLiterals = blockLen
      lastInsertLen = 0
    }
    
    // Handle trailing literals (Zopfli returns these separately).
    // Insert length is *before* the copy; we may only merge with an insert-only
    // command (copyLen == 0).
    if (lastInsertLen > 0) {
      if (commands.length === 0) {
        commands = [createInsertCommand(blockLen)]
      } else {
        const lastCmd = commands[commands.length - 1]
        if (commandCopyLen(lastCmd) === 0) {
          lastCmd.insertLen += lastInsertLen
        } else {
          commands.push(createInsertCommand(lastInsertLen))
        }
      }
    } else if (commands.length === 0) {
      // All literals, no matches
      commands = [createInsertCommand(blockLen)]
    }
    
    // Store metablock
    const distAlphabetSize = calculateDistanceAlphabetSize(params)
    storeMetaBlockTrivial(
      writer, ringBuffer, pos, blockLen, ringBufferMask,
      isLast, commands, distAlphabetSize
    )
    
    // Update state
    this.state.lastProcessedPos += blockLen
    // lastInsertLen has been handled by adding to commands, so reset to 0
    this.state.lastInsertLen = 0
    this.state.numLiterals += numLiterals
    
    if (isLast) {
      this.state.isLastBlockEmitted = true
    }
    
    // Return any newly completed bytes
    return writer.takeBytes()
  }
}

