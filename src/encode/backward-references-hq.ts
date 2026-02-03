// High-quality backward references using Zopfli algorithm
// Reference: woff2/brotli/c/enc/backward_references_hq.c

import { BackwardMatch, findMatchLength } from './match'
import { 
  Command, 
  createCommand, 
  getInsertLengthCode,
  getCopyLengthCode,
  combineLengthCodes,
  getInsertExtra,
  getCopyExtra,
} from './command'
import { BinaryTreeHasher } from './hash-binary-tree'
import { ZopfliCostModel, INFINITY_COST } from './zopfli-cost-model'
import { NUM_DISTANCE_SHORT_CODES, maxZopfliLen, maxZopfliCandidates } from './enc-constants'
import { backwardMatchLength } from './backward-references'
import { log2FloorNonZero } from './fast-log'

const DISTANCE_CACHE_INDEX = new Uint8Array([
  0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1
])

const DISTANCE_CACHE_OFFSET = new Int8Array([
  0, 0, 0, 0, -1, 1, -2, 2, -3, 3, -1, 1, -2, 2, -3, 3
])

const LONG_COPY_QUICK_STEP = 16384

// Node in the Zopfli DP graph: optimal way to reach a position
export interface ZopfliNode {
  length: number           // copy length (low 25 bits) + length modifier (high 7 bits)
  distance: number         // backward distance
  dcodeInsertLength: number // insert length (low 27) + distance short code + 1 (high 5)
  cost: number             // cost to reach this position, or next pointer during backtrack
  shortcut: number         // for distance cache reconstruction
}

export function createZopfliNodes(length: number): ZopfliNode[] {
  const nodes: ZopfliNode[] = new Array(length)
  for (let i = 0; i < length; i++) {
    nodes[i] = {
      length: 1,
      distance: 0,
      dcodeInsertLength: 0,
      cost: INFINITY_COST,
      shortcut: 0,
    }
  }
  return nodes
}

// Zopfli node accessors
function zopfliNodeCopyLength(node: ZopfliNode): number {
  return node.length & 0x1FFFFFF
}

function zopfliNodeLengthCode(node: ZopfliNode): number {
  const modifier = node.length >>> 25
  return zopfliNodeCopyLength(node) + 9 - modifier
}

function zopfliNodeCopyDistance(node: ZopfliNode): number {
  return node.distance
}

function zopfliNodeDistanceCode(node: ZopfliNode): number {
  const shortCode = node.dcodeInsertLength >>> 27
  return shortCode === 0
    ? zopfliNodeCopyDistance(node) + NUM_DISTANCE_SHORT_CODES - 1
    : shortCode - 1
}

function zopfliNodeCommandLength(node: ZopfliNode): number {
  return zopfliNodeCopyLength(node) + (node.dcodeInsertLength & 0x7FFFFFF)
}

function zopfliNodeInsertLength(node: ZopfliNode): number {
  return node.dcodeInsertLength & 0x7FFFFFF
}

interface PosData {
  pos: number
  distanceCache: Int32Array
  costdiff: number
  cost: number
}

class StartPosQueue {
  private q: PosData[] = []
  private idx = 0

  push(posdata: PosData): void {
    const offset = (~this.idx++) & 7
    
    // Ensure array has space
    while (this.q.length < 8) {
      this.q.push({
        pos: 0,
        distanceCache: new Int32Array(4),
        costdiff: INFINITY_COST,
        cost: INFINITY_COST,
      })
    }
    
    // Insert at offset
    this.q[offset] = {
      pos: posdata.pos,
      distanceCache: posdata.distanceCache.slice(),
      costdiff: posdata.costdiff,
      cost: posdata.cost,
    }
    
    // Restore sorted order
    const len = this.size()
    for (let i = 1; i < len; i++) {
      const a = (offset + i - 1) & 7
      const b = (offset + i) & 7
      if (this.q[a].costdiff > this.q[b].costdiff) {
        const tmp = this.q[a]
        this.q[a] = this.q[b]
        this.q[b] = tmp
      }
    }
  }

  size(): number {
    return Math.min(this.idx, 8)
  }

  at(k: number): PosData {
    return this.q[(k - this.idx) & 7]
  }

  reset(): void {
    this.idx = 0
  }
}

function updateZopfliNode(
  nodes: ZopfliNode[],
  pos: number,
  startPos: number,
  len: number,
  lenCode: number,
  dist: number,
  shortCode: number,
  cost: number
): void {
  const next = nodes[pos + len]
  next.length = len | ((len + 9 - lenCode) << 25)
  next.distance = dist
  next.dcodeInsertLength = (shortCode << 27) | (pos - startPos)
  next.cost = cost
}

function computeMinimumCopyLength(
  startCost: number,
  nodes: ZopfliNode[],
  numBytes: number,
  pos: number
): number {
  let minCost = startCost
  let len = 2
  let nextLenBucket = 4
  let nextLenOffset = 10
  
  while (pos + len <= numBytes && nodes[pos + len].cost <= minCost) {
    len++
    if (len === nextLenOffset) {
      // Reached next copy length code bucket
      minCost += 1.0
      nextLenOffset += nextLenBucket
      nextLenBucket *= 2
    }
  }
  
  return len
}

function computeDistanceShortcut(
  blockStart: number,
  pos: number,
  maxBackwardLimit: number,
  gap: number,
  nodes: ZopfliNode[]
): number {
  if (pos === 0) return 0
  
  const cLen = zopfliNodeCopyLength(nodes[pos])
  const iLen = zopfliNodeInsertLength(nodes[pos])
  const dist = zopfliNodeCopyDistance(nodes[pos])
  
  if (dist + cLen <= blockStart + pos + gap &&
      dist <= maxBackwardLimit + gap &&
      zopfliNodeDistanceCode(nodes[pos]) > 0) {
    return pos
  } else {
    return nodes[pos - cLen - iLen].shortcut
  }
}

function computeDistanceCache(
  pos: number,
  startingDistCache: Int32Array,
  nodes: ZopfliNode[],
  distCache: Int32Array
): void {
  let idx = 0
  let p = nodes[pos].shortcut
  
  while (idx < 4 && p > 0) {
    const iLen = zopfliNodeInsertLength(nodes[p])
    const cLen = zopfliNodeCopyLength(nodes[p])
    const dist = zopfliNodeCopyDistance(nodes[p])
    distCache[idx++] = dist
    p = nodes[p - cLen - iLen].shortcut
  }
  
  for (; idx < 4; idx++) {
    distCache[idx] = startingDistCache[idx - (4 - idx)]
  }
}

function evaluateNode(
  blockStart: number,
  pos: number,
  maxBackwardLimit: number,
  gap: number,
  startingDistCache: Int32Array,
  model: ZopfliCostModel,
  queue: StartPosQueue,
  nodes: ZopfliNode[]
): void {
  const nodeCost = nodes[pos].cost
  nodes[pos].shortcut = computeDistanceShortcut(
    blockStart, pos, maxBackwardLimit, gap, nodes
  )
  
  if (nodeCost <= model.getLiteralCosts(0, pos)) {
    const distanceCache = new Int32Array(4)
    computeDistanceCache(pos, startingDistCache, nodes, distanceCache)
    
    queue.push({
      pos,
      cost: nodeCost,
      costdiff: nodeCost - model.getLiteralCosts(0, pos),
      distanceCache,
    })
  }
}

// Core of the Zopfli DP algorithm
function updateNodes(
  numBytes: number,
  blockStart: number,
  pos: number,
  ringbuffer: Uint8Array,
  ringbufferMask: number,
  quality: number,
  maxBackwardLimit: number,
  startingDistCache: Int32Array,
  numMatches: number,
  matches: BackwardMatch[],
  model: ZopfliCostModel,
  queue: StartPosQueue,
  nodes: ZopfliNode[]
): number {
  const curIx = blockStart + pos
  const curIxMasked = curIx & ringbufferMask
  const maxDistance = Math.min(curIx, maxBackwardLimit)
  const maxLen = numBytes - pos
  const maxZopfliLenVal = maxZopfliLen(quality)
  const maxIters = maxZopfliCandidates(quality)
  
  // Evaluate current position
  evaluateNode(blockStart, pos, maxBackwardLimit, 0, startingDistCache, model, queue, nodes)
  
  // Compute minimum useful copy length
  const posdata0 = queue.at(0)
  const minCost = posdata0.cost + model.getMinCostCmd() + 
                  model.getLiteralCosts(posdata0.pos, pos)
  let minLen = computeMinimumCopyLength(minCost, nodes, numBytes, pos)
  
  let result = 0
  
  // Try each starting position in the queue
  for (let k = 0; k < maxIters && k < queue.size(); k++) {
    const posdata = queue.at(k)
    const start = posdata.pos
    const insCode = getInsertLengthCode(pos - start)
    const startCostdiff = posdata.costdiff
    const baseCost = startCostdiff + getInsertExtra(insCode) +
                     model.getLiteralCosts(0, pos)
    
    // Try distance cache matches
    let bestLen = minLen - 1
    for (let j = 0; j < NUM_DISTANCE_SHORT_CODES && bestLen < maxLen; j++) {
      const idx = DISTANCE_CACHE_INDEX[j]
      const backward = posdata.distanceCache[idx] + DISTANCE_CACHE_OFFSET[j]
      
      if (backward <= 0 || backward > maxDistance) continue
      
      let prevIx = curIx - backward
      prevIx &= ringbufferMask
      
      // Check if continuation byte matches
      if (curIxMasked + bestLen > ringbufferMask) break
      if (ringbuffer[prevIx + bestLen] !== ringbuffer[curIxMasked + bestLen]) continue
      
      const len = findMatchLength(ringbuffer, prevIx, curIxMasked, maxLen)
      
      if (len >= 4) {
        const distCost = baseCost + model.getDistanceCost(j)
        
        for (let l = bestLen + 1; l <= len; l++) {
          const copyCode = getCopyLengthCode(l)
          const cmdCode = combineLengthCodes(insCode, copyCode, j === 0)
          const cost = (cmdCode < 128 ? baseCost : distCost) +
                       getCopyExtra(copyCode) +
                       model.getCommandCost(cmdCode)
          
          if (cost < nodes[pos + l].cost) {
            updateZopfliNode(nodes, pos, start, l, l, backward, j + 1, cost)
            result = Math.max(result, l)
          }
          bestLen = l
        }
      }
    }
    
    // At higher iterations, only look for cache matches
    if (k >= 2) continue
    
    // Try all matches from the hasher
    let matchLen = minLen
    for (let j = 0; j < numMatches; j++) {
      const match = matches[j]
      const dist = match.distance
      const isDictionaryMatch = dist > maxDistance
      
      // Encode distance
      const distCode = dist + NUM_DISTANCE_SHORT_CODES - 1
      const nbits = distCode < NUM_DISTANCE_SHORT_CODES ? 0 :
                    log2FloorNonZero(dist) - 1
      const distCost = baseCost + nbits + model.getDistanceCost(distCode & 0x3FF)
      
      // Try copy lengths up to match length
      let maxMatchLen = backwardMatchLength(match)
      if (matchLen < maxMatchLen && (isDictionaryMatch || maxMatchLen > maxZopfliLenVal)) {
        matchLen = maxMatchLen
      }
      
      for (; matchLen <= maxMatchLen; matchLen++) {
        const lenCode = isDictionaryMatch ? match.length + match.lenCodeDelta : matchLen
        const copyCode = getCopyLengthCode(lenCode)
        const cmdCode = combineLengthCodes(insCode, copyCode, false)
        const cost = distCost + getCopyExtra(copyCode) + model.getCommandCost(cmdCode)
        
        if (cost < nodes[pos + matchLen].cost) {
          updateZopfliNode(nodes, pos, start, matchLen, lenCode, dist, 0, cost)
          result = Math.max(result, matchLen)
        }
      }
    }
  }
  
  return result
}

function computeShortestPathFromNodes(numBytes: number, nodes: ZopfliNode[]): number {
  let index = numBytes
  let numCommands = 0
  
  // Find end of data (skip trailing unprocessed positions)
  while ((nodes[index].dcodeInsertLength & 0x7FFFFFF) === 0 &&
         nodes[index].length === 1) {
    index--
  }
  
  // Mark end
  nodes[index].cost = 0xFFFFFFFF // next = MAX
  
  // Trace back and set next pointers
  while (index !== 0) {
    const len = zopfliNodeCommandLength(nodes[index])
    index -= len
    nodes[index].cost = len // next = len
    numCommands++
  }
  
  return numCommands
}

// Public API

// Zopfli algorithm for quality 10-11
export function createZopfliBackwardReferences(
  numBytes: number,
  position: number,
  ringbuffer: Uint8Array,
  ringbufferMask: number,
  quality: number,
  hasher: BinaryTreeHasher,
  distCache: Int32Array,
  lastInsertLen: number
): [Command[], number, number] {
  const maxBackwardLimit = (1 << 22) - 16 // lgwin=22 default
  const maxZopfliLenVal = maxZopfliLen(quality)
  
  // Allocate nodes
  const nodes = createZopfliNodes(numBytes + 1)
  nodes[0].length = 0
  nodes[0].cost = 0
  
  // Initialize cost model from literals (first pass)
  const distAlphabetSize = 544 // MAX_EFFECTIVE_DISTANCE_ALPHABET_SIZE
  const model = new ZopfliCostModel(numBytes, distAlphabetSize)
  model.setFromLiteralCosts(position, ringbuffer, ringbufferMask)
  
  // Initialize queue
  const queue = new StartPosQueue()
  
  // Main DP loop
  for (let i = 0; i + 3 < numBytes; i++) {
    const pos = position + i
    const maxDistance = Math.min(pos, maxBackwardLimit)
    
    // Find all matches at this position
    const matches = hasher.findAllMatches(
      ringbuffer,
      ringbufferMask,
      pos,
      numBytes - i,
      maxDistance
    )
    
    // Handle very long matches
    if (matches.length > 0) {
      const longestMatch = matches[matches.length - 1]
      if (backwardMatchLength(longestMatch) > maxZopfliLenVal) {
        matches.length = 0
        matches.push(longestMatch)
      }
    }
    
    // Update DP nodes
    const skip = updateNodes(
      numBytes, position, i, ringbuffer, ringbufferMask,
      quality, maxBackwardLimit, distCache,
      matches.length, matches, model, queue, nodes
    )
    
    // Skip ahead for very long matches
    if (skip >= LONG_COPY_QUICK_STEP) {
      i += skip - 1
    } else if (matches.length === 1 && backwardMatchLength(matches[0]) > maxZopfliLenVal) {
      i += backwardMatchLength(matches[0]) - 1
    }
  }
  
  // Compute shortest path
  computeShortestPathFromNodes(numBytes, nodes)
  
  // Create commands from path
  return createCommandsFromPath(numBytes, position, nodes, distCache, lastInsertLen)
}

// Two-pass optimization for quality 11
export function createHqZopfliBackwardReferences(
  numBytes: number,
  position: number,
  ringbuffer: Uint8Array,
  ringbufferMask: number,
  hasher: BinaryTreeHasher,
  distCache: Int32Array,
  lastInsertLen: number
): [Command[], number, number] {
  const quality = 11
  const maxBackwardLimit = (1 << 22) - 16
  const maxZopfliLenVal = maxZopfliLen(quality)
  
  // First pass: collect all matches
  const allMatches: BackwardMatch[][] = []
  const numMatchesPerPos: number[] = []
  
  for (let i = 0; i + 3 < numBytes; i++) {
    const pos = position + i
    const maxDistance = Math.min(pos, maxBackwardLimit)
    
    const matches = hasher.findAllMatches(
      ringbuffer,
      ringbufferMask,
      pos,
      numBytes - i,
      maxDistance
    )
    
    // Handle very long matches
    if (matches.length > 0) {
      const longestMatch = matches[matches.length - 1]
      if (backwardMatchLength(longestMatch) > maxZopfliLenVal) {
        const skip = backwardMatchLength(longestMatch) - 1
        allMatches.push([longestMatch])
        numMatchesPerPos.push(1)
        
        // Skip positions
        for (let j = 0; j < skip && i + j + 1 < numBytes; j++) {
          allMatches.push([])
          numMatchesPerPos.push(0)
        }
        i += skip
        continue
      }
    }
    
    allMatches.push(matches)
    numMatchesPerPos.push(matches.length)
  }
  
  // Pad to full length
  while (allMatches.length < numBytes) {
    allMatches.push([])
    numMatchesPerPos.push(0)
  }
  
  // Save original state for second pass
  const origDistCache = distCache.slice()
  const origLastInsertLen = lastInsertLen
  
  // Allocate structures
  const distAlphabetSize = 544
  const model = new ZopfliCostModel(numBytes, distAlphabetSize)
  
  let commands: Command[] = []
  let numLiterals = 0
  let finalLastInsertLen = lastInsertLen
  
  // Two iterations: first with literal costs, then with actual command costs
  for (let iteration = 0; iteration < 2; iteration++) {
    const nodes = createZopfliNodes(numBytes + 1)
    nodes[0].length = 0
    nodes[0].cost = 0
    
    // Reset state
    distCache.set(origDistCache)
    lastInsertLen = origLastInsertLen
    
    // Set cost model
    if (iteration === 0) {
      model.setFromLiteralCosts(position, ringbuffer, ringbufferMask)
    } else {
      model.setFromCommands(position, ringbuffer, ringbufferMask, commands, origLastInsertLen)
    }
    
    // Initialize queue
    const queue = new StartPosQueue()
    
    // DP loop using pre-collected matches
    for (let i = 0; i + 3 < numBytes; i++) {
      const numMatches = numMatchesPerPos[i]
      const matches = allMatches[i]
      
      const skip = updateNodes(
        numBytes, position, i, ringbuffer, ringbufferMask,
        quality, maxBackwardLimit, distCache,
        numMatches, matches, model, queue, nodes
      )
      
      if (skip >= LONG_COPY_QUICK_STEP) {
        i += skip - 1
      } else if (numMatches === 1 && backwardMatchLength(matches[0]) > maxZopfliLenVal) {
        i += backwardMatchLength(matches[0]) - 1
      }
    }
    
    // Compute path and create commands
    computeShortestPathFromNodes(numBytes, nodes)
    ;[commands, numLiterals, finalLastInsertLen] = createCommandsFromPath(
      numBytes, position, nodes, distCache, lastInsertLen
    )
  }
  
  return [commands, numLiterals, finalLastInsertLen]
}

function createCommandsFromPath(
  numBytes: number,
  blockStart: number,
  nodes: ZopfliNode[],
  distCache: Int32Array,
  lastInsertLen: number
): [Command[], number, number] {
  const maxBackwardLimit = (1 << 22) - 16
  const commands: Command[] = []
  let numLiterals = 0
  let pos = 0
  let offset = nodes[0].cost // next pointer
  let isFirst = true
  
  while (offset !== 0xFFFFFFFF && offset !== 0) {
    const next = nodes[pos + offset]
    const copyLen = zopfliNodeCopyLength(next)
    let insertLen = zopfliNodeInsertLength(next)
    
    pos += insertLen
    
    if (isFirst) {
      insertLen += lastInsertLen
      isFirst = false
    }
    
    const distance = zopfliNodeCopyDistance(next)
    const lenCode = zopfliNodeLengthCode(next)
    const distCode = zopfliNodeDistanceCode(next)
    
    // Create command
    const cmd = createCommand(
      insertLen,
      copyLen,
      lenCode - copyLen,
      distCode
    )
    commands.push(cmd)
    
    // Update distance cache for non-dictionary matches
    const dictionaryStart = Math.min(blockStart + pos, maxBackwardLimit)
    const isDictionary = distance > dictionaryStart
    
    if (!isDictionary && distCode > 0) {
      distCache[3] = distCache[2]
      distCache[2] = distCache[1]
      distCache[1] = distCache[0]
      distCache[0] = distance
    }
    
    numLiterals += insertLen
    pos += copyLen
    offset = next.cost // next pointer
  }
  
  // Remaining literals
  const finalInsertLen = numBytes - pos
  
  return [commands, numLiterals, finalInsertLen]
}
