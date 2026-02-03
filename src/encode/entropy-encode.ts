// Huffman tree construction for Brotli compression
// Reference: woff2/brotli/c/enc/entropy_encode.h, entropy_encode.c

export const MAX_HUFFMAN_BITS = 15
export const MAX_CODE_LENGTH_BITS = 7
export const REPEAT_PREVIOUS_CODE_LENGTH = 16
export const REPEAT_ZERO_CODE_LENGTH = 17
export const CODE_LENGTH_CODES = 18
export const INITIAL_REPEATED_CODE_LENGTH = 8

const SHELL_GAPS = [132, 57, 23, 10, 4, 1]

export interface HuffmanTree {
  depths: Uint8Array
  bits: Uint16Array
}

interface HuffmanNode {
  totalCount: number
  indexLeft: number          // -1 for leaf nodes
  indexRightOrValue: number  // symbol value for leaf, right child index for internal
}

export function createHuffmanTree(
  histogram: Uint32Array,
  treeLimit: number = MAX_HUFFMAN_BITS
): HuffmanTree {
  const length = histogram.length
  const depths = new Uint8Array(length)
  const bits = new Uint16Array(length)
  
  // Count non-zero symbols
  let nonZeroCount = 0
  let lastNonZero = 0
  for (let i = 0; i < length; i++) {
    if (histogram[i] > 0) {
      nonZeroCount++
      lastNonZero = i
    }
  }
  
  // Handle special cases
  if (nonZeroCount === 0) {
    // Empty histogram - no codes needed
    return { depths, bits }
  }
  
  if (nonZeroCount === 1) {
    // Single symbol gets depth 1
    depths[lastNonZero] = 1
    bits[lastNonZero] = 0
    return { depths, bits }
  }
  
  // Build Huffman tree using the standard algorithm
  // Need space for: n leaf nodes + (n-1) internal nodes + 2 sentinels
  const tree: HuffmanNode[] = new Array(2 * length + 2)
  
  // Retry with increasing count_limit until tree fits in treeLimit bits
  for (let countLimit = 1; ; countLimit *= 2) {
    let n = 0
    
    // Create leaf nodes (in reverse order for tie-breaking)
    for (let i = length - 1; i >= 0; i--) {
      if (histogram[i] > 0) {
        const count = Math.max(histogram[i], countLimit)
        tree[n++] = {
          totalCount: count,
          indexLeft: -1,
          indexRightOrValue: i,
        }
      }
    }
    
    // Sort leaf nodes by count (ascending), then by value (descending for ties)
    sortHuffmanNodes(tree, n)
    
    // Add sentinel nodes
    const sentinel: HuffmanNode = {
      totalCount: 0xFFFFFFFF,
      indexLeft: -1,
      indexRightOrValue: -1,
    }
    tree[n] = sentinel
    tree[n + 1] = sentinel
    
    // Build tree bottom-up
    let i = 0  // Points to next leaf node
    let j = n + 1  // Points to next internal node
    
    for (let k = n - 1; k > 0; k--) {
      // Select two smallest nodes
      let left: number
      if (tree[i].totalCount <= tree[j].totalCount) {
        left = i++
      } else {
        left = j++
      }
      
      let right: number
      if (tree[i].totalCount <= tree[j].totalCount) {
        right = i++
      } else {
        right = j++
      }
      
      // Create internal node
      const jEnd = 2 * n - k
      tree[jEnd] = {
        totalCount: tree[left].totalCount + tree[right].totalCount,
        indexLeft: left,
        indexRightOrValue: right,
      }
      tree[jEnd + 1] = sentinel
    }
    
    // Traverse tree to set depths
    if (setDepth(2 * n - 1, tree, depths, treeLimit)) {
      break
    }
    
    // Tree too deep - reset depths and try again with higher count_limit
    depths.fill(0)
  }
  
  // Convert depths to actual Huffman codes
  convertBitDepthsToSymbols(depths, bits)
  
  return { depths, bits }
}

function setDepth(
  root: number,
  tree: HuffmanNode[],
  depths: Uint8Array,
  maxDepth: number
): boolean {
  const stack = new Int32Array(16)
  let level = 0
  let p = root
  stack[0] = -1
  
  while (true) {
    if (tree[p].indexLeft >= 0) {
      // Internal node - go left
      level++
      if (level > maxDepth) return false
      stack[level] = tree[p].indexRightOrValue
      p = tree[p].indexLeft
      continue
    } else {
      // Leaf node - set depth
      depths[tree[p].indexRightOrValue] = level
    }
    
    // Backtrack
    while (level >= 0 && stack[level] === -1) level--
    if (level < 0) return true
    p = stack[level]
    stack[level] = -1
  }
}

function sortHuffmanNodes(nodes: HuffmanNode[], n: number): void {
  if (n < 13) {
    // Insertion sort for small arrays
    for (let i = 1; i < n; i++) {
      const tmp = nodes[i]
      let k = i
      let j = i - 1
      while (j >= 0 && compareNodes(tmp, nodes[j])) {
        nodes[k] = nodes[j]
        k = j
        j--
      }
      nodes[k] = tmp
    }
  } else {
    // Shell sort
    const startGap = n < 57 ? 2 : 0
    for (let g = startGap; g < 6; g++) {
      const gap = SHELL_GAPS[g]
      for (let i = gap; i < n; i++) {
        let j = i
        const tmp = nodes[i]
        while (j >= gap && compareNodes(tmp, nodes[j - gap])) {
          nodes[j] = nodes[j - gap]
          j -= gap
        }
        nodes[j] = tmp
      }
    }
  }
}

function compareNodes(a: HuffmanNode, b: HuffmanNode): boolean {
  if (a.totalCount !== b.totalCount) {
    return a.totalCount < b.totalCount
  }
  return a.indexRightOrValue > b.indexRightOrValue
}

function reverseBits(numBits: number, bits: number): number {
  const LUT = [0x0, 0x8, 0x4, 0xC, 0x2, 0xA, 0x6, 0xE, 0x1, 0x9, 0x5, 0xD, 0x3, 0xB, 0x7, 0xF]
  let retval = LUT[bits & 0xF]
  for (let i = 4; i < numBits; i += 4) {
    retval <<= 4
    bits >>>= 4
    retval |= LUT[bits & 0xF]
  }
  retval >>>= (-numBits) & 0x3
  return retval
}

export function convertBitDepthsToSymbols(depths: Uint8Array, bits: Uint16Array): void {
  const len = depths.length
  const blCount = new Uint16Array(MAX_HUFFMAN_BITS + 1)
  const nextCode = new Uint16Array(MAX_HUFFMAN_BITS + 1)
  
  // Count codes at each depth
  for (let i = 0; i < len; i++) {
    blCount[depths[i]]++
  }
  blCount[0] = 0
  
  // Calculate starting code for each depth
  let code = 0
  for (let i = 1; i <= MAX_HUFFMAN_BITS; i++) {
    code = (code + blCount[i - 1]) << 1
    nextCode[i] = code
  }
  
  // Assign codes to symbols
  for (let i = 0; i < len; i++) {
    if (depths[i] > 0) {
      bits[i] = reverseBits(depths[i], nextCode[depths[i]]++)
    }
  }
}

// RLE Optimization for Huffman Tree Encoding

export function optimizeHuffmanCountsForRle(counts: Uint32Array): void {
  const length = counts.length
  const goodForRle = new Uint8Array(length)
  const streakLimit = 1240
  
  // Count non-zeros
  let nonZeroCount = 0
  for (let i = 0; i < length; i++) {
    if (counts[i] > 0) nonZeroCount++
  }
  
  if (nonZeroCount < 16) return
  
  // Trim trailing zeros
  let newLength = length
  while (newLength > 0 && counts[newLength - 1] === 0) {
    newLength--
  }
  if (newLength === 0) return
  
  // Check conditions for optimization
  let nonzeros = 0
  let smallestNonzero = 0x3FFFFFFF
  for (let i = 0; i < newLength; i++) {
    if (counts[i] !== 0) {
      nonzeros++
      if (smallestNonzero > counts[i]) {
        smallestNonzero = counts[i]
      }
    }
  }
  
  if (nonzeros < 5) return
  
  // Fill in isolated zeros
  if (smallestNonzero < 4) {
    const zeros = newLength - nonzeros
    if (zeros < 6) {
      for (let i = 1; i < newLength - 1; i++) {
        if (counts[i - 1] !== 0 && counts[i] === 0 && counts[i + 1] !== 0) {
          counts[i] = 1
        }
      }
    }
  }
  
  if (nonzeros < 28) return
  
  // Mark good RLE sequences
  let symbol = counts[0]
  let step = 0
  for (let i = 0; i <= newLength; i++) {
    if (i === newLength || counts[i] !== symbol) {
      if ((symbol === 0 && step >= 5) || (symbol !== 0 && step >= 7)) {
        for (let k = 0; k < step; k++) {
          goodForRle[i - k - 1] = 1
        }
      }
      step = 1
      if (i !== newLength) {
        symbol = counts[i]
      }
    } else {
      step++
    }
  }
  
  // Replace counts to create better RLE opportunities
  let stride = 0
  let limit = ((256 * (counts[0] + counts[1] + counts[2])) / 3 + 420) | 0
  let sum = 0
  
  for (let i = 0; i <= newLength; i++) {
    if (i === newLength || goodForRle[i] ||
        (i !== 0 && goodForRle[i - 1]) ||
        (256 * counts[i] - limit + streakLimit) >= 2 * streakLimit) {
      
      if (stride >= 4 || (stride >= 3 && sum === 0)) {
        let count = sum === 0 ? 0 : Math.round(sum / stride)
        if (count === 0 && sum !== 0) count = 1
        
        for (let k = 0; k < stride; k++) {
          counts[i - k - 1] = count
        }
      }
      
      stride = 0
      sum = 0
      
      if (i < newLength - 2) {
        limit = ((256 * (counts[i] + counts[i + 1] + counts[i + 2])) / 3 + 420) | 0
      } else if (i < newLength) {
        limit = 256 * counts[i]
      } else {
        limit = 0
      }
    }
    
    stride++
    if (i !== newLength) {
      sum += counts[i]
      if (stride >= 4) {
        limit = ((256 * sum + stride / 2) / stride) | 0
      }
      if (stride === 4) {
        limit += 120
      }
    }
  }
}

// Write Huffman Tree for Encoding

export interface HuffmanTreeRle {
  symbols: Uint8Array
  extraBits: Uint8Array
  length: number
}

// Write as RLE-encoded code lengths
export function writeHuffmanTree(depths: Uint8Array): HuffmanTreeRle {
  const length = depths.length
  const symbols = new Uint8Array(length + length)
  const extraBits = new Uint8Array(length + length)
  let treeSize = 0
  
  // Trim trailing zeros
  let newLength = length
  for (let i = length - 1; i >= 0 && depths[i] === 0; i--) {
    newLength--
  }
  
  // Decide whether to use RLE
  let useRleNonZero = false
  let useRleZero = false
  
  if (newLength > 50) {
    let totalRepsZero = 0
    let totalRepsNonZero = 0
    let countRepsZero = 1
    let countRepsNonZero = 1
    
    for (let i = 0; i < newLength;) {
      const value = depths[i]
      let reps = 1
      for (let k = i + 1; k < newLength && depths[k] === value; k++) {
        reps++
      }
      if (reps >= 3 && value === 0) {
        totalRepsZero += reps
        countRepsZero++
      }
      if (reps >= 4 && value !== 0) {
        totalRepsNonZero += reps
        countRepsNonZero++
      }
      i += reps
    }
    
    useRleNonZero = totalRepsNonZero > countRepsNonZero * 2
    useRleZero = totalRepsZero > countRepsZero * 2
  }
  
  // Encode with RLE
  let previousValue = INITIAL_REPEATED_CODE_LENGTH
  
  for (let i = 0; i < newLength;) {
    const value = depths[i]
    let reps = 1
    
    if ((value !== 0 && useRleNonZero) || (value === 0 && useRleZero)) {
      for (let k = i + 1; k < newLength && depths[k] === value; k++) {
        reps++
      }
    }
    
    if (value === 0) {
      treeSize = writeHuffmanTreeRepetitionsZeros(reps, treeSize, symbols, extraBits)
    } else {
      treeSize = writeHuffmanTreeRepetitions(previousValue, value, reps, treeSize, symbols, extraBits)
      previousValue = value
    }
    
    i += reps
  }
  
  return { symbols, extraBits, length: treeSize }
}

function writeHuffmanTreeRepetitions(
  previousValue: number,
  value: number,
  repetitions: number,
  treeSize: number,
  symbols: Uint8Array,
  extraBits: Uint8Array
): number {
  if (previousValue !== value) {
    symbols[treeSize] = value
    extraBits[treeSize] = 0
    treeSize++
    repetitions--
  }
  
  if (repetitions === 7) {
    symbols[treeSize] = value
    extraBits[treeSize] = 0
    treeSize++
    repetitions--
  }
  
  if (repetitions < 3) {
    for (let i = 0; i < repetitions; i++) {
      symbols[treeSize] = value
      extraBits[treeSize] = 0
      treeSize++
    }
  } else {
    const start = treeSize
    repetitions -= 3
    while (true) {
      symbols[treeSize] = REPEAT_PREVIOUS_CODE_LENGTH
      extraBits[treeSize] = repetitions & 0x3
      treeSize++
      repetitions >>>= 2
      if (repetitions === 0) break
      repetitions--
    }
    // Reverse the repeat codes
    reverse(symbols, start, treeSize)
    reverse(extraBits, start, treeSize)
  }
  
  return treeSize
}

function writeHuffmanTreeRepetitionsZeros(
  repetitions: number,
  treeSize: number,
  symbols: Uint8Array,
  extraBits: Uint8Array
): number {
  if (repetitions === 11) {
    symbols[treeSize] = 0
    extraBits[treeSize] = 0
    treeSize++
    repetitions--
  }
  
  if (repetitions < 3) {
    for (let i = 0; i < repetitions; i++) {
      symbols[treeSize] = 0
      extraBits[treeSize] = 0
      treeSize++
    }
  } else {
    const start = treeSize
    repetitions -= 3
    while (true) {
      symbols[treeSize] = REPEAT_ZERO_CODE_LENGTH
      extraBits[treeSize] = repetitions & 0x7
      treeSize++
      repetitions >>>= 3
      if (repetitions === 0) break
      repetitions--
    }
    // Reverse the repeat codes
    reverse(symbols, start, treeSize)
    reverse(extraBits, start, treeSize)
  }
  
  return treeSize
}

function reverse(arr: Uint8Array, start: number, end: number): void {
  end--
  while (start < end) {
    const tmp = arr[start]
    arr[start] = arr[end]
    arr[end] = tmp
    start++
    end--
  }
}
