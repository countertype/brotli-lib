// Per-position literal cost estimates for the Zopfli cost model
// Reference: c/enc/literal_cost.c, c/enc/utf8_util.c
//
// Each literal is priced from a histogram of the bytes around it rather than
// of the whole block, so the estimate follows the data as it changes

import { fastLog2 } from './fast-log'

const MIN_UTF8_RATIO = 0.75

// Length in bytes of the UTF-8 sequence at `at`, or 0 if it is not valid
function utf8SequenceLength(data: Uint8Array, at: number, size: number): number {
  const b0 = data[at]
  if ((b0 & 0x80) === 0) {
    return b0 > 0 ? 1 : 0
  }
  if (size > 1 && (b0 & 0xE0) === 0xC0 && (data[at + 1] & 0xC0) === 0x80) {
    const symbol = ((b0 & 0x1F) << 6) | (data[at + 1] & 0x3F)
    if (symbol > 0x7F) return 2
  }
  if (size > 2 && (b0 & 0xF0) === 0xE0 &&
      (data[at + 1] & 0xC0) === 0x80 && (data[at + 2] & 0xC0) === 0x80) {
    const symbol = ((b0 & 0x0F) << 12) | ((data[at + 1] & 0x3F) << 6) | (data[at + 2] & 0x3F)
    if (symbol > 0x7FF) return 3
  }
  if (size > 3 && (b0 & 0xF8) === 0xF0 && (data[at + 1] & 0xC0) === 0x80 &&
      (data[at + 2] & 0xC0) === 0x80 && (data[at + 3] & 0xC0) === 0x80) {
    const symbol = ((b0 & 0x07) << 18) | ((data[at + 1] & 0x3F) << 12) |
      ((data[at + 2] & 0x3F) << 6) | (data[at + 3] & 0x3F)
    if (symbol > 0xFFFF && symbol <= 0x10FFFF) return 4
  }
  return 0
}

export function isMostlyUTF8(
  data: Uint8Array, pos: number, mask: number, length: number
): boolean {
  let sizeUtf8 = 0
  let i = 0
  while (i < length) {
    const n = utf8SequenceLength(data, (pos + i) & mask, length - i)
    if (n === 0) {
      i++
    } else {
      i += n
      sizeUtf8 += n
    }
  }
  return sizeUtf8 > MIN_UTF8_RATIO * length
}

// Which byte of a multi-byte sequence comes after `c`, capped at `clamp`
function utf8Position(last: number, c: number, clamp: number): number {
  if (c < 128) return 0
  if (c >= 192) return Math.min(1, clamp)
  return last < 0xE0 ? 0 : Math.min(2, clamp)
}

function decideMultiByteStatsLevel(
  pos: number, len: number, mask: number, data: Uint8Array
): number {
  let count1 = 0
  let count2 = 0
  let lastC = 0
  for (let i = 0; i < len; i++) {
    const c = data[(pos + i) & mask]
    const p = utf8Position(lastC, c, 2)
    if (p === 1) count1++
    else if (p === 2) count2++
    lastC = c
  }
  // 2 would be the natural ceiling, but 1 compresses better
  let maxUtf8 = 1
  if (count2 < 500) maxUtf8 = 1
  if (count1 + count2 < 25) maxUtf8 = 0
  return maxUtf8
}

function estimateUTF8(
  pos: number, len: number, mask: number, data: Uint8Array, cost: Float32Array
): void {
  const maxUtf8 = decideMultiByteStatsLevel(pos, len, mask, data)
  const windowHalf = 495
  const inWindow = Math.min(windowHalf, len)
  const histogram = new Uint32Array(3 * 256)
  const inWindowUtf8 = new Uint32Array(3)

  {
    let lastC = 0
    let utf8Pos = 0
    for (let i = 0; i < inWindow; i++) {
      const c = data[(pos + i) & mask]
      histogram[256 * utf8Pos + c]++
      inWindowUtf8[utf8Pos]++
      utf8Pos = utf8Position(lastC, c, maxUtf8)
      lastC = c
    }
  }

  const prologueLength = 2000
  const multiplier = 0.35 / 2000
  for (let i = 0; i < len; i++) {
    if (i >= windowHalf) {
      const c = i < windowHalf + 1 ? 0 : data[(pos + i - windowHalf - 1) & mask]
      const lastC = i < windowHalf + 2 ? 0 : data[(pos + i - windowHalf - 2) & mask]
      const p = utf8Position(lastC, c, maxUtf8)
      histogram[256 * p + data[(pos + i - windowHalf) & mask]]--
      inWindowUtf8[p]--
    }
    if (i + windowHalf < len) {
      const c = data[(pos + i + windowHalf - 1) & mask]
      const lastC = data[(pos + i + windowHalf - 2) & mask]
      const p = utf8Position(lastC, c, maxUtf8)
      histogram[256 * p + data[(pos + i + windowHalf) & mask]]++
      inWindowUtf8[p]++
    }
    const c = i < 1 ? 0 : data[(pos + i - 1) & mask]
    const lastC = i < 2 ? 0 : data[(pos + i - 2) & mask]
    const utf8Pos = utf8Position(lastC, c, maxUtf8)
    let histo = histogram[256 * utf8Pos + data[(pos + i) & mask]]
    if (histo === 0) histo = 1
    let litCost = fastLog2(inWindowUtf8[utf8Pos]) - fastLog2(histo)
    litCost += 0.02905
    if (litCost < 1.0) {
      litCost = litCost * 0.5 + 0.5
    }
    // The start of a file is statistically unsettled; pricing its literals
    // higher measurably helps
    if (i < prologueLength) {
      litCost += 0.35 + multiplier * i
    }
    cost[i] = litCost
  }
}

export function estimateBitCostsForLiterals(
  pos: number, len: number, mask: number, data: Uint8Array
): Float32Array {
  const cost = new Float32Array(len)
  if (isMostlyUTF8(data, pos, mask, len)) {
    estimateUTF8(pos, len, mask, data, cost)
    return cost
  }

  const windowHalf = 2000
  let inWindow = Math.min(windowHalf, len)
  const histogram = new Uint32Array(256)
  for (let i = 0; i < inWindow; i++) {
    histogram[data[(pos + i) & mask]]++
  }
  for (let i = 0; i < len; i++) {
    if (i >= windowHalf) {
      histogram[data[(pos + i - windowHalf) & mask]]--
      inWindow--
    }
    if (i + windowHalf < len) {
      histogram[data[(pos + i + windowHalf) & mask]]++
      inWindow++
    }
    let histo = histogram[data[(pos + i) & mask]]
    if (histo === 0) histo = 1
    let litCost = fastLog2(inWindow) - fastLog2(histo)
    litCost += 0.029
    if (litCost < 1.0) {
      litCost = litCost * 0.5 + 0.5
    }
    cost[i] = litCost
  }
  return cost
}
