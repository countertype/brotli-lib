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
  MIN_QUALITY_FOR_BLOCK_SPLIT,
  MAX_NUM_DELAYED_SYMBOLS,
} from './enc-constants'
import { SimpleHasher, createSimpleHasher } from './hash-simple'
import { HashChainHasher, createHashChainHasher } from './hash-chains'
import { BinaryTreeHasher, createBinaryTreeHasher } from './hash-binary-tree'
import { createBackwardReferences, createBackwardReferencesQuick } from './backward-references'
import { createZopfliBackwardReferences, createHqZopfliBackwardReferences } from './backward-references-hq'
import { Command, createInsertCommand, commandCopyLen } from './command'
import { storeMetaBlockTrivial, storeMetaBlock, storeUncompressedMetaBlock } from './metablock'
import { FLAT_INPUT_MASK } from './enc-constants'
import { createDistanceCache } from './match'

export interface BrotliEncodeOptions {
  quality?: number    // 0-11, default 11
  lgwin?: number      // 10-24, default 22
  mode?: EncoderMode  // default GENERIC
  sizeHint?: number   // default 0 (unknown)
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
  const distCache = createDistanceCache()
  // Positions are absolute: the whole input is passed through rather than a
  // circular buffer. maxBackwardLimit is what enforces the window
  const ringBufferMask = FLAT_INPUT_MASK
  const maxBackwardLimit = (1 << params.lgwin) - 16
  
  // Process in blocks
  const blockSize = 1 << params.lgblock
  let pos = 0
  
  while (pos < input.length) {
    const blockLen = Math.min(input.length - pos, blockSize)
    const isLast = pos + blockLen >= input.length
    
    // Find backward references
    const [commands] = createBackwardReferencesQuick(
      blockLen, pos, input, ringBufferMask,
      hasher, distCache, 0,
      params.dist.distancePostfixBits, params.dist.numDirectDistanceCodes,
      maxBackwardLimit
    )
    
    // Store metablock
    const distAlphabetSize = 16 + params.dist.numDirectDistanceCodes + (48 << params.dist.distancePostfixBits)
    storeMetaBlockTrivial(
      writer, input, pos, blockLen, ringBufferMask,
      isLast, commands, distAlphabetSize,
      params.dist.distancePostfixBits, params.dist.numDirectDistanceCodes
    )
    
    pos += blockLen
  }

  hasher.release()
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
    hasher = createBinaryTreeHasher(params.lgwin, input.length, params.quality)
  }
  
  // Initialize state
  const distCache = createDistanceCache()
  // Positions are absolute: the whole input is passed through rather than a
  // circular buffer. maxBackwardLimit is what enforces the window
  const ringBufferMask = FLAT_INPUT_MASK
  const maxBackwardLimit = (1 << params.lgwin) - 16
  
  // Process in metablocks
  // Bounded by the window: a metablock larger than the decoder's ring buffer
  // cannot be followed
  const maxMetablockSize =
    1 << Math.min(1 + Math.max(params.lgwin, params.lgblock), 24)
  let pos = 0

  if (params.quality < MIN_QUALITY_FOR_BLOCK_SPLIT && hasher instanceof SimpleHasher) {
    encodeUnsplit(writer, input, params, hasher, distCache, maxBackwardLimit, maxMetablockSize)
    hasher.release()
    return writer.finish()
  }

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
        hasher, distCache, 0,
        params.dist.distancePostfixBits, params.dist.numDirectDistanceCodes,
        maxBackwardLimit
      )
    } else if (params.quality >= ZOPFLIFICATION_QUALITY && hasher instanceof BinaryTreeHasher) {
      // Quality 10: use Zopfli
      [commands, , lastInsertLen] = createZopfliBackwardReferences(
        metablockLen, pos, input, ringBufferMask,
        params.quality, hasher, distCache, 0,
        params.dist.distancePostfixBits, params.dist.numDirectDistanceCodes,
        maxBackwardLimit
      )
    } else if (hasher instanceof HashChainHasher) {
      // Quality 5-9: use hash chains
      [commands, , lastInsertLen] = createBackwardReferences(
        metablockLen, pos, input, ringBufferMask,
        hasher, distCache, 0, params.quality,
        params.dist.distancePostfixBits, params.dist.numDirectDistanceCodes,
        maxBackwardLimit
      )
    } else if (hasher instanceof SimpleHasher) {
      // Quality 2-4: use simple hasher
      [commands, , lastInsertLen] = createBackwardReferencesQuick(
        metablockLen, pos, input, ringBufferMask,
        hasher, distCache, 0,
        params.dist.distancePostfixBits, params.dist.numDirectDistanceCodes,
        maxBackwardLimit
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
    storeMetaBlock(
      writer, input, pos, metablockLen, ringBufferMask,
      isLast, commands, distAlphabetSize, params.quality,
      params.dist.distancePostfixBits, params.dist.numDirectDistanceCodes
    )
    
    pos += metablockLen
  }

  // The quick and chain hashers are pooled and hold a view of the input
  if (!(hasher instanceof BinaryTreeHasher)) hasher.release()
  return writer.finish()
}

// Qualities without block splitting get their adaptivity from short
// metablocks instead: each carries its own prefix codes, so one is closed as
// soon as it holds enough symbols to pay for them
function encodeUnsplit(
  writer: BitWriter,
  input: Uint8Array,
  params: EncoderParams,
  hasher: SimpleHasher,
  distCache: Int32Array,
  maxBackwardLimit: number,
  maxMetablockSize: number
): void {
  const blockSize = 1 << params.lgblock
  const distAlphabetSize = calculateDistanceAlphabetSize(params)
  let commands: Command[] = []
  let numLiterals = 0
  let lastInsertLen = 0
  let metablockStart = 0
  let pos = 0

  while (pos < input.length) {
    const blockLen = Math.min(input.length - pos, blockSize)
    const [blockCommands, blockLiterals, trailing] = createBackwardReferencesQuick(
      blockLen, pos, input, FLAT_INPUT_MASK,
      hasher, distCache, lastInsertLen,
      params.dist.distancePostfixBits, params.dist.numDirectDistanceCodes,
      maxBackwardLimit, true
    )
    for (let i = 0; i < blockCommands.length; i++) commands.push(blockCommands[i])
    numLiterals += blockLiterals
    lastInsertLen = trailing
    pos += blockLen

    const isLast = pos >= input.length
    const nextFits = pos - metablockStart + blockSize <= maxMetablockSize
    if (!isLast && nextFits && numLiterals + commands.length < MAX_NUM_DELAYED_SYMBOLS) {
      continue
    }

    if (lastInsertLen > 0) {
      commands.push(createInsertCommand(lastInsertLen))
      lastInsertLen = 0
    }
    storeMetaBlock(
      writer, input, metablockStart, pos - metablockStart, FLAT_INPUT_MASK,
      isLast, commands, distAlphabetSize, params.quality,
      params.dist.distancePostfixBits, params.dist.numDirectDistanceCodes
    )
    commands = []
    numLiterals = 0
    metablockStart = pos
  }
}

function calculateDistanceAlphabetSize(params: EncoderParams): number {
  const npostfix = params.dist.distancePostfixBits
  const ndirect = params.dist.numDirectDistanceCodes
  return 16 + ndirect + (48 << npostfix)
}

// Streaming encoder for processing data in chunks
//
// Input is searched one block at a time as it arrives, and blocks accumulate
// into a metablock until it is full, which is when output appears. Everything
// after the search is shared with the one-shot path, so both compress alike
export class BrotliEncoder {
  private params: EncoderParams
  private writer = new BitWriter()
  private hasher: SimpleHasher | HashChainHasher | BinaryTreeHasher | null = null
  private distCache = createDistanceCache()
  // Twice the larger of window and block: while a block is being written, the
  // window before it and the whole pending metablock are still intact
  private ring: Uint8Array
  private mask: number
  private blockSize: number
  private maxMetablockSize: number
  private maxBackwardLimit: number
  private inputPos = 0
  private searchedPos = 0
  private metablockStart = 0
  private commands: Command[] = []
  private numLiterals = 0
  private lastInsertLen = 0
  private finished = false

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
    this.params = params

    const ringBits = 1 + Math.max(params.lgwin, params.lgblock)
    this.ring = new Uint8Array(1 << ringBits)
    this.mask = (1 << ringBits) - 1
    this.blockSize = 1 << params.lgblock
    this.maxMetablockSize = 1 << Math.min(ringBits - 1, 24)
    this.maxBackwardLimit = (1 << params.lgwin) - 16
  }

  update(input: Uint8Array): Uint8Array {
    if (this.finished) {
      throw new Error('BrotliEncoder: update() after finish()')
    }
    let offset = 0
    while (offset < input.length) {
      const pending = this.inputPos - this.searchedPos
      const n = Math.min(this.blockSize - pending, input.length - offset)
      // Blocks start on multiples of the block size, which divides the ring
      // size, so a block never wraps
      this.ring.set(input.subarray(offset, offset + n), this.inputPos & this.mask)
      this.inputPos += n
      offset += n
      if (pending + n === this.blockSize) {
        this.processBlock(false)
      }
    }
    return this.writer.takeBytes()
  }

  finish(): Uint8Array {
    if (!this.finished) {
      this.finished = true
      this.processBlock(true)
    }
    return this.writer.takeBytes()
  }

  private start(): void {
    const { params, writer } = this
    const windowBits = encodeWindowBits(params.lgwin, params.largeWindow)
    writer.writeBits(windowBits.bits, windowBits.value)

    if (params.quality <= 4) {
      // Not the shared instance: a stream outlives the call that created it
      this.hasher = createSimpleHasher(params.quality, params.lgwin, false)
    } else if (params.quality <= 9) {
      this.hasher = createHashChainHasher(params.quality, params.lgwin, false)
    } else {
      this.hasher = createBinaryTreeHasher(params.lgwin, undefined, params.quality)
    }
  }

  private processBlock(isLast: boolean): void {
    if (this.hasher === null) this.start()
    const { params, ring, mask, distCache, writer } = this
    const hasher = this.hasher!
    const npostfix = params.dist.distancePostfixBits
    const ndirect = params.dist.numDirectDistanceCodes

    const pos = this.searchedPos
    const blockLen = this.inputPos - pos
    if (blockLen > 0) {
      let found: [Command[], number, number]
      if (hasher instanceof BinaryTreeHasher) {
        found = params.quality >= HQ_ZOPFLIFICATION_QUALITY
          ? createHqZopfliBackwardReferences(
              blockLen, pos, ring, mask, hasher, distCache, this.lastInsertLen,
              npostfix, ndirect, this.maxBackwardLimit)
          : createZopfliBackwardReferences(
              blockLen, pos, ring, mask, params.quality, hasher, distCache,
              this.lastInsertLen, npostfix, ndirect, this.maxBackwardLimit)
      } else if (hasher instanceof SimpleHasher) {
        found = createBackwardReferencesQuick(
          blockLen, pos, ring, mask, hasher, distCache, this.lastInsertLen,
          npostfix, ndirect, this.maxBackwardLimit, true)
      } else {
        found = createBackwardReferences(
          blockLen, pos, ring, mask, hasher, distCache, this.lastInsertLen,
          params.quality, npostfix, ndirect, this.maxBackwardLimit, true)
      }
      const blockCommands = found[0]
      for (let i = 0; i < blockCommands.length; i++) this.commands.push(blockCommands[i])
      this.numLiterals += found[1]
      this.lastInsertLen = found[2]
      this.searchedPos = this.inputPos
    }

    const metablockLen = this.searchedPos - this.metablockStart
    if (!isLast) {
      const nextFits = metablockLen + this.blockSize <= this.maxMetablockSize
      // Without block splitting, short metablocks are what adapts the codes
      const enoughSymbols = params.quality < MIN_QUALITY_FOR_BLOCK_SPLIT &&
        this.numLiterals + this.commands.length >= MAX_NUM_DELAYED_SYMBOLS
      if (nextFits && !enoughSymbols) return
    }

    if (metablockLen === 0) {
      // Only reachable at the end: an empty last metablock closes the stream
      writer.writeBits(1, 1)
      writer.writeBits(1, 1)
      writer.alignToByte()
      return
    }

    if (this.lastInsertLen > 0) {
      this.commands.push(createInsertCommand(this.lastInsertLen))
      this.lastInsertLen = 0
    }
    storeMetaBlock(
      writer, ring, this.metablockStart, metablockLen, mask,
      isLast, this.commands, calculateDistanceAlphabetSize(params), params.quality,
      npostfix, ndirect
    )
    this.commands = []
    this.numLiterals = 0
    this.metablockStart = this.searchedPos
  }
}
