// Bit cost estimation for Brotli compression
// Reference: woff2/brotli/c/enc/bit_cost.h, bit_cost.c

import { fastLog2 } from './fast-log'
import { CODE_LENGTH_CODES, REPEAT_ZERO_CODE_LENGTH } from './entropy-encode'
import type { HistogramLiteral, HistogramCommand, HistogramDistance } from './histogram'

const ONE_SYMBOL_HISTOGRAM_COST = 12
const TWO_SYMBOL_HISTOGRAM_COST = 20
const THREE_SYMBOL_HISTOGRAM_COST = 28
const FOUR_SYMBOL_HISTOGRAM_COST = 37

// Shannon entropy: sum(count[i] * log2(total/count[i]))
export function bitsEntropy(histogram: Uint32Array): number {
  const size = histogram.length
  let sum = 0
  let retval = 0
  
  // Calculate sum and contribution from each symbol
  for (let i = 0; i < size; i++) {
    const p = histogram[i]
    if (p > 0) {
      sum += p
      retval -= p * fastLog2(p)
    }
  }
  
  if (sum > 0) {
    retval += sum * fastLog2(sum)
  }
  
  // At least one bit per symbol needed
  if (retval < sum) {
    retval = sum
  }
  
  return retval
}

// Population Cost (Full Histogram Cost Estimation)

const MAX_SCRATCH_SYMBOLS = 1024
const ZERO_HISTOGRAM = new Uint32Array(MAX_SCRATCH_SYMBOLS)
const ZERO_MASK = new Uint32Array(MAX_SCRATCH_SYMBOLS >>> 5)
const maskScratch = new Uint32Array(MAX_SCRATCH_SYMBOLS >>> 5)
const depthScratch = new Uint32Array(CODE_LENGTH_CODES)

// Words needed for one bit per symbol
export function occupancyMaskLength(alphabetSize: number): number {
  return (alphabetSize + 31) >>> 5
}

// Sets bit i of `mask` exactly when data[i] is nonzero
export function buildOccupancyMask(data: Uint32Array, mask: Uint32Array): void {
  mask.fill(0)
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0) mask[i >>> 5] |= 1 << (i & 31)
  }
}

// Estimate total bit cost including entropy + Huffman tree overhead
// Main cost function for block splitting and clustering
export function populationCost(data: Uint32Array, totalCount: number): number {
  const fits = data.length <= MAX_SCRATCH_SYMBOLS
  const words = occupancyMaskLength(data.length)
  const mask = fits ? maskScratch.subarray(0, words) : new Uint32Array(words)
  buildOccupancyMask(data, mask)
  return populationCostSum(
    data, mask,
    fits ? ZERO_HISTOGRAM : new Uint32Array(data.length),
    fits ? ZERO_MASK : new Uint32Array(words),
    totalCount)
}

// Cost of the histogram a + b, without materialising it. Clustering asks this
// for every candidate merge, so it must not allocate
//
// Histograms are mostly zeros, so each comes with a bitmask of its nonzero
// entries and only those are visited; a gap between two of them is a zero run
//
// Callers only want to know whether `cost - bias < limit`. The running total
// never decreases, so the scan stops as soon as that is ruled out and returns
// the partial total, which fails the same test
export function populationCostSum(
  a: Uint32Array,
  maskA: Uint32Array,
  b: Uint32Array,
  maskB: Uint32Array,
  totalCount: number,
  bias = 0,
  limit = Infinity
): number {
  if (totalCount === 0) {
    return ONE_SYMBOL_HISTOGRAM_COST
  }
  const words = maskA.length

  // Up to four distinct symbols have exact closed forms
  let count = 0
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0
  for (let w = 0; w < words && count <= 4; w++) {
    let m = maskA[w] | maskB[w]
    while (m !== 0) {
      const low = m & -m
      const i = (w << 5) + 31 - Math.clz32(low)
      m ^= low
      if (count === 0) s0 = i
      else if (count === 1) s1 = i
      else if (count === 2) s2 = i
      else if (count === 3) s3 = i
      if (++count > 4) break
    }
  }

  if (count === 1) {
    return ONE_SYMBOL_HISTOGRAM_COST
  }

  if (count === 2) {
    return TWO_SYMBOL_HISTOGRAM_COST + totalCount
  }

  if (count === 3) {
    const histo0 = a[s0] + b[s0]
    const histo1 = a[s1] + b[s1]
    const histo2 = a[s2] + b[s2]
    const histomax = Math.max(histo0, Math.max(histo1, histo2))
    return THREE_SYMBOL_HISTOGRAM_COST + 2 * (histo0 + histo1 + histo2) - histomax
  }

  if (count === 4) {
    // Sort descending
    let h0 = a[s0] + b[s0], h1 = a[s1] + b[s1], h2 = a[s2] + b[s2], h3 = a[s3] + b[s3]
    let t = 0
    if (h0 < h1) { t = h0; h0 = h1; h1 = t }
    if (h2 < h3) { t = h2; h2 = h3; h3 = t }
    if (h0 < h2) { t = h0; h0 = h2; h2 = t }
    if (h1 < h3) { t = h1; h1 = h3; h3 = t }
    if (h1 < h2) { t = h1; h1 = h2; h2 = t }
    const h23 = h2 + h3
    const histomax = Math.max(h23, h0)
    return FOUR_SYMBOL_HISTOGRAM_COST + 3 * h23 + 2 * (h0 + h1) - histomax
  }

  // General case: compute entropy + tree encoding cost
  let bits = 0
  let maxDepth = 1
  const depthHisto = depthScratch
  depthHisto.fill(0)
  const log2total = fastLog2(totalCount)

  // The zeros after the last symbol are implicit in the format and cost nothing
  let prev = -1
  for (let w = 0; w < words; w++) {
    let m = maskA[w] | maskB[w]
    while (m !== 0) {
      const low = m & -m
      const i = (w << 5) + 31 - Math.clz32(low)
      m ^= low

      const zeroRun = i - prev - 1
      prev = i
      if (zeroRun !== 0) {
        if (zeroRun < 3) {
          depthHisto[0] += zeroRun
        } else {
          // Each repeat-zero code carries 3 extra bits
          let reps = zeroRun - 2
          while (reps > 0) {
            depthHisto[REPEAT_ZERO_CODE_LENGTH]++
            bits += 3
            reps >>>= 3
          }
        }
      }

      // Uint32 loads are not int32 to V8, so a bare sum runs as float64; the
      // truncation keeps it an integer
      const v = (a[i] + b[i]) | 0
      const log2p = log2total - fastLog2(v)
      // log2p is never negative, so this is Math.round without the call
      let depth = (log2p + 0.5) | 0
      bits += v * log2p
      if (bits - bias >= limit) return bits

      if (depth > 15) depth = 15
      if (depth > maxDepth) maxDepth = depth
      depthHisto[depth]++
    }
  }

  // Add code length code histogram encoding cost
  bits += 18 + 2 * maxDepth
  bits += bitsEntropy(depthHisto)

  return bits
}

export function populationCostLiteral(histogram: HistogramLiteral): number {
  return populationCost(histogram.data, histogram.totalCount)
}

export function populationCostCommand(histogram: HistogramCommand): number {
  return populationCost(histogram.data, histogram.totalCount)
}

export function populationCostDistance(histogram: HistogramDistance): number {
  return populationCost(histogram.data, histogram.totalCount)
}

export function histogramCostCombine(
  a: Uint32Array,
  b: Uint32Array,
  totalA: number,
  totalB: number
): number {
  const size = a.length
  const combined = new Uint32Array(size)
  
  for (let i = 0; i < size; i++) {
    combined[i] = a[i] + b[i]
  }
  
  return populationCost(combined, totalA + totalB)
}

// Returns combined cost minus individual costs (positive = merge is expensive)
export function histogramDistance(
  a: Uint32Array,
  b: Uint32Array,
  totalA: number,
  totalB: number,
  costA: number,
  costB: number
): number {
  const combinedCost = histogramCostCombine(a, b, totalA, totalB)
  return combinedCost - costA - costB
}

// Literal Byte Cost Estimation

export function estimateLiteralCost(
  data: Uint8Array,
  start: number,
  length: number
): number {
  if (length === 0) return 0
  
  // Build histogram
  const histogram = new Uint32Array(256)
  for (let i = start; i < start + length; i++) {
    histogram[data[i]]++
  }
  
  return populationCost(histogram, length)
}

export function estimateSingleLiteralCost(
  byte: number,
  contextHistogram: Uint32Array,
  totalInContext: number
): number {
  if (totalInContext === 0) return 8 // Default to 8 bits
  
  const count = contextHistogram[byte]
  if (count === 0) {
    // Symbol not seen in context - expensive
    return fastLog2(totalInContext) + 2
  }
  
  // Shannon entropy: -log2(count/total) = log2(total) - log2(count)
  return fastLog2(totalInContext) - fastLog2(count)
}
