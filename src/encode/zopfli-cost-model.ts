// Zopfli cost model for Brotli compression
// Reference: woff2/brotli/c/enc/backward_references_hq.c

import { fastLog2 } from './fast-log'
import { estimateBitCostsForLiterals } from './literal-cost'
import { NUM_LITERAL_CODES, NUM_COMMAND_CODES } from './enc-constants'
import { Command, commandCopyLen } from './command'

export const MAX_EFFECTIVE_DISTANCE_ALPHABET_SIZE = 544
export const INFINITY_COST = 1.7e38

// Estimates bit cost of encoding symbols based on frequency distributions
export class ZopfliCostModel {
  private costCmd: Float32Array
  private costDist: Float32Array
  private literalCosts: Float32Array // cumulative by position
  private minCostCmd: number = INFINITY_COST
  private numBytes: number
  private distanceHistogramSize: number

  constructor(numBytes: number, distanceAlphabetSize: number) {
    this.numBytes = numBytes
    this.distanceHistogramSize = distanceAlphabetSize
    this.costCmd = new Float32Array(NUM_COMMAND_CODES)
    this.costDist = new Float32Array(distanceAlphabetSize)
    this.literalCosts = new Float32Array(numBytes + 2)
  }

  // First pass: use heuristics for command and distance costs
  setFromLiteralCosts(
    position: number,
    ringbuffer: Uint8Array,
    ringbufferMask: number
  ): void {
    const costs = estimateBitCostsForLiterals(
      position, this.numBytes, ringbufferMask, ringbuffer)

    // Running sum with a compensation term, since these are 32-bit floats
    this.literalCosts[0] = 0
    let literalCarry = 0
    for (let i = 0; i < this.numBytes; i++) {
      literalCarry += costs[i]
      this.literalCosts[i + 1] = this.literalCosts[i] + literalCarry
      literalCarry -= this.literalCosts[i + 1] - this.literalCosts[i]
    }

    // Simple cost model for commands: log2(11 + i)
    for (let i = 0; i < NUM_COMMAND_CODES; i++) {
      this.costCmd[i] = fastLog2(11 + i)
    }
    
    // Simple cost model for distances: log2(20 + i)
    for (let i = 0; i < this.distanceHistogramSize; i++) {
      this.costDist[i] = fastLog2(20 + i)
    }
    
    this.minCostCmd = fastLog2(11)
  }

  // Second pass: use histogram of actual commands from first pass
  setFromCommands(
    position: number,
    ringbuffer: Uint8Array,
    ringbufferMask: number,
    commands: Command[],
    lastInsertLen: number
  ): void {
    // Build histograms from commands
    const histogramLiteral = new Uint32Array(NUM_LITERAL_CODES)
    const histogramCmd = new Uint32Array(NUM_COMMAND_CODES)
    const histogramDist = new Uint32Array(this.distanceHistogramSize)
    const costLiteral = new Float32Array(NUM_LITERAL_CODES)
    
    let pos = position - lastInsertLen
    
    for (const cmd of commands) {
      const insLen = cmd.insertLen
      const copyLen = commandCopyLen(cmd)
      const distCode = cmd.distPrefix & 0x3FF
      const cmdCode = cmd.cmdPrefix
      
      histogramCmd[cmdCode]++
      if (cmdCode >= 128) {
        histogramDist[distCode]++
      }
      
      // Count literals
      for (let j = 0; j < insLen; j++) {
        histogramLiteral[ringbuffer[(pos + j) & ringbufferMask]]++
      }
      
      pos += insLen + copyLen
    }
    
    // Convert histograms to costs
    this.setCostFromHistogram(histogramLiteral, true, costLiteral)
    this.setCostFromHistogram(histogramCmd, false, this.costCmd)
    this.setCostFromHistogram(histogramDist, false, this.costDist)
    
    // Find minimum command cost
    this.minCostCmd = INFINITY_COST
    for (let i = 0; i < NUM_COMMAND_CODES; i++) {
      if (this.costCmd[i] < this.minCostCmd) {
        this.minCostCmd = this.costCmd[i]
      }
    }
    
    // Build cumulative literal costs
    this.literalCosts[0] = 0
    let literalCarry = 0
    for (let i = 0; i < this.numBytes; i++) {
      const byte = ringbuffer[(position + i) & ringbufferMask]
      literalCarry += costLiteral[byte]
      this.literalCosts[i + 1] = this.literalCosts[i] + literalCarry
      literalCarry -= this.literalCosts[i + 1] - this.literalCosts[i]
    }
  }

  private setCostFromHistogram(
    histogram: Uint32Array,
    isLiteralHistogram: boolean,
    cost: Float32Array
  ): void {
    let sum = 0
    for (let i = 0; i < histogram.length; i++) {
      sum += histogram[i]
    }
    
    const log2sum = fastLog2(sum)
    
    // For missing symbols, estimate cost
    let missingSymbolSum = sum
    if (!isLiteralHistogram) {
      for (let i = 0; i < histogram.length; i++) {
        if (histogram[i] === 0) {
          missingSymbolSum++
        }
      }
    }
    const missingSymbolCost = fastLog2(missingSymbolSum) + 2
    
    for (let i = 0; i < histogram.length; i++) {
      if (histogram[i] === 0) {
        cost[i] = missingSymbolCost
      } else {
        // Shannon bits: log2(total/count) = log2(total) - log2(count)
        cost[i] = log2sum - fastLog2(histogram[i])
        // Cannot code with less than 1 bit
        if (cost[i] < 1) {
          cost[i] = 1
        }
      }
    }
  }

  getCommandCost(cmdCode: number): number {
    return this.costCmd[cmdCode]
  }

  getDistanceCost(distCode: number): number {
    return this.costDist[distCode]
  }

  getLiteralCosts(from: number, to: number): number {
    return this.literalCosts[to] - this.literalCosts[from]
  }

  getMinCostCmd(): number {
    return this.minCostCmd
  }
}
