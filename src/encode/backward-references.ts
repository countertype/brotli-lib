// Backward reference selection for Brotli compression
// Reference: woff2/brotli/c/enc/backward_references.c

import {
  BackwardMatch,
  HasherSearchResult,
  createSearchResult,
  findMatchLength,
  findMatchLengthWide,
  backwardReferenceScore,
  backwardReferenceScoreUsingLastDistance,
  HASH_MUL_32,
  SCORE_BASE,
} from './match'
import { Command, createCommand, createInsertCommand } from './command'
import { SimpleHasher, STORE_LOOKAHEAD, MIN_MATCH_LEN as QUICK_MIN_MATCH_LEN } from './hash-simple'
import { HashChainHasher, HASH_TYPE_LENGTH } from './hash-chains'
import { BinaryTreeHasher } from './hash-binary-tree'
import { searchInStaticDictionary } from './static-dict-fast'
import { NUM_DISTANCE_SHORT_CODES, MAX_ENCODABLE_DISTANCE } from './enc-constants'

export type Hasher = SimpleHasher | HashChainHasher | BinaryTreeHasher

// A match must beat this to be worth emitting at all
const MIN_SCORE = SCORE_BASE + 100

// How much better a match one byte later must score to displace the current one
const COST_DIFF_LAZY = 175

function resetSearch(sr: HasherSearchResult): void {
  sr.len = 0
  sr.distance = 0
  sr.score = MIN_SCORE
  sr.lenCodeDelta = 0
  sr.fromDictionary = false
}

// Only the dictionary produces distances past maxBackward; anything else out
// there is a bogus backward reference
function isUsable(sr: HasherSearchResult, maxBackward: number): boolean {
  return sr.score > MIN_SCORE && sr.distance > 0 &&
    (sr.fromDictionary || sr.distance <= maxBackward)
}

// Greedy backward reference selection for quality 5-9
export function createBackwardReferences(
  numBytes: number,
  position: number,
  ringbuffer: Uint8Array,
  ringbufferMask: number,
  hasher: HashChainHasher,
  distCache: Int32Array,
  lastInsertLen: number,
  _quality: number,
  npostfix: number = 0,
  ndirect: number = 0,
  maxBackwardLimit: number = ringbufferMask - 16 + 1,
  carryTrailingInsert = false
): [Command[], number, number] {
  const commands: Command[] = []
  let numLiterals = 0
  let insertLen = lastInsertLen
  let pos = position
  const posEnd = position + numBytes
  // Must agree with the window written to the stream header, since dictionary
  // distances are measured from it. Not derivable from ringbufferMask, which is
  // not a window mask when the buffer is flat
  const maxWindowBackward = maxBackwardLimit
  
  let sr = createSearchResult()
  let sr2 = createSearchResult()
  const lookahead = HASH_TYPE_LENGTH
  const storeEnd = numBytes >= lookahead ? position + numBytes - lookahead + 1 : position
  // After this many literals in a row the input is treated as incompressible
  // and positions are sampled instead of searched one by one
  const literalSpree = _quality < 9 ? 64 : 512
  let applyRandomHeuristics = position + literalSpree

  while (pos + 4 < posEnd) {
    let maxLen = posEnd - pos
    let maxBackward = Math.min(pos, maxWindowBackward)
    resetSearch(sr)
    hasher.findLongestMatch(
      ringbuffer, ringbufferMask, distCache, pos, maxLen, maxBackward, sr)

    if (isUsable(sr, maxBackward)) {
      // Lazy matching: a clearly better match starting one byte later wins,
      // at the price of one more literal
      let delayed = 0
      for (;;) {
        maxLen--
        const nextBackward = Math.min(pos + 1, maxWindowBackward)
        resetSearch(sr2)
        hasher.findLongestMatch(
          ringbuffer, ringbufferMask, distCache, pos + 1, maxLen, nextBackward, sr2)
        if (isUsable(sr2, nextBackward) && sr2.score >= sr.score + COST_DIFF_LAZY) {
          pos++
          insertLen++
          const t = sr
          sr = sr2
          sr2 = t
          maxBackward = nextBackward
          if (++delayed < 4 && pos + 4 < posEnd) continue
        }
        break
      }

      const distance = sr.distance
      const matchLen = sr.len
      const isDictionary = sr.fromDictionary
      applyRandomHeuristics = pos + 2 * matchLen + literalSpree

      // Cache-relative codes are only valid for real backward references
      const distCode = distanceToCode(distance, maxBackward, distCache)
      commands.push(createCommand(
        insertLen, matchLen, sr.lenCodeDelta, distCode, ndirect, npostfix))
      numLiterals += insertLen

      // Code 0 already means "same as last distance". Dictionary references are
      // excluded because the decoder never puts them in its ring
      if (!isDictionary && distCode > 0) {
        distCache[3] = distCache[2]
        distCache[2] = distCache[1]
        distCache[1] = distCache[0]
        distCache[0] = distance
      }

      // pos + 1 was stored by the lookahead search. Inside a run (distance
      // much shorter than the copy) only the tail is stored, so the run does
      // not flood its hash bucket
      let rangeStart = pos + 2
      const rangeEnd = Math.min(pos + matchLen, storeEnd)
      if (distance < (matchLen >> 2)) {
        rangeStart = Math.min(rangeEnd, Math.max(rangeStart, pos + matchLen - (distance << 2)))
      }
      hasher.storeRange(ringbuffer, ringbufferMask, rangeStart, rangeEnd)

      pos += matchLen
      insertLen = 0
    } else {
      insertLen++
      pos++
      if (pos > applyRandomHeuristics) {
        const sparse = pos > applyRandomHeuristics + 4 * literalSpree
        const step = sparse ? 4 : 2
        const margin = Math.max(lookahead - 1, step)
        const jump = Math.min(pos + (sparse ? 16 : 8), posEnd - margin)
        for (; pos < jump; pos += step) {
          hasher.store(ringbuffer, ringbufferMask, pos)
          insertLen += step
        }
      }
    }
  }
  insertLen += posEnd - pos

  // An insert-only command is only valid as the last one of a metablock, so
  // a caller that continues the metablock takes the literals back instead
  if (carryTrailingInsert) {
    return [commands, numLiterals, insertLen]
  }
  if (insertLen > 0) {
    // Create insert-only command for trailing literals
    const cmd = createInsertCommand(insertLen)
    commands.push(cmd)
    numLiterals += insertLen
    insertLen = 0
  }
  
  return [commands, numLiterals, insertLen]
}

// The same selection as createBackwardReferences, for the quick hasher, with
// the search written into the loop. One probe site serves both the first look
// at a position and the lazy look one byte later; `pending` says which
export function createBackwardReferencesQuick(
  numBytes: number,
  position: number,
  data: Uint8Array,
  mask: number,
  hasher: SimpleHasher,
  distCache: Int32Array,
  lastInsertLen: number,
  npostfix: number,
  ndirect: number,
  maxBackwardLimit: number,
  carryTrailingInsert = false
): [Command[], number, number] {
  const commands: Command[] = []
  let numLiterals = 0
  let insertLen = lastInsertLen
  let pos = position
  const posEnd = position + numBytes
  const storeEnd = numBytes >= STORE_LOOKAHEAD ? posEnd - STORE_LOOKAHEAD + 1 : position
  const literalSpree = 64
  let applyRandomHeuristics = position + literalSpree

  const buckets = hasher.buckets
  const bucketMask = hasher.bucketMask
  const sweep = hasher.sweep
  const sweepMask = hasher.sweepMask
  const hashShift = 32 - hasher.bucketBits
  const useDictionary = hasher.useDictionary
  const dictState = hasher.dictState
  const view = hasher.viewOf(data)
  const dataLength = data.length
  const dictResult = createSearchResult()

  // The match held at `pos` while the position after it is tried
  let pending = false
  let heldLen = 0
  let heldDistance = 0
  let heldScore = 0
  let heldLenCodeDelta = 0
  let heldFromDictionary = false
  let heldMaxBackward = 0
  let delayed = 0

  while (pos + 4 < posEnd) {
    const ix = pending ? pos + 1 : pos
    const ixMasked = ix & mask
    const maxLen = posEnd - ix
    const maxBackward = Math.min(ix, maxBackwardLimit)
    // A lazy candidate has to be at least as long as what it would replace
    const initialLen = pending ? Math.min(heldLen - 1, maxLen) : 0
    // Word reads throw past the end where byte reads return undefined. An
    // unwrapped position also means every earlier one is unwrapped
    const wide = maxLen >= 4 && ix === ixMasked && ix + maxLen <= dataLength

    let bestLen = initialLen
    let bestScore = MIN_SCORE
    let foundLen = initialLen
    let foundDistance = 0
    let foundLenCodeDelta = 0
    let foundFromDictionary = false

    const key = ixMasked + 4 <= dataLength
      ? (Math.imul(view.getUint32(ixMasked, true) ^ (data[ixMasked + 4] << 24), HASH_MUL_32) >>> 0) >>> hashShift
      : hasher.hashAt(data, ixMasked)

    // The last distance first: it is the cheapest to code
    const cachedBackward = distCache[0]
    if (cachedBackward > 0 && cachedBackward <= maxBackward) {
      const prevIx = (ix - cachedBackward) & mask
      if (data[prevIx + bestLen] === data[ixMasked + bestLen]) {
        const len = wide
          ? findMatchLengthWide(view, data, prevIx, ixMasked, maxLen)
          : findMatchLength(data, prevIx, ixMasked, maxLen)
        if (len >= QUICK_MIN_MATCH_LEN) {
          const score = backwardReferenceScoreUsingLastDistance(len)
          if (score > bestScore) {
            bestLen = len
            bestScore = score
            foundLen = len
            foundDistance = cachedBackward
          }
        }
      }
    }

    // Slots are read before the current position overwrites one of them
    for (let i = 0; i < sweep; i++) {
      const stored = buckets[(key + (i << 3)) & bucketMask]
      const backward = ix - stored
      if (backward <= 0 || backward > maxBackward) continue

      const prevIx = stored & mask
      if (data[prevIx + bestLen] !== data[ixMasked + bestLen]) continue

      const len = wide
        ? findMatchLengthWide(view, data, prevIx, ixMasked, maxLen)
        : findMatchLength(data, prevIx, ixMasked, maxLen)
      if (len >= QUICK_MIN_MATCH_LEN) {
        const score = backwardReferenceScore(len, backward)
        if (score > bestScore) {
          bestLen = len
          bestScore = score
          foundLen = len
          foundDistance = backward
        }
      }
    }
    buckets[(key + (ix & sweepMask)) & bucketMask] = ix

    // Only worth consulting when no backward reference was found. The first
    // test repeats the lookup throttle so that a throttled call costs nothing
    if (useDictionary && bestScore === MIN_SCORE &&
        dictState.numMatches >= (dictState.numLookups >> 7)) {
      dictResult.len = initialLen
      dictResult.distance = 0
      dictResult.score = MIN_SCORE
      dictResult.lenCodeDelta = 0
      dictResult.fromDictionary = false
      searchInStaticDictionary(
        data, ixMasked, maxLen, maxBackward, MAX_ENCODABLE_DISTANCE,
        dictResult, true, dictState)
      bestScore = dictResult.score
      foundLen = dictResult.len
      foundDistance = dictResult.distance
      foundLenCodeDelta = dictResult.lenCodeDelta
      foundFromDictionary = dictResult.fromDictionary
    }

    // Only the dictionary produces distances past maxBackward; anything else
    // out there is a bogus backward reference
    const usable = bestScore > MIN_SCORE && foundDistance > 0 &&
      (foundFromDictionary || foundDistance <= maxBackward)

    if (!pending) {
      if (usable) {
        pending = true
        delayed = 0
        heldLen = foundLen
        heldDistance = foundDistance
        heldScore = bestScore
        heldLenCodeDelta = foundLenCodeDelta
        heldFromDictionary = foundFromDictionary
        heldMaxBackward = maxBackward
        continue
      }
      insertLen++
      pos++
      if (pos > applyRandomHeuristics) {
        const sparse = pos > applyRandomHeuristics + 4 * literalSpree
        const step = sparse ? 4 : 2
        const margin = Math.max(STORE_LOOKAHEAD - 1, step)
        const jump = Math.min(pos + (sparse ? 16 : 8), posEnd - margin)
        for (; pos < jump; pos += step) {
          hasher.store(data, mask, pos)
          insertLen += step
        }
      }
      continue
    }

    // Lazy matching: a clearly better match starting one byte later wins, at
    // the price of one more literal
    if (usable && bestScore >= heldScore + COST_DIFF_LAZY) {
      pos++
      insertLen++
      heldLen = foundLen
      heldDistance = foundDistance
      heldScore = bestScore
      heldLenCodeDelta = foundLenCodeDelta
      heldFromDictionary = foundFromDictionary
      heldMaxBackward = maxBackward
      if (++delayed < 4 && pos + 4 < posEnd) continue
    }
    pending = false

    applyRandomHeuristics = pos + 2 * heldLen + literalSpree

    // Cache-relative codes are only valid for real backward references
    const distCode = distanceToCode(heldDistance, heldMaxBackward, distCache)
    commands.push(createCommand(
      insertLen, heldLen, heldLenCodeDelta, distCode, ndirect, npostfix))
    numLiterals += insertLen

    // Code 0 already means "same as last distance". Dictionary references are
    // excluded because the decoder never puts them in its ring
    if (!heldFromDictionary && distCode > 0) {
      distCache[3] = distCache[2]
      distCache[2] = distCache[1]
      distCache[1] = distCache[0]
      distCache[0] = heldDistance
    }

    // pos + 1 was stored by the lazy probe. Inside a run (distance much
    // shorter than the copy) only the tail is stored, so the run does not
    // flood its hash bucket
    let rangeStart = pos + 2
    const rangeEnd = Math.min(pos + heldLen, storeEnd)
    if (heldDistance < (heldLen >> 2)) {
      rangeStart = Math.min(rangeEnd, Math.max(rangeStart, pos + heldLen - (heldDistance << 2)))
    }
    hasher.storeRange(data, mask, rangeStart, rangeEnd)

    pos += heldLen
    insertLen = 0
  }
  insertLen += posEnd - pos

  if (carryTrailingInsert) {
    return [commands, numLiterals, insertLen]
  }
  if (insertLen > 0) {
    commands.push(createInsertCommand(insertLen))
    numLiterals += insertLen
    insertLen = 0
  }
  return [commands, numLiterals, insertLen]
}

// Convert backward distance to distance code
// Returns 0-15 for cache match, 16+ for literal distance
export function distanceToCode(
  distance: number,
  maxDistance: number,
  distCache: Int32Array
): number {
  // Cache-relative codes are unreachable for dictionary distances
  if (distance > 0 && distance <= maxDistance) {
    const last = distCache[0]
    const secondLast = distCache[1]
    if (distance === last) return 0
    if (distance === secondLast) return 1
    if (distance === distCache[2]) return 2
    if (distance === distCache[3]) return 3
    // Codes 4-9 are the last distance -1, +1, -2, +2, -3, +3 and codes 10-15
    // the same offsets from the one before; each constant maps offset + 3 to
    // its code, four bits apiece
    const fromLast = distance + 3 - last
    if (fromLast >= 0 && fromLast < 7) return (0x9750468 >>> (4 * fromLast)) & 0xF
    const fromSecondLast = distance + 3 - secondLast
    if (fromSecondLast >= 0 && fromSecondLast < 7) return (0xFDB1ACE >>> (4 * fromSecondLast)) & 0xF
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
