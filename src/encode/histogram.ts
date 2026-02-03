// Histogram building for Brotli compression
// Reference: woff2/brotli/c/enc/histogram.h, histogram.c

import { NUM_LITERAL_CODES, NUM_COMMAND_CODES } from './enc-constants'

// Distance histogram size (supports large window brotli)
export const NUM_DISTANCE_HISTOGRAM_SYMBOLS = 544

export interface HistogramLiteral {
  data: Uint32Array  // 256 buckets
  totalCount: number
  bitCost: number
}

export interface HistogramCommand {
  data: Uint32Array  // 704 buckets
  totalCount: number
  bitCost: number
}

export interface HistogramDistance {
  data: Uint32Array  // 544 buckets
  totalCount: number
  bitCost: number
}

export function createHistogramLiteral(): HistogramLiteral {
  return {
    data: new Uint32Array(NUM_LITERAL_CODES),
    totalCount: 0,
    bitCost: Infinity,
  }
}

export function createHistogramCommand(): HistogramCommand {
  return {
    data: new Uint32Array(NUM_COMMAND_CODES),
    totalCount: 0,
    bitCost: Infinity,
  }
}

export function createHistogramDistance(): HistogramDistance {
  return {
    data: new Uint32Array(NUM_DISTANCE_HISTOGRAM_SYMBOLS),
    totalCount: 0,
    bitCost: Infinity,
  }
}

export function histogramClear<T extends { data: Uint32Array; totalCount: number; bitCost: number }>(
  histogram: T
): void {
  histogram.data.fill(0)
  histogram.totalCount = 0
  histogram.bitCost = Infinity
}

export function clearHistograms<T extends { data: Uint32Array; totalCount: number; bitCost: number }>(
  histograms: T[]
): void {
  for (let i = 0; i < histograms.length; i++) {
    histogramClear(histograms[i])
  }
}

export function histogramAdd<T extends { data: Uint32Array; totalCount: number }>(
  histogram: T,
  symbol: number
): void {
  histogram.data[symbol]++
  histogram.totalCount++
}

export function histogramAddVector<T extends { data: Uint32Array; totalCount: number }>(
  histogram: T,
  symbols: Uint8Array | Uint16Array,
  start: number,
  count: number
): void {
  const end = start + count
  histogram.totalCount += count
  for (let i = start; i < end; i++) {
    histogram.data[symbols[i]]++
  }
}

export function histogramAddHistogram<T extends { data: Uint32Array; totalCount: number }>(
  dest: T,
  src: T
): void {
  dest.totalCount += src.totalCount
  const len = dest.data.length
  for (let i = 0; i < len; i++) {
    dest.data[i] += src.data[i]
  }
}

export function histogramNumNonZero<T extends { data: Uint32Array }>(histogram: T): number {
  let count = 0
  const data = histogram.data
  for (let i = 0; i < data.length; i++) {
    if (data[i] > 0) count++
  }
  return count
}

export function buildLiteralHistogram(
  data: Uint8Array,
  start: number,
  length: number
): HistogramLiteral {
  const histogram = createHistogramLiteral()
  const end = start + length
  histogram.totalCount = length
  for (let i = start; i < end; i++) {
    histogram.data[data[i]]++
  }
  return histogram
}

export function buildHistogram(
  symbols: Uint8Array | Uint16Array | Uint32Array,
  start: number,
  length: number,
  alphabetSize: number
): Uint32Array {
  const histogram = new Uint32Array(alphabetSize)
  const end = start + length
  for (let i = start; i < end; i++) {
    histogram[symbols[i]]++
  }
  return histogram
}

import { BlockSplit } from './block-splitter'

// Re-export BlockSplit for convenience
export type { BlockSplit }

/**
 * Iterator for walking through block splits
 */
export class BlockSplitIterator {
  private split: BlockSplit
  private idx: number = 0
  type: number = 0
  private length: number

  constructor(split: BlockSplit) {
    this.split = split
    this.length = split.lengths.length > 0 ? split.lengths[0] : 0
  }

  next(): void {
    if (this.length === 0) {
      this.idx++
      this.type = this.split.types[this.idx]
      this.length = this.split.lengths[this.idx]
    }
    this.length--
  }
}

export function createEmptyBlockSplit(): BlockSplit {
  return {
    numTypes: 1,
    types: new Uint8Array([0]),
    lengths: new Uint32Array([0]),
    numBlocks: 0,
  }
}
