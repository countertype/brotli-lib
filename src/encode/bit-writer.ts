// Bit writing for Brotli compression
// Reference: woff2/brotli/c/enc/write_bits.h

// Writes bits to a byte array in LSB-first order within each byte.
// Inverse of BrotliBitReader.
//
// Bits written to increasing byte addresses; within a byte, LSB first.
// Example: 3 bits 'RRR' written -> BYTE-0: 0000 0RRR
// Writing 5 more 'SSSSS' -> BYTE-0: SSRR RRRR, BYTE-1: 0000 0SSS
export class BitWriter {
  buffer: Uint8Array
  pos: number // bit position
  private flushedBytePos: number

  constructor(initialSize: number = 4096) {
    this.buffer = new Uint8Array(initialSize)
    this.pos = 0
    this.flushedBytePos = 0
  }

  private ensureCapacity(bits: number): void {
    const bytesNeeded = ((this.pos + bits + 7) >>> 3) + 1
    if (bytesNeeded > this.buffer.length) {
      const newSize = Math.max(this.buffer.length * 2, bytesNeeded)
      const newBuffer = new Uint8Array(newSize)
      newBuffer.set(this.buffer)
      this.buffer = newBuffer
    }
  }

  // Write up to 25 bits; for more use writeBitsLong
  writeBits(nBits: number, value: number): void {
    this.ensureCapacity(nBits)
    
    const bytePos = this.pos >>> 3
    const bitOffset = this.pos & 7
    
    // Clear only the bits we're writing, preserve existing bits
    // Then OR in the new value shifted to the right position
    let v = this.buffer[bytePos] | 0
    v |= (value << bitOffset)
    this.buffer[bytePos] = v & 0xFF
    
    // Handle overflow into subsequent bytes
    let bitsWritten = 8 - bitOffset
    let remaining = value >>> bitsWritten
    let pos = bytePos + 1
    
    while (bitsWritten < nBits) {
      this.buffer[pos++] = remaining & 0xFF
      remaining >>>= 8
      bitsWritten += 8
    }
    
    this.pos += nBits
  }

  // Write up to 56 bits using BigInt for precision
  writeBitsLong(nBits: number, value: bigint): void {
    if (nBits <= 25) {
      this.writeBits(nBits, Number(value))
      return
    }
    
    this.ensureCapacity(nBits)
    
    const bytePos = this.pos >>> 3
    const bitOffset = this.pos & 7
    
    // Shift value into position
    let v = value << BigInt(bitOffset)
    
    // Write bytes
    const bytesToWrite = ((nBits + bitOffset + 7) >>> 3)
    
    // First byte: OR with existing
    this.buffer[bytePos] |= Number(v & 0xFFn)
    v >>= 8n
    
    // Remaining bytes: overwrite
    for (let i = 1; i < bytesToWrite; i++) {
      this.buffer[bytePos + i] = Number(v & 0xFFn)
      v >>= 8n
    }
    
    this.pos += nBits
  }

  writeBit(bit: number): void {
    this.writeBits(1, bit & 1)
  }

  // Throws if not byte-aligned
  writeByte(byte: number): void {
    if ((this.pos & 7) !== 0) {
      throw new Error('BitWriter not byte-aligned')
    }
    this.ensureCapacity(8)
    this.buffer[this.pos >>> 3] = byte & 0xFF
    this.pos += 8
  }

  // Must be byte-aligned
  writeBytes(bytes: Uint8Array): void {
    if ((this.pos & 7) !== 0) {
      throw new Error('BitWriter not byte-aligned')
    }
    this.ensureCapacity(bytes.length * 8)
    this.buffer.set(bytes, this.pos >>> 3)
    this.pos += bytes.length * 8
  }

  // Align to byte boundary, returns number of padding bits written
  alignToByte(): number {
    const padding = (8 - (this.pos & 7)) & 7
    if (padding > 0) {
      this.writeBits(padding, 0)
    }
    return padding
  }

  get bytePos(): number {
    return this.pos >>> 3
  }

  get bitOffset(): number {
    return this.pos & 7
  }

  reset(): void {
    this.pos = 0
    this.flushedBytePos = 0
    this.buffer.fill(0)
  }

  // Return newly completed bytes since the last call.
  // Never returns a partially-written byte (required for streaming)
  takeBytes(): Uint8Array {
    const end = this.pos >>> 3 // only fully-written bytes
    if (end <= this.flushedBytePos) return new Uint8Array(0)
    const out = this.buffer.slice(this.flushedBytePos, end)
    this.flushedBytePos = end
    return out
  }

  finish(): Uint8Array {
    // Round up to include partial final byte
    const byteLength = (this.pos + 7) >>> 3
    return this.buffer.slice(0, byteLength)
  }

  // Must be byte-aligned; zeros the current byte
  prepareStorage(): void {
    if ((this.pos & 7) !== 0) {
      throw new Error('prepareStorage requires byte alignment')
    }
    this.ensureCapacity(8)
    this.buffer[this.pos >>> 3] = 0
  }
}

export function writeVarInt(writer: BitWriter, value: number): void {
  while (value > 0x7F) {
    writer.writeBits(8, (value & 0x7F) | 0x80)
    value >>>= 7
  }
  writer.writeBits(8, value)
}

// Encode window size bits for stream header
// lgwin: log2 of window size (10-24 standard, up to 30 large window)
export function encodeWindowBits(lgwin: number, largeWindow: boolean): { value: number; bits: number } {
  if (largeWindow) {
    // Large window: 14 bits
    return {
      value: ((lgwin & 0x3F) << 8) | 0x11,
      bits: 14
    }
  }
  
  if (lgwin === 16) {
    // lgwin 16: single 0 bit
    return { value: 0, bits: 1 }
  } else if (lgwin === 17) {
    // lgwin 17: 7 bits, value 1
    return { value: 1, bits: 7 }
  } else if (lgwin > 17 && lgwin <= 24) {
    // lgwin 18-24: 4 bits
    return { value: ((lgwin - 17) << 1) | 0x01, bits: 4 }
  } else {
    // lgwin 10-15: 7 bits
    return { value: ((lgwin - 8) << 4) | 0x01, bits: 7 }
  }
}
