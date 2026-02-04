// Backward reference selection for Brotli compression
// Reference: woff2/brotli/c/enc/backward_references.c

import { BackwardMatch, createSearchResult } from './match'
import { Command, createCommand, createInsertCommand } from './command'
import { SimpleHasher } from './hash-simple'
import { HashChainHasher } from './hash-chains'
import { BinaryTreeHasher } from './hash-binary-tree'
import { NUM_DISTANCE_SHORT_CODES } from './enc-constants'

export type Hasher = SimpleHasher | HashChainHasher | BinaryTreeHasher

// Greedy backward reference selection for quality 2-9
export function createBackwardReferences(
  numBytes: number,
  position: number,
  ringbuffer: Uint8Array,
  ringbufferMask: number,
  hasher: SimpleHasher | HashChainHasher,
  distCache: Int32Array,
  lastInsertLen: number,
  _quality: number
): [Command[], number, number] {
  const commands: Command[] = []
  let numLiterals = 0
  let insertLen = lastInsertLen
  let pos = position
  const posEnd = position + numBytes
  const maxWindowBackward = (1 << 22) - 16 // lgwin=22 default
  
  // Reuse to avoid alloc in loop
  const result = { len: 0, distance: 0, score: 0, lenCodeDelta: 0 }
  
  while (pos < posEnd) {
    const maxLen = posEnd - pos
    if (maxLen < 4) {
      // Too short for a match
      insertLen += maxLen
      pos += maxLen
      break
    }
    
    // Maximum backward distance depends on current position
    const maxBackward = Math.min(pos, maxWindowBackward)
    
    // Reset and find best match at this position
    result.len = 0
    result.distance = 0
    result.score = 0
    result.lenCodeDelta = 0
    hasher.findLongestMatch(
      ringbuffer,
      ringbufferMask,
      distCache,
      pos,
      Math.min(maxLen, 128), // Limit match length for greedy
      maxBackward,
      result
    )
    
    if (result.len >= 4 && result.score > 0 && result.distance > 0) {
      // Found a good match
      const distance = result.distance
      const matchLen = result.len
      
      // Validate the match
      if (distance > pos) {
        // Invalid: distance can't be greater than current position
        hasher.store(ringbuffer, ringbufferMask, pos)
        insertLen++
        pos++
        continue
      }
      
      // Create command
      const distCode = distanceToCode(distance, distCache)
      const cmd = createCommand(
        insertLen,
        matchLen,
        result.lenCodeDelta,
        distCode
      )
      commands.push(cmd)
      numLiterals += insertLen
      
      // Update distance cache for all non-zero distance codes
      // Note: distCode 0 means "same as last distance" so cache doesn't change
      // For all other codes (1-15 short codes, 16+ literal distances), update cache
      if (distCode > 0) {
        distCache[3] = distCache[2]
        distCache[2] = distCache[1]
        distCache[1] = distCache[0]
        distCache[0] = distance
      }
      
      // Store matched positions in hasher
      const storeEnd = Math.min(pos + matchLen, posEnd - 4)
      for (let i = pos + 1; i < storeEnd; i++) {
        hasher.store(ringbuffer, ringbufferMask, i)
      }
      
      pos += matchLen
      insertLen = 0
    } else {
      // No good match - emit literal
      hasher.store(ringbuffer, ringbufferMask, pos)
      insertLen++
      pos++
    }
  }
  
  // Handle remaining literals
  if (insertLen > 0) {
    // Create insert-only command for trailing literals
    const cmd = createInsertCommand(insertLen)
    commands.push(cmd)
    numLiterals += insertLen
    insertLen = 0
  }
  
  return [commands, numLiterals, insertLen]
}

const DISTANCE_CACHE_INDEX = new Uint8Array([
  0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1
])

const DISTANCE_CACHE_OFFSET = new Int8Array([
  0, 0, 0, 0, -1, 1, -2, 2, -3, 3, -1, 1, -2, 2, -3, 3
])

// Convert backward distance to distance code
// Returns 0-15 for cache match, 16+ for literal distance
export function distanceToCode(distance: number, distCache: Int32Array): number {
  // Check short distance codes (cache references)
  for (let i = 0; i < NUM_DISTANCE_SHORT_CODES; i++) {
    const idx = DISTANCE_CACHE_INDEX[i]
    const cached = distCache[idx] + DISTANCE_CACHE_OFFSET[i]
    if (distance === cached && cached > 0) {
      return i
    }
  }
  
  // Use literal distance code
  return distance + NUM_DISTANCE_SHORT_CODES - 1
}

export function backwardMatchLength(match: BackwardMatch): number {
  return match.length
}

export function backwardMatchLengthCode(match: BackwardMatch): number {
  return match.length + match.lenCodeDelta
}

export function initBackwardMatch(distance: number, length: number): BackwardMatch {
  return {
    distance,
    length,
    score: 0,
    lenCodeDelta: 0,
  }
}

export function initDictionaryBackwardMatch(
  distance: number,
  length: number,
  lenCodeDelta: number
): BackwardMatch {
  return {
    distance,
    length,
    score: 0,
    lenCodeDelta,
  }
}
