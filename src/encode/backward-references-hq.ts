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
  distancePrefixSymbol,
} from './command'
import { BinaryTreeHasher, WINDOW_GAP, MAX_TREE_COMP_LENGTH } from './hash-binary-tree'
import { ZopfliCostModel, INFINITY_COST } from './zopfli-cost-model'
import { NUM_DISTANCE_SHORT_CODES, maxZopfliLen, maxZopfliCandidates } from './enc-constants'
import { backwardMatchLength } from './backward-references'

const DISTANCE_CACHE_OFFSET = new Int8Array([
  0, 0, 0, 0, -1, 1, -2, 2, -3, 3, -1, 1, -2, 2, -3, 3
])

const LONG_COPY_QUICK_STEP = 16384

// Zopfli DP nodes, one per input position: the cheapest known way to reach it.
// Held as parallel typed arrays because the inner loop touches one field of
// many nodes, and per-node objects cost a pointer chase each
export interface ZopfliNodes {
  size: number
  length: Uint32Array            // copy length (low 25 bits) + length modifier (high 7 bits)
  distance: Uint32Array          // backward distance
  dcodeInsertLength: Uint32Array // insert length (low 27) + distance short code + 1 (high 5)
  cost: Float64Array             // cost to reach this position, or next pointer during backtrack
  shortcut: Uint32Array          // for distance cache reconstruction
}

export function createZopfliNodes(size: number): ZopfliNodes {
  const nodes: ZopfliNodes = {
    size,
    length: new Uint32Array(size),
    distance: new Uint32Array(size),
    dcodeInsertLength: new Uint32Array(size),
    cost: new Float64Array(size),
    shortcut: new Uint32Array(size),
  }
  resetZopfliNodes(nodes)
  return nodes
}

function resetZopfliNodes(nodes: ZopfliNodes): void {
  nodes.length.fill(1)
  nodes.distance.fill(0)
  nodes.dcodeInsertLength.fill(0)
  nodes.cost.fill(INFINITY_COST)
  nodes.shortcut.fill(0)
}

function zopfliNodeCopyLength(nodes: ZopfliNodes, i: number): number {
  return nodes.length[i] & 0x1FFFFFF
}

function zopfliNodeLengthCode(nodes: ZopfliNodes, i: number): number {
  const modifier = nodes.length[i] >>> 25
  return zopfliNodeCopyLength(nodes, i) + 9 - modifier
}

function zopfliNodeCopyDistance(nodes: ZopfliNodes, i: number): number {
  return nodes.distance[i]
}

function zopfliNodeDistanceCode(nodes: ZopfliNodes, i: number): number {
  const shortCode = nodes.dcodeInsertLength[i] >>> 27
  return shortCode === 0
    ? zopfliNodeCopyDistance(nodes, i) + NUM_DISTANCE_SHORT_CODES - 1
    : shortCode - 1
}

function zopfliNodeCommandLength(nodes: ZopfliNodes, i: number): number {
  return zopfliNodeCopyLength(nodes, i) + (nodes.dcodeInsertLength[i] & 0x7FFFFFF)
}

function zopfliNodeInsertLength(nodes: ZopfliNodes, i: number): number {
  return nodes.dcodeInsertLength[i] & 0x7FFFFFF
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

  // Called once per input position, so the eight slots are reused in place
  push(pos: number, cost: number, costdiff: number, distanceCache: Int32Array): void {
    const offset = (~this.idx++) & 7

    while (this.q.length < 8) {
      this.q.push({
        pos: 0,
        distanceCache: new Int32Array(4),
        costdiff: INFINITY_COST,
        cost: INFINITY_COST,
      })
    }

    const slot = this.q[offset]
    slot.pos = pos
    slot.cost = cost
    slot.costdiff = costdiff
    slot.distanceCache.set(distanceCache)

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
  nodes: ZopfliNodes,
  pos: number,
  startPos: number,
  len: number,
  lenCode: number,
  dist: number,
  shortCode: number,
  cost: number
): void {
  const next = pos + len
  nodes.length[next] = len | ((len + 9 - lenCode) << 25)
  nodes.distance[next] = dist
  nodes.dcodeInsertLength[next] = (shortCode << 27) | (pos - startPos)
  nodes.cost[next] = cost
}

function computeMinimumCopyLength(
  startCost: number,
  nodes: ZopfliNodes,
  numBytes: number,
  pos: number
): number {
  let minCost = startCost
  let len = 2
  let nextLenBucket = 4
  let nextLenOffset = 10
  
  while (pos + len <= numBytes && nodes.cost[pos + len] <= minCost) {
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
  nodes: ZopfliNodes
): number {
  if (pos === 0) return 0
  
  const cLen = zopfliNodeCopyLength(nodes, pos)
  const iLen = zopfliNodeInsertLength(nodes, pos)
  const dist = zopfliNodeCopyDistance(nodes, pos)
  
  if (dist + cLen <= blockStart + pos + gap &&
      dist <= maxBackwardLimit + gap &&
      zopfliNodeDistanceCode(nodes, pos) > 0) {
    return pos
  } else {
    return nodes.shortcut[pos - cLen - iLen]
  }
}

function computeDistanceCache(
  pos: number,
  startingDistCache: Int32Array,
  nodes: ZopfliNodes,
  distCache: Int32Array
): void {
  let idx = 0
  let p = nodes.shortcut[pos]
  
  while (idx < 4 && p > 0) {
    const iLen = zopfliNodeInsertLength(nodes, p)
    const cLen = zopfliNodeCopyLength(nodes, p)
    const dist = zopfliNodeCopyDistance(nodes, p)
    distCache[idx++] = dist
    p = nodes.shortcut[p - cLen - iLen]
  }
  
  // Remaining slots come from the start of startingDistCache, in order
  for (let k = 0; idx < 4; idx++, k++) {
    distCache[idx] = startingDistCache[k]
  }
}

// Reusable scratch buffer for evaluateNode
const _evalDistCache = new Int32Array(4)

function evaluateNode(
  blockStart: number,
  pos: number,
  maxBackwardLimit: number,
  gap: number,
  startingDistCache: Int32Array,
  model: ZopfliCostModel,
  queue: StartPosQueue,
  nodes: ZopfliNodes
): void {
  const nodeCost = nodes.cost[pos]
  nodes.shortcut[pos] = computeDistanceShortcut(
    blockStart, pos, maxBackwardLimit, gap, nodes
  )
  
  if (nodeCost <= model.getLiteralCosts(0, pos)) {
    computeDistanceCache(pos, startingDistCache, nodes, _evalDistCache)
    
    queue.push(pos, nodeCost, nodeCost - model.getLiteralCosts(0, pos), _evalDistCache)
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
  nodes: ZopfliNodes,
  npostfix: number,
  ndirect: number
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
    const cache = posdata.distanceCache
    const cache0 = cache[0]
    const cache1 = cache[1]
    for (let j = 0; j < NUM_DISTANCE_SHORT_CODES && bestLen < maxLen; j++) {
      // Codes 4-9 are offsets from the last distance, 10-15 from the one before
      const backward = j < 4
        ? cache[j]
        : (j < 10 ? cache0 : cache1) + DISTANCE_CACHE_OFFSET[j]

      if (backward <= 0 || backward > maxDistance) continue

      const prevIx = (curIx - backward) & ringbufferMask

      // Check if continuation byte matches
      if (curIxMasked + bestLen > ringbufferMask) break
      if (ringbuffer[prevIx + bestLen] !== ringbuffer[curIxMasked + bestLen]) continue

      const len = findMatchLength(ringbuffer, prevIx, curIxMasked, maxLen)
      
      // No minimum here: a 2 or 3 byte copy at a recent distance is cheap
      // enough to be worth taking, and minLen already bounds it from below
      {
        const distCost = baseCost + model.getDistanceCost(j)
        
        for (let l = bestLen + 1; l <= len; l++) {
          const copyCode = getCopyLengthCode(l)
          const cmdCode = combineLengthCodes(insCode, copyCode, j === 0)
          const cost = (cmdCode < 128 ? baseCost : distCost) +
                       getCopyExtra(copyCode) +
                       model.getCommandCost(cmdCode)
          
          if (cost < nodes.cost[pos + l]) {
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
      
      // The cost table is indexed by distance symbol, not raw distance. A raw
      // distance reads past the table and yields NaN, which loses the match
      // silently since every comparison against NaN is false
      const distCode = dist + NUM_DISTANCE_SHORT_CODES - 1
      const distSymbol = distancePrefixSymbol(distCode, ndirect, npostfix)
      const distNumExtra = distSymbol >> 10
      const distCost = baseCost + distNumExtra + model.getDistanceCost(distSymbol & 0x3FF)
      
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
        
        if (cost < nodes.cost[pos + matchLen]) {
          updateZopfliNode(nodes, pos, start, matchLen, lenCode, dist, 0, cost)
          result = Math.max(result, matchLen)
        }
      }
    }
  }
  
  return result
}

function computeShortestPathFromNodes(numBytes: number, nodes: ZopfliNodes): number {
  let index = numBytes
  let numCommands = 0
  
  // Find end of data (skip trailing unprocessed positions)
  while ((nodes.dcodeInsertLength[index] & 0x7FFFFFF) === 0 &&
         nodes.length[index] === 1) {
    index--
  }
  
  // Mark end
  nodes.cost[index] = 0xFFFFFFFF // next = MAX
  
  // Trace back and set next pointers
  while (index !== 0) {
    const len = zopfliNodeCommandLength(nodes, index)
    index -= len
    nodes.cost[index] = len // next = len
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
  lastInsertLen: number,
  npostfix: number = 0,
  ndirect: number = 0,
  maxBackwardLimit: number = ringbufferMask - WINDOW_GAP + 1
): [Command[], number, number] {
  const maxZopfliLenVal = maxZopfliLen(quality)
  
  // Allocate nodes
  const nodes = createZopfliNodes(numBytes + 1)
  nodes.length[0] = 0
  nodes.cost[0] = 0
  
  // Initialize cost model from literals (first pass)
  // Must be the real alphabet size: unseen symbols are priced from it
  const distAlphabetSize = NUM_DISTANCE_SHORT_CODES + ndirect + (48 << npostfix)
  const model = new ZopfliCostModel(numBytes, distAlphabetSize)
  model.setFromLiteralCosts(position, ringbuffer, ringbufferMask)
  
  // Initialize queue
  const queue = new StartPosQueue()
  
  // The tree hasher reads MAX_TREE_COMP_LENGTH bytes ahead of what it stores
  const storeEnd = numBytes >= MAX_TREE_COMP_LENGTH
    ? position + numBytes - MAX_TREE_COMP_LENGTH + 1
    : position

  // Main DP loop
  for (let i = 0; i + 3 < numBytes; i++) {
    const pos = position + i
    const maxDistance = Math.min(pos, maxBackwardLimit)
    
    // Find all matches at this position
    // Without a stream offset or compound dictionary the dictionary base
    // distance is just maxDistance
    const matches = hasher.findAllMatches(
      ringbuffer,
      ringbufferMask,
      pos,
      numBytes - i,
      maxDistance,
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
    let skip = updateNodes(
      numBytes, position, i, ringbuffer, ringbufferMask,
      quality, maxBackwardLimit, distCache,
      matches.length, matches, model, queue, nodes,
      npostfix, ndirect
    )

    if (skip < LONG_COPY_QUICK_STEP) skip = 0
    if (matches.length === 1 && backwardMatchLength(matches[0]) > maxZopfliLenVal) {
      skip = Math.max(backwardMatchLength(matches[0]), skip)
    }
    if (skip > 1) {
      hasher.storeRange(ringbuffer, ringbufferMask, pos + 1, Math.min(pos + skip, storeEnd))
      // Skipped positions find no matches of their own, but each still has to
      // be evaluated: that is what links it into the distance history that
      // later positions are costed against
      skip--
      while (skip !== 0) {
        i++
        if (i + 3 >= numBytes) break
        evaluateNode(position, i, maxBackwardLimit, 0, distCache, model, queue, nodes)
        skip--
      }
    }
  }
  
  // Compute shortest path
  computeShortestPathFromNodes(numBytes, nodes)
  
  // Create commands from path
  return createCommandsFromPath(numBytes, position, nodes, distCache, lastInsertLen, npostfix, ndirect, maxBackwardLimit)
}

// Two-pass optimization for quality 11
export function createHqZopfliBackwardReferences(
  numBytes: number,
  position: number,
  ringbuffer: Uint8Array,
  ringbufferMask: number,
  hasher: BinaryTreeHasher,
  distCache: Int32Array,
  lastInsertLen: number,
  npostfix: number = 0,
  ndirect: number = 0,
  maxBackwardLimit: number = ringbufferMask - WINDOW_GAP + 1
): [Command[], number, number] {
  const quality = 11
  const maxZopfliLenVal = maxZopfliLen(quality)
  
  // Keyed by position, not by a running counter: dictionary distances are
  // relative to the position the match was found at, so they cannot be applied
  // anywhere else
  const storeEnd = numBytes >= MAX_TREE_COMP_LENGTH
    ? position + numBytes - MAX_TREE_COMP_LENGTH + 1
    : position
  const emptyArr: BackwardMatch[] = []
  const allMatches: BackwardMatch[][] = new Array(numBytes)
  const numMatchesPerPos: number[] = new Array(numBytes)
  for (let i = 0; i < numBytes; i++) {
    allMatches[i] = emptyArr
    numMatchesPerPos[i] = 0
  }

  for (let i = 0; i + 3 < numBytes; i++) {
    const pos = position + i
    const maxDistance = Math.min(pos, maxBackwardLimit)

    // Without a stream offset or compound dictionary the dictionary base
    // distance is just maxDistance
    const matches = hasher.findAllMatches(
      ringbuffer,
      ringbufferMask,
      pos,
      numBytes - i,
      maxDistance,
      maxDistance
    )

    // A long enough match makes the positions it spans irrelevant
    if (matches.length > 0) {
      const longestMatch = matches[matches.length - 1]
      if (backwardMatchLength(longestMatch) > maxZopfliLenVal) {
        const skip = backwardMatchLength(longestMatch) - 1
        allMatches[i] = [longestMatch]
        numMatchesPerPos[i] = 1
        hasher.storeRange(ringbuffer, ringbufferMask, pos + 1, Math.min(pos + skip + 1, storeEnd))
        i += skip
        continue
      }
    }

    allMatches[i] = matches
    numMatchesPerPos[i] = matches.length
  }

  // Save original state for second pass
  const origDistCache = distCache.slice()
  const origLastInsertLen = lastInsertLen
  
  // Allocate structures
  const distAlphabetSize = NUM_DISTANCE_SHORT_CODES + ndirect + (48 << npostfix)
  const model = new ZopfliCostModel(numBytes, distAlphabetSize)
  
  let commands: Command[] = []
  let numLiterals = 0
  let finalLastInsertLen = lastInsertLen
  
  // Allocate nodes once, reuse across iterations
  const nodes = createZopfliNodes(numBytes + 1)
  
  // Two iterations: first with literal costs, then with actual command costs
  for (let iteration = 0; iteration < 2; iteration++) {
    if (iteration > 0) resetZopfliNodes(nodes)
    nodes.length[0] = 0
    nodes.cost[0] = 0
    
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
      
      let skip = updateNodes(
        numBytes, position, i, ringbuffer, ringbufferMask,
        quality, maxBackwardLimit, distCache,
        numMatches, matches, model, queue, nodes,
        npostfix, ndirect
      )

      if (skip < LONG_COPY_QUICK_STEP) skip = 0
      if (numMatches === 1 && backwardMatchLength(matches[0]) > maxZopfliLenVal) {
        skip = Math.max(backwardMatchLength(matches[0]), skip)
      }
      if (skip > 1) {
        // See createZopfliBackwardReferences: skipped positions still need
        // evaluating to stay linked into the distance history
        skip--
        while (skip !== 0) {
          i++
          if (i + 3 >= numBytes) break
          evaluateNode(position, i, maxBackwardLimit, 0, distCache, model, queue, nodes)
          skip--
        }
      }
    }
    
    // Compute path and create commands
    computeShortestPathFromNodes(numBytes, nodes)
    ;[commands, numLiterals, finalLastInsertLen] = createCommandsFromPath(
      numBytes, position, nodes, distCache, lastInsertLen, npostfix, ndirect,
      maxBackwardLimit
    )
  }
  
  return [commands, numLiterals, finalLastInsertLen]
}

function createCommandsFromPath(
  numBytes: number,
  blockStart: number,
  nodes: ZopfliNodes,
  distCache: Int32Array,
  lastInsertLen: number,
  npostfix: number = 0,
  ndirect: number = 0,
  maxBackwardLimit: number = (1 << 22) - 16
): [Command[], number, number] {
  const commands: Command[] = []
  let numLiterals = 0
  let pos = 0
  let offset = nodes.cost[0] // next pointer
  let isFirst = true
  
  while (offset !== 0xFFFFFFFF && offset !== 0) {
    const next = pos + offset
    const copyLen = zopfliNodeCopyLength(nodes, next)
    let insertLen = zopfliNodeInsertLength(nodes, next)
    
    pos += insertLen
    
    if (isFirst) {
      insertLen += lastInsertLen
      isFirst = false
    }
    
    const distance = zopfliNodeCopyDistance(nodes, next)
    const lenCode = zopfliNodeLengthCode(nodes, next)
    const distCode = zopfliNodeDistanceCode(nodes, next)
    
    // Create command
    const cmd = createCommand(
      insertLen,
      copyLen,
      lenCode - copyLen,
      distCode,
      ndirect,
      npostfix
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
    offset = nodes.cost[next] // next pointer
  }
  
  // Remaining literals
  const finalInsertLen = numBytes - pos
  
  return [commands, numLiterals, finalInsertLen]
}
