// Input/output buffer wrappers for Brotli decompression

export class BrotliInput {
  buffer: Uint8Array
  pos: number

  constructor(buffer: Uint8Array) {
    this.buffer = buffer
    this.pos = 0
  }

  read(buf: Uint8Array, i: number, count: number): number {
    const available = this.buffer.length - this.pos
    if (count > available) {
      count = available
    }
    buf.set(this.buffer.subarray(this.pos, this.pos + count), i)
    this.pos += count
    return count
  }
}

export class BrotliOutput {
  buffer: Uint8Array
  pos: number

  constructor(buf: Uint8Array) {
    this.buffer = buf
    this.pos = 0
  }

  write(buf: Uint8Array, count: number): number {
    if (this.pos + count > this.buffer.length) {
      throw new Error('Output buffer is not large enough')
    }
    this.buffer.set(buf.subarray(0, count), this.pos)
    this.pos += count
    return count
  }
}
