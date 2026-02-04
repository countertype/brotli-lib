// Encoder constants and parameters for Brotli compression
// Reference: woff2/brotli/c/enc/quality.h, params.h

export const FAST_ONE_PASS_COMPRESSION_QUALITY = 0
export const FAST_TWO_PASS_COMPRESSION_QUALITY = 1
export const ZOPFLIFICATION_QUALITY = 10
export const HQ_ZOPFLIFICATION_QUALITY = 11
export const MIN_QUALITY = 0
export const MAX_QUALITY = 11
export const DEFAULT_QUALITY = 11

// Quality Thresholds (features enabled above these levels)

export const MAX_QUALITY_FOR_STATIC_ENTROPY_CODES = 2
export const MIN_QUALITY_FOR_BLOCK_SPLIT = 4
export const MIN_QUALITY_FOR_NONZERO_DISTANCE_PARAMS = 4
export const MIN_QUALITY_FOR_OPTIMIZE_HISTOGRAMS = 4
export const MIN_QUALITY_FOR_EXTENSIVE_REFERENCE_SEARCH = 5
export const MIN_QUALITY_FOR_CONTEXT_MODELING = 5
export const MIN_QUALITY_FOR_HQ_CONTEXT_MODELING = 7
export const MIN_QUALITY_FOR_HQ_BLOCK_SPLITTING = 10

export const MIN_WINDOW_BITS = 10       // 1KB
export const MAX_WINDOW_BITS = 24       // 16MB
export const LARGE_MAX_WINDOW_BITS = 30 // 1GB
export const DEFAULT_WINDOW_BITS = 22   // 4MB

export const MIN_INPUT_BLOCK_BITS = 16
export const MAX_INPUT_BLOCK_BITS = 24
export const MAX_NUM_DELAYED_SYMBOLS = 0x2FFF

export const MAX_ZOPFLI_LEN_QUALITY_10 = 150
export const MAX_ZOPFLI_LEN_QUALITY_11 = 325
export const LONG_COPY_QUICK_STEP = 16384

export const enum HasherType {
  NONE = 0,
  H01 = 1,
  H02 = 2,
  H03 = 3,
  H04 = 4,
  H05 = 5,  // Q5-9
  H06 = 6,  // Q5-9 large files
  H10 = 10, // Q10-11 binary tree
  H35 = 35, // large window
  H40 = 40, // forgetful chain
  H41 = 41,
  H42 = 42,
  H54 = 54, // Q4 large files
  H55 = 55, // large window Q4
  H58 = 58, // SIMD
  H65 = 65, // large window Q5-9
  H68 = 68, // SIMD 64-bit
}

export const enum EncoderMode {
  GENERIC = 0, // no assumptions about content
  TEXT = 1,    // UTF-8 text content
  FONT = 2,    // WOFF2 font data
}

export const NUM_COMMAND_CODES = 704
export const NUM_LITERAL_CODES = 256
export const NUM_BLOCK_LEN_CODES = 26
export const NUM_INSERT_AND_COPY_CODES = 704

export const NUM_DISTANCE_SHORT_CODES = 16
export const MAX_DIRECT_DISTANCE_CODES = 120
export const MAX_DISTANCE_POSTFIX_BITS = 3

export interface HasherParams {
  type: HasherType
  bucketBits: number
  blockBits: number
  numLastDistancesToCheck: number
}

export interface DistanceParams {
  distancePostfixBits: number
  numDirectDistanceCodes: number
  alphabetSizeMax: number
  alphabetSizeLimit: number
  maxDistance: number
}

export interface EncoderParams {
  mode: EncoderMode
  quality: number
  lgwin: number
  lgblock: number
  streamOffset: number
  sizeHint: number
  disableLiteralContextModeling: boolean
  largeWindow: boolean
  hasher: HasherParams
  dist: DistanceParams
}

export function maxHashTableSize(quality: number): number {
  return quality === FAST_ONE_PASS_COMPRESSION_QUALITY ? 1 << 15 : 1 << 17
}

export function maxZopfliLen(quality: number): number {
  return quality <= 10 ? MAX_ZOPFLI_LEN_QUALITY_10 : MAX_ZOPFLI_LEN_QUALITY_11
}

export function maxZopfliCandidates(quality: number): number {
  return quality <= 10 ? 1 : 5
}

export function sanitizeParams(params: EncoderParams): void {
  params.quality = Math.max(MIN_QUALITY, Math.min(MAX_QUALITY, params.quality))
  
  if (params.quality <= MAX_QUALITY_FOR_STATIC_ENTROPY_CODES) {
    params.largeWindow = false
  }
  
  const maxLgwin = params.largeWindow ? LARGE_MAX_WINDOW_BITS : MAX_WINDOW_BITS
  params.lgwin = Math.max(MIN_WINDOW_BITS, Math.min(maxLgwin, params.lgwin))
  
  // FONT mode uses different distance parameters optimized for font data
  if (params.quality >= MIN_QUALITY_FOR_NONZERO_DISTANCE_PARAMS &&
      params.mode === EncoderMode.FONT) {
    params.dist.distancePostfixBits = 1
    params.dist.numDirectDistanceCodes = 12
  }
}

export function computeLgBlock(params: EncoderParams): number {
  let lgblock = params.lgblock
  
  if (params.quality === FAST_ONE_PASS_COMPRESSION_QUALITY ||
      params.quality === FAST_TWO_PASS_COMPRESSION_QUALITY) {
    lgblock = params.lgwin
  } else if (params.quality < MIN_QUALITY_FOR_BLOCK_SPLIT) {
    lgblock = 14
  } else if (lgblock === 0) {
    lgblock = 16
    if (params.quality >= 9 && params.lgwin > lgblock) {
      lgblock = Math.min(18, params.lgwin)
    }
  } else {
    lgblock = Math.max(MIN_INPUT_BLOCK_BITS, Math.min(MAX_INPUT_BLOCK_BITS, lgblock))
  }
  
  return lgblock
}

export function computeRbBits(params: EncoderParams): number {
  return 1 + Math.max(params.lgwin, params.lgblock)
}

export function maxMetablockSize(params: EncoderParams): number {
  const bits = Math.min(computeRbBits(params), MAX_INPUT_BLOCK_BITS)
  return 1 << bits
}

export function literalSpreeLengthForSparseSearch(quality: number): number {
  return quality < 9 ? 64 : 512
}

export function chooseHasher(params: EncoderParams): HasherParams {
  const hparams: HasherParams = {
    type: HasherType.H05,
    bucketBits: 15,
    blockBits: 0,
    numLastDistancesToCheck: 4,
  }
  
  if (params.quality > 9) {
    hparams.type = HasherType.H10
  } else if (params.quality === 4 && params.sizeHint >= (1 << 20)) {
    hparams.type = HasherType.H54
  } else if (params.quality < 5) {
    hparams.type = params.quality as HasherType
  } else if (params.lgwin <= 16) {
    hparams.type = params.quality < 7 ? HasherType.H40 : 
                   params.quality < 9 ? HasherType.H41 : HasherType.H42
  } else if (params.sizeHint >= (1 << 20) && params.lgwin >= 19) {
    hparams.type = HasherType.H06
    hparams.blockBits = params.quality - 1
    hparams.bucketBits = 15
    hparams.numLastDistancesToCheck = params.quality < 7 ? 4 : 
                                       params.quality < 9 ? 10 : 16
  } else {
    hparams.type = HasherType.H05
    hparams.blockBits = params.quality - 1
    hparams.bucketBits = params.quality < 7 ? 14 : 15
    hparams.numLastDistancesToCheck = params.quality < 7 ? 4 :
                                       params.quality < 9 ? 10 : 16
  }
  
  // Large window adjustments
  if (params.lgwin > 24) {
    if (hparams.type === HasherType.H03) {
      hparams.type = HasherType.H35
    }
    if (hparams.type === HasherType.H54) {
      hparams.type = HasherType.H55
    }
    if (hparams.type === HasherType.H06 || hparams.type === HasherType.H68) {
      hparams.type = HasherType.H65
    }
  }
  
  return hparams
}

export function createDefaultParams(): EncoderParams {
  return {
    mode: EncoderMode.GENERIC,
    quality: DEFAULT_QUALITY,
    lgwin: DEFAULT_WINDOW_BITS,
    lgblock: 0,
    streamOffset: 0,
    sizeHint: 0,
    disableLiteralContextModeling: false,
    largeWindow: false,
    hasher: {
      type: HasherType.H10,
      bucketBits: 17,
      blockBits: 0,
      numLastDistancesToCheck: 16,
    },
    dist: {
      distancePostfixBits: 0,
      numDirectDistanceCodes: 0,
      alphabetSizeMax: 0,
      alphabetSizeLimit: 0,
      maxDistance: 0,
    },
  }
}
