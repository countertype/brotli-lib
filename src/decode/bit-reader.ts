// Bit reading for Brotli decompression

import { BrotliInput } from './streams'

const BROTLI_READ_SIZE = 4096
const BROTLI_BYTE_BUFFER_SIZE = BROTLI_READ_SIZE + 64
const BROTLI_SHORT_BUFFER_SIZE = BROTLI_BYTE_BUFFER_SIZE >> 1
export const BROTLI_IBUF_MASK = 2 * BROTLI_READ_SIZE - 1

const kBitMask = new Uint32Array([
  0x0, 0x1, 0x3, 0x7, 0xf, 0x1f, 0x3f, 0x7f,
  0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff,
  0xffff, 0x1ffff, 0x3ffff, 0x7ffff, 0xfffff, 0x1fffff, 0x3fffff, 0x7fffff,
  0xffffff,
])

// Short-buffer bit reader (Google-style)
export class BrotliBitReader {
  static readonly READ_SIZE = BROTLI_READ_SIZE
  static readonly IBUF_MASK = BROTLI_IBUF_MASK

  input_: BrotliInput
  byte_buffer_: Uint8Array
  short_buffer_: Int16Array
  accumulator32_: number = 0
  bit_offset_: number = 0
  half_offset_: number = 0
  tail_bytes_: number = 0
  end_of_stream_reached_: number = 0

  constructor(input: BrotliInput) {
    this.input_ = input
    this.byte_buffer_ = new Uint8Array(BROTLI_BYTE_BUFFER_SIZE)
    this.short_buffer_ = new Int16Array(BROTLI_SHORT_BUFFER_SIZE)
    this.reset()
  }

  reset(): boolean {
    this.accumulator32_ = 0
    this.bit_offset_ = 32
    this.half_offset_ = 2048
    this.tail_bytes_ = 0
    this.end_of_stream_reached_ = 0
    this.prepare()
    return this.bit_offset_ < 32
  }

  // Refill input buffer and rebuild short buffer
  readMoreInput(): void {
    if (this.end_of_stream_reached_ !== 0) {
      if (this.halfAvailable() >= -2) {
        return
      }
      throw new Error('Unexpected end of input')
    }
    const read_offset = this.half_offset_ << 1
    let bytes_in_buffer = BROTLI_READ_SIZE - read_offset
    this.byte_buffer_.copyWithin(0, read_offset, BROTLI_READ_SIZE)
    this.half_offset_ = 0
    while (bytes_in_buffer < BROTLI_READ_SIZE) {
      const space_left = BROTLI_READ_SIZE - bytes_in_buffer
      const len = this.input_.read(this.byte_buffer_, bytes_in_buffer, space_left)
      if (len < 0) {
        throw new Error('Unexpected end of input')
      }
      if (len <= 0) {
        this.end_of_stream_reached_ = 1
        this.tail_bytes_ = bytes_in_buffer
        bytes_in_buffer += 1
        break
      }
      bytes_in_buffer += len
    }
    this.bytesToNibbles(bytes_in_buffer)
  }

  private bytesToNibbles(bytes_in_buffer: number): void {
    const short_buffer = this.short_buffer_
    const byte_buffer = this.byte_buffer_
    const len = (bytes_in_buffer + 1) >> 1
    for (let i = 0; i < len; ++i) {
      short_buffer[i] = (byte_buffer[i * 2] & 0xff) | ((byte_buffer[(i * 2) + 1] & 0xff) << 8)
    }
  }

  private readInput(buf: Uint8Array, offset: number, length: number): number {
    return this.input_.read(buf, offset, length)
  }

  private checkHealth(end_of_stream: number): void {
    if (this.end_of_stream_reached_ === 0) {
      return
    }
    const byte_offset = (this.half_offset_ << 1) + ((this.bit_offset_ + 7) >> 3) - 4
    if (byte_offset > this.tail_bytes_) {
      throw new Error('Unexpected end of input')
    }
    if (end_of_stream !== 0 && byte_offset !== this.tail_bytes_) {
      throw new Error('Unexpected end of input')
    }
  }

  private prepare(): void {
    if (this.half_offset_ > 2030) {
      this.readMoreInput()
    }
    this.checkHealth(0)
    this.accumulator32_ = (this.short_buffer_[this.half_offset_++] << 16) | (this.accumulator32_ >>> 16)
    this.bit_offset_ -= 16
    this.accumulator32_ = (this.short_buffer_[this.half_offset_++] << 16) | (this.accumulator32_ >>> 16)
    this.bit_offset_ -= 16
  }

  private reload16(): void {
    if (this.half_offset_ > 2030) {
      this.readMoreInput()
    }
    this.checkHealth(0)
    this.accumulator32_ = (this.short_buffer_[this.half_offset_++] << 16) | (this.accumulator32_ >>> 16)
    this.bit_offset_ -= 16
  }

  private readFewBits(n_bits: number): number {
    const val = (this.accumulator32_ >>> this.bit_offset_) & kBitMask[n_bits]
    this.bit_offset_ += n_bits
    return val
  }

  private readManyBits(n_bits: number): number {
    const low = this.readFewBits(16)
    this.reload16()
    return low | (this.readFewBits(n_bits - 16) << 16)
  }

  peekBits(n_bits: number): number {
    if (this.bit_offset_ >= 16) {
      this.reload16()
    }
    return (this.accumulator32_ >>> this.bit_offset_) & kBitMask[n_bits]
  }

  skipBits(n_bits: number): void {
    this.bit_offset_ += n_bits
  }

  alignToByte(): number {
    const padding = (32 - this.bit_offset_) & 7
    if (padding === 0) {
      return 0
    }
    return this.readBits(padding)
  }

  copyRawBytes(dst: Uint8Array, offset: number, length: number): void {
    let pos = offset
    let len = length
    if ((this.bit_offset_ & 7) !== 0) {
      throw new Error('Invalid alignment for raw copy')
    }
    while (this.bit_offset_ !== 32 && len !== 0) {
      dst[pos++] = this.accumulator32_ >>> this.bit_offset_
      this.bit_offset_ += 8
      len--
    }
    if (len === 0) {
      return
    }
    const copy_nibbles = Math.min(this.halfAvailable(), len >> 1)
    if (copy_nibbles > 0) {
      const read_offset = this.half_offset_ << 1
      const delta = copy_nibbles << 1
      dst.set(this.byte_buffer_.subarray(read_offset, read_offset + delta), pos)
      pos += delta
      len -= delta
      this.half_offset_ += copy_nibbles
    }
    if (len === 0) {
      return
    }
    if (this.halfAvailable() > 0) {
      if (this.bit_offset_ >= 16) {
        this.accumulator32_ = (this.short_buffer_[this.half_offset_++] << 16) | (this.accumulator32_ >>> 16)
        this.bit_offset_ -= 16
      }
      while (len !== 0) {
        dst[pos++] = this.accumulator32_ >>> this.bit_offset_
        this.bit_offset_ += 8
        len--
      }
      this.checkHealth(0)
      return
    }
    while (len > 0) {
      const chunk_len = this.readInput(dst, pos, len)
      if (chunk_len <= 0) {
        throw new Error('Unexpected end of input')
      }
      pos += chunk_len
      len -= chunk_len
    }
  }

  private halfAvailable(): number {
    let limit = 2048
    if (this.end_of_stream_reached_ !== 0) {
      limit = (this.tail_bytes_ + 1) >> 1
    }
    return limit - this.half_offset_
  }

  readBits(n_bits: number): number {
    if (this.bit_offset_ >= 16) {
      this.reload16()
    }
    if (n_bits <= 16) {
      return this.readFewBits(n_bits)
    }
    return this.readManyBits(n_bits)
  }
}
