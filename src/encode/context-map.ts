// Context map encoding for Brotli compression
// Reference: woff2/brotli/c/enc/brotli_bit_stream.c

import { BitWriter } from './bit-writer'
import { log2FloorNonZero } from './fast-log'
import { createHuffmanTree, convertBitDepthsToSymbols } from './entropy-encode'

export const MAX_CONTEXT_MAP_SYMBOLS = 256 + 16 // num_clusters + max_rle_prefix

// Move-to-Front Transform

// Apply move-to-front transform: recently used values get small indices
export function moveToFrontTransform(
  input: Uint32Array,
  size: number
): Uint32Array {
  if (size === 0) return new Uint32Array(0)
  
  // Find max value
  let maxValue = input[0]
  for (let i = 1; i < size; i++) {
    if (input[i] > maxValue) maxValue = input[i]
  }
  
  // Initialize MTF list
  const mtf = new Uint8Array(maxValue + 1)
  for (let i = 0; i <= maxValue; i++) {
    mtf[i] = i
  }
  
  // Transform
  const output = new Uint32Array(size)
  
  for (let i = 0; i < size; i++) {
    const value = input[i]
    // Find index of value in MTF list
    let index = 0
    while (mtf[index] !== value) {
      index++
    }
    output[i] = index
    // Move to front
    for (let j = index; j > 0; j--) {
      mtf[j] = mtf[j - 1]
    }
    mtf[0] = value
  }
  
  return output
}

// Run-Length Encoding for Zeros

// Encode runs of zeros using prefix codes
export function runLengthCodeZeros(
  input: Uint32Array,
  size: number,
  maxRunLengthPrefix: number
): { output: Uint32Array; outSize: number; maxPrefix: number } {
  // Find longest run of zeros
  let maxReps = 0
  for (let i = 0; i < size;) {
    let reps = 0
    while (i < size && input[i] !== 0) i++
    while (i < size && input[i] === 0) {
      reps++
      i++
    }
    if (reps > maxReps) maxReps = reps
  }
  
  // Compute max prefix
  let maxPrefix = maxReps > 0 ? log2FloorNonZero(maxReps) : 0
  maxPrefix = Math.min(maxPrefix, maxRunLengthPrefix)
  
  // Encode
  const output = new Uint32Array(size)
  let outSize = 0
  
  for (let i = 0; i < size;) {
    if (input[i] !== 0) {
      // Non-zero: shift by max_prefix
      output[outSize++] = input[i] + maxPrefix
      i++
    } else {
      // Count zeros
      let reps = 1
      for (let k = i + 1; k < size && input[k] === 0; k++) {
        reps++
      }
      i += reps
      
      // Encode run length
      while (reps !== 0) {
        if (reps < (2 << maxPrefix)) {
          const runLengthPrefix = log2FloorNonZero(reps)
          const extraBits = reps - (1 << runLengthPrefix)
          // Pack prefix code and extra bits
          output[outSize++] = runLengthPrefix | (extraBits << 9)
          break
        } else {
          const extraBits = (1 << maxPrefix) - 1
          output[outSize++] = maxPrefix | (extraBits << 9)
          reps -= (2 << maxPrefix) - 1
        }
      }
    }
  }
  
  return { output, outSize, maxPrefix }
}

// Encode a context map to the bitstream
export function encodeContextMap(
  writer: BitWriter,
  contextMap: Uint32Array,
  contextMapSize: number,
  numClusters: number
): void {
  // Store number of clusters - 1
  storeVarLenUint8(writer, numClusters - 1)
  
  if (numClusters === 1) {
    return // Nothing more to encode
  }
  
  // Apply MTF transform
  const mtfTransformed = moveToFrontTransform(contextMap, contextMapSize)
  
  // Run-length encode zeros
  const { output: rleSymbols, outSize: numRleSymbols, maxPrefix: maxRunLengthPrefix } =
    runLengthCodeZeros(mtfTransformed, contextMapSize, 6)
  
  // Build histogram
  const symbolMask = (1 << 9) - 1
  const histogram = new Uint32Array(numClusters + maxRunLengthPrefix)
  for (let i = 0; i < numRleSymbols; i++) {
    histogram[rleSymbols[i] & symbolMask]++
  }
  
  // Write RLEMAX
  const useRle = maxRunLengthPrefix > 0
  writer.writeBits(1, useRle ? 1 : 0)
  if (useRle) {
    writer.writeBits(4, maxRunLengthPrefix - 1)
  }
  
  // Build and store Huffman tree for context map symbols
  const alphabetSize = numClusters + maxRunLengthPrefix
  const depths = new Uint8Array(alphabetSize)
  const bits = new Uint16Array(alphabetSize)
  
  buildAndStoreHuffmanTree(writer, histogram, alphabetSize, depths, bits)
  
  // Store RLE-encoded context map
  for (let i = 0; i < numRleSymbols; i++) {
    const rleSymbol = rleSymbols[i] & symbolMask
    const extraBitsVal = rleSymbols[i] >>> 9
    
    writer.writeBits(depths[rleSymbol], bits[rleSymbol])
    
    // Write extra bits for RLE symbols
    if (rleSymbol > 0 && rleSymbol <= maxRunLengthPrefix) {
      writer.writeBits(rleSymbol, extraBitsVal)
    }
  }
  
  // Write IMTF flag (use move-to-front inverse)
  writer.writeBits(1, 1)
}

// Store a trivial context map (histogram type = block type)
export function storeTrivialContextMap(
  writer: BitWriter,
  numTypes: number,
  contextBits: number
): void {
  storeVarLenUint8(writer, numTypes - 1)
  
  if (numTypes > 1) {
    const repeatCode = contextBits - 1
    const repeatBits = (1 << repeatCode) - 1
    const alphabetSize = numTypes + repeatCode
    
    // Build histogram
    const histogram = new Uint32Array(alphabetSize)
    histogram[repeatCode] = numTypes
    histogram[0] = 1
    for (let i = contextBits; i < alphabetSize; i++) {
      histogram[i] = 1
    }
    
    // Write RLEMAX
    writer.writeBits(1, 1)
    writer.writeBits(4, repeatCode - 1)
    
    // Build and store Huffman tree
    const depths = new Uint8Array(alphabetSize)
    const bits = new Uint16Array(alphabetSize)
    buildAndStoreHuffmanTree(writer, histogram, alphabetSize, depths, bits)
    
    // Store context map entries
    for (let i = 0; i < numTypes; i++) {
      const code = i === 0 ? 0 : i + contextBits - 1
      writer.writeBits(depths[code], bits[code])
      writer.writeBits(depths[repeatCode], bits[repeatCode])
      writer.writeBits(repeatCode, repeatBits)
    }
    
    // Write IMTF flag
    writer.writeBits(1, 1)
  }
}

export function buildAndStoreHuffmanTree(
  writer: BitWriter,
  histogram: Uint32Array,
  alphabetSize: number,
  depths: Uint8Array,
  bits: Uint16Array
): void {
  // Count non-zero symbols
  let count = 0
  const s4: number[] = [0, 0, 0, 0]
  
  for (let i = 0; i < alphabetSize; i++) {
    if (histogram[i]) {
      if (count < 4) {
        s4[count] = i
      }
      count++
    }
  }
  
  // Compute max bits needed for symbol
  let maxBits = 0
  let maxBitsCounter = alphabetSize - 1
  while (maxBitsCounter) {
    maxBitsCounter >>>= 1
    maxBits++
  }
  
  // Single symbol: just store it
  if (count <= 1) {
    writer.writeBits(4, 1) // Simple prefix code marker + NSYM=1
    writer.writeBits(maxBits, s4[0])
    depths[s4[0]] = 0
    bits[s4[0]] = 0
    return
  }
  
  // Build Huffman tree
  depths.fill(0)
  const tree = createHuffmanTree(histogram.subarray(0, alphabetSize), 15)
  depths.set(tree.depths.subarray(0, alphabetSize))
  convertBitDepthsToSymbols(depths, bits)
  
  // Store simple or complex tree
  if (count <= 4) {
    storeSimpleHuffmanTree(writer, depths, s4, count, maxBits)
  } else {
    storeComplexHuffmanTree(writer, depths, alphabetSize)
  }
}

function storeSimpleHuffmanTree(
  writer: BitWriter,
  depths: Uint8Array,
  symbols: number[],
  numSymbols: number,
  maxBits: number
): void {
  // Sort by depth
  const sorted = symbols.slice(0, numSymbols)
  sorted.sort((a, b) => depths[a] - depths[b])
  
  // Simple Huffman code marker (value 1 in 2 bits)
  writer.writeBits(2, 1)
  // NSYM - 1
  writer.writeBits(2, numSymbols - 1)
  
  // Write symbols
  for (let i = 0; i < numSymbols; i++) {
    writer.writeBits(maxBits, sorted[i])
  }
  
  // Tree-select for 4 symbols
  if (numSymbols === 4) {
    writer.writeBits(1, depths[sorted[0]] === 1 ? 1 : 0)
  }
}

function storeComplexHuffmanTree(
  writer: BitWriter,
  depths: Uint8Array,
  length: number
): void {
  // Build RLE representation of depths
  const huffmanTree: number[] = []
  const huffmanTreeExtraBits: number[] = []
  
  writeHuffmanTreeRepresentation(depths, length, huffmanTree, huffmanTreeExtraBits)
  
  // Build histogram of code length codes
  const codeLengthHistogram = new Uint32Array(18) // 0-15 + 16 (repeat) + 17 (zeros)
  for (const code of huffmanTree) {
    codeLengthHistogram[code]++
  }
  
  // Count non-zero code lengths
  let numCodes = 0
  let firstCode = 0
  for (let i = 0; i < 18; i++) {
    if (codeLengthHistogram[i]) {
      if (numCodes === 0) firstCode = i
      numCodes++
    }
  }
  
  // Build Huffman tree for code lengths
  const codeLengthDepths = new Uint8Array(18)
  const codeLengthBits = new Uint16Array(18)
  
  const tree = createHuffmanTree(codeLengthHistogram, 5)
  codeLengthDepths.set(tree.depths.subarray(0, 18))
  convertBitDepthsToSymbols(codeLengthDepths, codeLengthBits)
  
  // Store the code length Huffman tree
  storeHuffmanTreeOfHuffmanTree(writer, numCodes, codeLengthDepths)
  
  if (numCodes === 1) {
    codeLengthDepths[firstCode] = 0
  }
  
  // Store the actual Huffman tree
  for (let i = 0; i < huffmanTree.length; i++) {
    const code = huffmanTree[i]
    writer.writeBits(codeLengthDepths[code], codeLengthBits[code])
    
    // Extra bits
    if (code === 16) {
      writer.writeBits(2, huffmanTreeExtraBits[i])
    } else if (code === 17) {
      writer.writeBits(3, huffmanTreeExtraBits[i])
    }
  }
}

// Write Huffman tree representation using RLE
function writeHuffmanTreeRepresentation(
  depths: Uint8Array,
  length: number,
  tree: number[],
  extraBits: number[]
): void {
  const INITIAL_PREV = 8
  
  // Trim trailing zeros
  let newLength = length
  while (newLength > 0 && depths[newLength - 1] === 0) {
    newLength--
  }
  
  let prevValue = INITIAL_PREV
  let i = 0
  
  while (i < newLength) {
    const value = depths[i]
    let reps = 1
    
    // Count repetitions
    while (i + reps < newLength && depths[i + reps] === value) {
      reps++
    }
    i += reps
    
    if (value === 0) {
      // Encode zero runs using code 17
      writeHuffmanTreeRepetitionsZeros(reps, tree, extraBits)
    } else {
      // Encode non-zero values using code 16 for repeats
      writeHuffmanTreeRepetitions(prevValue, value, reps, tree, extraBits)
      prevValue = value
    }
  }
}

function writeHuffmanTreeRepetitions(
  prevValue: number,
  value: number,
  reps: number,
  tree: number[],
  extraBits: number[]
): void {
  const REPEAT_PREVIOUS = 16
  
  // First occurrence if value changed
  if (prevValue !== value) {
    tree.push(value)
    extraBits.push(0)
    reps--
  }
  
  // Handle reps == 7 specially (can't encode as single repeat code)
  if (reps === 7) {
    tree.push(value)
    extraBits.push(0)
    reps--
  }
  
  if (reps < 3) {
    // Emit individual symbols
    for (let j = 0; j < reps; j++) {
      tree.push(value)
      extraBits.push(0)
    }
  } else {
    // Use repeat code(s)
    const startIdx = tree.length
    reps -= 3
    
    while (true) {
      tree.push(REPEAT_PREVIOUS)
      extraBits.push(reps & 0x3) // 2 extra bits (0-3)
      reps >>>= 2
      if (reps === 0) break
      reps--
    }
    
    // Reverse the repeat codes (and their extra bits)
    reverseArraySlice(tree, startIdx, tree.length)
    reverseArraySlice(extraBits, startIdx, extraBits.length)
  }
}

function writeHuffmanTreeRepetitionsZeros(
  reps: number,
  tree: number[],
  extraBits: number[]
): void {
  const REPEAT_ZERO = 17
  
  // Handle reps == 11 specially
  if (reps === 11) {
    tree.push(0)
    extraBits.push(0)
    reps--
  }
  
  if (reps < 3) {
    // Emit individual zeros
    for (let j = 0; j < reps; j++) {
      tree.push(0)
      extraBits.push(0)
    }
  } else {
    // Use repeat zero code(s)
    const startIdx = tree.length
    reps -= 3
    
    while (true) {
      tree.push(REPEAT_ZERO)
      extraBits.push(reps & 0x7) // 3 extra bits (0-7)
      reps >>>= 3
      if (reps === 0) break
      reps--
    }
    
    // Reverse the repeat codes (and their extra bits)
    reverseArraySlice(tree, startIdx, tree.length)
    reverseArraySlice(extraBits, startIdx, extraBits.length)
  }
}

function reverseArraySlice(arr: number[], start: number, end: number): void {
  while (start < end - 1) {
    const tmp = arr[start]
    arr[start] = arr[end - 1]
    arr[end - 1] = tmp
    start++
    end--
  }
}

function storeHuffmanTreeOfHuffmanTree(
  writer: BitWriter,
  numCodes: number,
  depths: Uint8Array
): void {
  // Storage order for code length codes
  const storageOrder = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15]
  
  // Static Huffman code for code lengths
  const symbols = [0, 7, 3, 2, 1, 15]
  const bitLengths = [2, 4, 3, 2, 2, 4]
  
  // Find how many codes to store
  let codesToStore = 18
  if (numCodes > 1) {
    while (codesToStore > 0 && depths[storageOrder[codesToStore - 1]] === 0) {
      codesToStore--
    }
  }
  
  // Determine skip amount
  let skipSome = 0
  if (depths[storageOrder[0]] === 0 && depths[storageOrder[1]] === 0) {
    skipSome = 2
    if (depths[storageOrder[2]] === 0) {
      skipSome = 3
    }
  }
  
  writer.writeBits(2, skipSome)
  
  for (let i = skipSome; i < codesToStore; i++) {
    const len = depths[storageOrder[i]]
    writer.writeBits(bitLengths[len], symbols[len])
  }
}

// Variable-Length Integer

export function storeVarLenUint8(writer: BitWriter, n: number): void {
  if (n === 0) {
    writer.writeBits(1, 0)
  } else {
    const nbits = log2FloorNonZero(n)
    writer.writeBits(1, 1)
    writer.writeBits(3, nbits)
    writer.writeBits(nbits, n - (1 << nbits))
  }
}
