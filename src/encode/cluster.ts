// Histogram clustering for Brotli compression
// Reference: woff2/brotli/c/enc/cluster.h, cluster_inc.h

import { populationCost } from './bit-cost'
import { fastLog2 } from './fast-log'

export interface ClusterHistogram {
  data: Uint32Array
  totalCount: number
  bitCost: number
}

export interface HistogramPair {
  idx1: number
  idx2: number
  costCombo: number // combined cost after merging
  costDiff: number  // positive = good merge, negative = bad
}

function clusterCostDiff(sizeA: number, sizeB: number): number {
  const sizeC = sizeA + sizeB
  return sizeC * fastLog2(sizeC) - sizeA * fastLog2(sizeA) - sizeB * fastLog2(sizeB)
}

// Returns true if a should be replaced by b
function histogramPairIsLess(a: HistogramPair, b: HistogramPair): boolean {
  if (a.costDiff !== b.costDiff) {
    return a.costDiff > b.costDiff
  }
  return a.idx2 - a.idx1 > b.idx2 - b.idx1
}

export function createClusterHistogram(size: number): ClusterHistogram {
  return {
    data: new Uint32Array(size),
    totalCount: 0,
    bitCost: 0,
  }
}

export function clearClusterHistogram(h: ClusterHistogram): void {
  h.data.fill(0)
  h.totalCount = 0
  h.bitCost = 0
}

export function copyClusterHistogram(a: ClusterHistogram, b: ClusterHistogram): void {
  b.data.set(a.data)
  b.totalCount = a.totalCount
  b.bitCost = a.bitCost
}

export function addClusterHistograms(a: ClusterHistogram, b: ClusterHistogram): void {
  for (let i = 0; i < a.data.length; i++) {
    a.data[i] += b.data[i]
  }
  a.totalCount += b.totalCount
}

export function computeClusterBitCost(h: ClusterHistogram): number {
  return populationCost(h.data, h.totalCount)
}

// Queue maintains best (lowest) cost diff pair at index 0
export function compareAndPushToQueue(
  out: ClusterHistogram[],
  tmp: ClusterHistogram,
  clusterSize: Uint32Array,
  idx1: number,
  idx2: number,
  maxNumPairs: number,
  pairs: HistogramPair[],
  numPairs: { value: number }
): void {
  if (idx1 === idx2) return
  
  // Ensure idx1 < idx2
  if (idx2 < idx1) {
    const t = idx1
    idx1 = idx2
    idx2 = t
  }
  
  const p: HistogramPair = {
    idx1,
    idx2,
    costDiff: 0.5 * clusterCostDiff(clusterSize[idx1], clusterSize[idx2]),
    costCombo: 0,
  }
  
  p.costDiff -= out[idx1].bitCost
  p.costDiff -= out[idx2].bitCost
  
  let isGoodPair = false
  
  if (out[idx1].totalCount === 0) {
    p.costCombo = out[idx2].bitCost
    isGoodPair = true
  } else if (out[idx2].totalCount === 0) {
    p.costCombo = out[idx1].bitCost
    isGoodPair = true
  } else {
    const threshold = numPairs.value === 0 ? 1e99 :
      Math.max(0.0, pairs[0].costDiff)
    
    // Compute combined histogram cost
    copyClusterHistogram(out[idx1], tmp)
    addClusterHistograms(tmp, out[idx2])
    const costCombo = computeClusterBitCost(tmp)
    
    if (costCombo < threshold - p.costDiff) {
      p.costCombo = costCombo
      isGoodPair = true
    }
  }
  
  if (isGoodPair) {
    p.costDiff += p.costCombo
    
    if (numPairs.value > 0 && histogramPairIsLess(pairs[0], p)) {
      // Replace top of queue if needed
      if (numPairs.value < maxNumPairs) {
        pairs[numPairs.value] = pairs[0]
        numPairs.value++
      }
      pairs[0] = p
    } else if (numPairs.value < maxNumPairs) {
      pairs[numPairs.value] = p
      numPairs.value++
    }
  }
}

// Combine similar histograms until at most maxClusters remain
export function histogramCombine(
  out: ClusterHistogram[],
  tmp: ClusterHistogram,
  clusterSize: Uint32Array,
  symbols: Uint32Array,
  clusters: Uint32Array,
  pairs: HistogramPair[],
  numClusters: number,
  symbolsSize: number,
  maxClusters: number,
  maxNumPairs: number
): number {
  let costDiffThreshold = 0.0
  let minClusterSize = 1
  const numPairs = { value: 0 }
  
  // Initialize pair queue with all pairs
  for (let idx1 = 0; idx1 < numClusters; idx1++) {
    for (let idx2 = idx1 + 1; idx2 < numClusters; idx2++) {
      compareAndPushToQueue(
        out, tmp, clusterSize,
        clusters[idx1], clusters[idx2],
        maxNumPairs, pairs, numPairs
      )
    }
  }
  
  // Combine until we have few enough clusters
  while (numClusters > minClusterSize) {
    if (pairs[0].costDiff >= costDiffThreshold) {
      costDiffThreshold = 1e99
      minClusterSize = maxClusters
      continue
    }
    
    // Take the best pair
    const bestIdx1 = pairs[0].idx1
    const bestIdx2 = pairs[0].idx2
    
    // Merge idx2 into idx1
    addClusterHistograms(out[bestIdx1], out[bestIdx2])
    out[bestIdx1].bitCost = pairs[0].costCombo
    clusterSize[bestIdx1] += clusterSize[bestIdx2]
    
    // Update symbol assignments
    for (let i = 0; i < symbolsSize; i++) {
      if (symbols[i] === bestIdx2) {
        symbols[i] = bestIdx1
      }
    }
    
    // Remove bestIdx2 from clusters
    for (let i = 0; i < numClusters; i++) {
      if (clusters[i] === bestIdx2) {
        // Shift remaining clusters
        for (let j = i; j < numClusters - 1; j++) {
          clusters[j] = clusters[j + 1]
        }
        break
      }
    }
    numClusters--
    
    // Remove invalidated pairs
    let copyToIdx = 0
    for (let i = 0; i < numPairs.value; i++) {
      const p = pairs[i]
      if (p.idx1 === bestIdx1 || p.idx2 === bestIdx1 ||
          p.idx1 === bestIdx2 || p.idx2 === bestIdx2) {
        continue
      }
      if (histogramPairIsLess(pairs[0], p)) {
        const front = pairs[0]
        pairs[0] = p
        pairs[copyToIdx] = front
      } else {
        pairs[copyToIdx] = p
      }
      copyToIdx++
    }
    numPairs.value = copyToIdx
    
    // Add new pairs with the merged cluster
    for (let i = 0; i < numClusters; i++) {
      compareAndPushToQueue(
        out, tmp, clusterSize,
        bestIdx1, clusters[i],
        maxNumPairs, pairs, numPairs
      )
    }
  }
  
  return numClusters
}

export function histogramBitCostDistance(
  histogram: ClusterHistogram,
  candidate: ClusterHistogram,
  tmp: ClusterHistogram
): number {
  if (histogram.totalCount === 0) {
    return 0.0
  }
  
  copyClusterHistogram(histogram, tmp)
  addClusterHistograms(tmp, candidate)
  return computeClusterBitCost(tmp) - candidate.bitCost
}

export function histogramRemap(
  input: ClusterHistogram[],
  inSize: number,
  clusters: Uint32Array,
  numClusters: number,
  out: ClusterHistogram[],
  tmp: ClusterHistogram,
  symbols: Uint32Array
): void {
  // Assign each input to best cluster
  for (let i = 0; i < inSize; i++) {
    let bestOut = i === 0 ? symbols[0] : symbols[i - 1]
    let bestBits = histogramBitCostDistance(input[i], out[bestOut], tmp)
    
    for (let j = 0; j < numClusters; j++) {
      const curBits = histogramBitCostDistance(input[i], out[clusters[j]], tmp)
      if (curBits < bestBits) {
        bestBits = curBits
        bestOut = clusters[j]
      }
    }
    symbols[i] = bestOut
  }
  
  // Recompute output histograms from inputs
  for (let i = 0; i < numClusters; i++) {
    clearClusterHistogram(out[clusters[i]])
  }
  for (let i = 0; i < inSize; i++) {
    addClusterHistograms(out[symbols[i]], input[i])
  }
}

// Reindex so symbols are consecutive from 0; returns number of unique histograms
export function histogramReindex(
  out: ClusterHistogram[],
  symbols: Uint32Array,
  length: number
): number {
  const INVALID_INDEX = 0xFFFFFFFF
  const newIndex = new Uint32Array(length)
  newIndex.fill(INVALID_INDEX)
  
  let nextIndex = 0
  for (let i = 0; i < length; i++) {
    if (newIndex[symbols[i]] === INVALID_INDEX) {
      newIndex[symbols[i]] = nextIndex++
    }
  }
  
  // Reorder histograms
  const tmp: ClusterHistogram[] = []
  for (let i = 0; i < nextIndex; i++) {
    tmp.push(createClusterHistogram(out[0].data.length))
  }
  
  nextIndex = 0
  for (let i = 0; i < length; i++) {
    if (newIndex[symbols[i]] === nextIndex) {
      copyClusterHistogram(out[symbols[i]], tmp[nextIndex])
      nextIndex++
    }
    symbols[i] = newIndex[symbols[i]]
  }
  
  for (let i = 0; i < tmp.length; i++) {
    copyClusterHistogram(tmp[i], out[i])
  }
  
  return tmp.length
}

// Group similar histograms together
export function clusterHistograms(
  input: ClusterHistogram[],
  inSize: number,
  maxHistograms: number,
  out: ClusterHistogram[],
  histogramSymbols: Uint32Array
): number {
  const dataSize = input[0].data.length
  const clusterSize = new Uint32Array(inSize)
  const clusters = new Uint32Array(inSize)
  const maxInputHistograms = 64
  const pairsCapacity = (maxInputHistograms * maxInputHistograms) / 2
  const pairs: HistogramPair[] = new Array(pairsCapacity + 1)
  const tmp = createClusterHistogram(dataSize)
  
  // Initialize
  for (let i = 0; i < inSize; i++) {
    clusterSize[i] = 1
    copyClusterHistogram(input[i], out[i])
    out[i].bitCost = computeClusterBitCost(input[i])
    histogramSymbols[i] = i
  }
  
  let numClusters = 0
  
  // First pass: cluster in batches
  for (let i = 0; i < inSize; i += maxInputHistograms) {
    const numToCombine = Math.min(inSize - i, maxInputHistograms)
    
    for (let j = 0; j < numToCombine; j++) {
      clusters[numClusters + j] = i + j
    }
    
    const numNewClusters = histogramCombine(
      out, tmp, clusterSize,
      histogramSymbols.subarray(i),
      clusters.subarray(numClusters),
      pairs,
      numToCombine, numToCombine,
      maxHistograms, pairsCapacity
    )
    
    numClusters += numNewClusters
  }
  
  // Second pass: combine all clusters
  const maxNumPairs = Math.min(64 * numClusters, (numClusters / 2) * numClusters)
  
  numClusters = histogramCombine(
    out, tmp, clusterSize,
    histogramSymbols, clusters,
    pairs,
    numClusters, inSize,
    maxHistograms, maxNumPairs
  )
  
  // Find optimal mapping
  histogramRemap(input, inSize, clusters, numClusters, out, tmp, histogramSymbols)
  
  // Reindex to canonical form
  return histogramReindex(out, histogramSymbols, inSize)
}
