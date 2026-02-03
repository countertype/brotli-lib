// Command encoding for Brotli compression
// Reference: woff2/brotli/c/enc/command.h, command.c

import { log2FloorNonZero } from './fast-log'
import { NUM_DISTANCE_SHORT_CODES } from './enc-constants'

// Insert/Copy Length Tables

export const NUM_INS_COPY_CODES = 24

export const INSERT_LENGTH_BASE = new Uint32Array([
  0, 1, 2, 3, 4, 5, 6, 8, 10, 14, 18, 26,
  34, 50, 66, 98, 130, 194, 322, 578, 1090, 2114, 6210, 22594
])

export const INSERT_LENGTH_EXTRA = new Uint32Array([
  0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 12, 14, 24
])

export const COPY_LENGTH_BASE = new Uint32Array([
  2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 18,
  22, 30, 38, 54, 70, 102, 134, 198, 326, 582, 1094, 2118
])

export const COPY_LENGTH_EXTRA = new Uint32Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 24
])

export function getInsertLengthCode(insertLen: number): number {
  if (insertLen < 6) {
    return insertLen
  } else if (insertLen < 130) {
    const nbits = log2FloorNonZero(insertLen - 2) - 1
    return (nbits << 1) + ((insertLen - 2) >>> nbits) + 2
  } else if (insertLen < 2114) {
    return log2FloorNonZero(insertLen - 66) + 10
  } else if (insertLen < 6210) {
    return 21
  } else if (insertLen < 22594) {
    return 22
  } else {
    return 23
  }
}

export function getCopyLengthCode(copyLen: number): number {
  if (copyLen < 10) {
    return copyLen - 2
  } else if (copyLen < 134) {
    const nbits = log2FloorNonZero(copyLen - 6) - 1
    return (nbits << 1) + ((copyLen - 6) >>> nbits) + 4
  } else if (copyLen < 2118) {
    return log2FloorNonZero(copyLen - 70) + 12
  } else {
    return 23
  }
}

export function combineLengthCodes(
  insCode: number,
  copyCode: number,
  useLastDistance: boolean
): number {
  const bits64 = (copyCode & 0x7) | ((insCode & 0x7) << 3)
  
  if (useLastDistance && insCode < 8 && copyCode < 16) {
    return copyCode < 8 ? bits64 : (bits64 | 64)
  } else {
    // Specification: 5 Encoding of ... (last table)
    // offset = 2 * index, where index is in range [0..8]
    let offset = 2 * ((copyCode >>> 3) + 3 * (insCode >>> 3))
    // All values in specification are K * 64,
    // where   K = [2, 3, 6, 4, 5, 8, 7, 9, 10],
    //     i + 1 = [1, 2, 3, 4, 5, 6, 7, 8,  9],
    // K - i - 1 = [1, 1, 3, 0, 0, 2, 0, 1,  2] = D.
    // All values in D require only 2 bits to encode.
    // Magic constant is shifted 6 bits left, to avoid final multiplication.
    offset = (offset << 5) + 0x40 + ((0x520D40 >>> offset) & 0xC0)
    return offset | bits64
  }
}

export function getLengthCode(
  insertLen: number,
  copyLen: number,
  useLastDistance: boolean
): number {
  const insCode = getInsertLengthCode(insertLen)
  const copyCode = getCopyLengthCode(copyLen)
  return combineLengthCodes(insCode, copyCode, useLastDistance)
}

export function getInsertBase(insCode: number): number {
  return INSERT_LENGTH_BASE[insCode]
}

export function getInsertExtra(insCode: number): number {
  return INSERT_LENGTH_EXTRA[insCode]
}

export function getCopyBase(copyCode: number): number {
  return COPY_LENGTH_BASE[copyCode]
}

export function getCopyExtra(copyCode: number): number {
  return COPY_LENGTH_EXTRA[copyCode]
}

// Encode copy distance into code and extra bits
// distance_code: 0-15 = short codes, 16+ = distance + NUM_DISTANCE_SHORT_CODES - 1
export function prefixEncodeCopyDistance(
  distanceCode: number,
  numDirectCodes: number,
  postfixBits: number
): [number, number, number] {
  if (distanceCode < NUM_DISTANCE_SHORT_CODES + numDirectCodes) {
    return [distanceCode, 0, 0]
  } else {
    const dist = (1 << (postfixBits + 2)) +
      (distanceCode - NUM_DISTANCE_SHORT_CODES - numDirectCodes)
    const bucket = log2FloorNonZero(dist) - 1
    const postfixMask = (1 << postfixBits) - 1
    const postfix = dist & postfixMask
    const prefix = (dist >>> bucket) & 1
    const offset = (2 + prefix) << bucket
    const nbits = bucket - postfixBits
    
    const code = (nbits << 10) |
      (NUM_DISTANCE_SHORT_CODES + numDirectCodes +
       ((2 * (nbits - 1) + prefix) << postfixBits) + postfix)
    const extraBits = (dist - offset) >>> postfixBits
    
    return [code, extraBits, nbits]
  }
}

// A command: sequence of literals followed by a backward reference
export interface Command {
  insertLen: number  // number of literal bytes to insert
  copyLen: number    // copy length (low 25 bits) + length code delta (high 7 bits)
  distExtra: number  // distance extra bits value
  cmdPrefix: number  // combined insert+copy length prefix (0-703)
  distPrefix: number // distance code (low 10 bits) + extra bits count (high 6 bits)
}

export function createCommand(
  insertLen: number,
  copyLen: number,
  copyLenCodeDelta: number,
  distanceCode: number,
  numDirectCodes: number = 0,
  postfixBits: number = 0
): Command {
  // Encode copy length with delta in high bits
  const delta = copyLenCodeDelta & 0x7F
  const copyLenEncoded = copyLen | (delta << 25)
  
  // Encode distance
  const [distCode, distExtra, distNbits] = prefixEncodeCopyDistance(
    distanceCode, numDirectCodes, postfixBits
  )
  const distPrefix = distCode | (distNbits << 10)
  
  // Get command prefix
  const useLastDistance = (distCode & 0x3FF) === 0
  const cmdPrefix = getLengthCode(
    insertLen,
    copyLen + copyLenCodeDelta,
    useLastDistance
  )
  
  return {
    insertLen,
    copyLen: copyLenEncoded,
    distExtra,
    cmdPrefix,
    distPrefix,
  }
}

// Insert-only command (no copy)
// Uses minimum copy length with last-distance mode to avoid distance encoding
export function createInsertCommand(insertLen: number): Command {
  // Use copy length 2 (minimum) with last-distance mode
  // This produces command codes < 128 which don't require distance encoding
  const copyLenCode = 2
  const insCode = getInsertLengthCode(insertLen)
  
  // For insert-only, use last distance mode if possible
  // This avoids needing to encode a distance
  let cmdPrefix: number
  if (insCode < 8) {
    // Can use last-distance mode (command codes 0-127)
    cmdPrefix = getLengthCode(insertLen, copyLenCode, true)
  } else {
    // Must use explicit distance mode, but with distance code 0 (last distance)
    cmdPrefix = getLengthCode(insertLen, copyLenCode, false)
  }
  
  return {
    insertLen,
    // Store actual copy length 0, but with delta to make copyLenCode = 2
    copyLen: 0 | (2 << 25), // copy len 0 with delta 2
    distExtra: 0,
    cmdPrefix,
    distPrefix: 0, // Use last distance (code 0)
  }
}

export function commandCopyLen(cmd: Command): number {
  return cmd.copyLen & 0x1FFFFFF
}

export function commandCopyLenCode(cmd: Command): number {
  const modifier = cmd.copyLen >>> 25
  // Sign extend the 7-bit delta
  const delta = (modifier & 0x40) ? (modifier | 0xFFFFFF80) : modifier
  return (cmd.copyLen & 0x1FFFFFF) + delta
}

export function commandDistanceContext(cmd: Command): number {
  const r = cmd.cmdPrefix >>> 6
  const c = cmd.cmdPrefix & 7
  if ((r === 0 || r === 2 || r === 4 || r === 7) && c <= 2) {
    return c
  }
  return 3
}

export function commandRestoreDistanceCode(
  cmd: Command,
  numDirectCodes: number,
  postfixBits: number
): number {
  const dcode = cmd.distPrefix & 0x3FF
  
  if (dcode < NUM_DISTANCE_SHORT_CODES + numDirectCodes) {
    return dcode
  } else {
    const nbits = cmd.distPrefix >>> 10
    const extra = cmd.distExtra
    const postfixMask = (1 << postfixBits) - 1
    const hcode = (dcode - numDirectCodes - NUM_DISTANCE_SHORT_CODES) >>> postfixBits
    const lcode = (dcode - numDirectCodes - NUM_DISTANCE_SHORT_CODES) & postfixMask
    const offset = ((2 + (hcode & 1)) << nbits) - 4
    return ((offset + extra) << postfixBits) + lcode +
      numDirectCodes + NUM_DISTANCE_SHORT_CODES
  }
}
