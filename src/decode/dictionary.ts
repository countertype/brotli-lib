// Brotli static dictionary, stored compressed

import { compressedDictionary } from './dictionary-bin'

let _dictionary: Uint8Array | null = null
let _decoder: ((data: Uint8Array) => Uint8Array) | null = null

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function setDecoder(decoder: (data: Uint8Array) => Uint8Array): void {
  _decoder = decoder
}

export function getDictionary(): Uint8Array {
  if (_dictionary === null) {
    if (_decoder === null) {
      throw new Error('Dictionary decoder not initialized')
    }
    const compressed = base64ToUint8Array(compressedDictionary)
    _dictionary = _decoder(compressed)
  }
  return _dictionary
}

export const offsetsByLength = new Uint32Array([
  0, 0, 0, 0, 0, 4096, 9216, 21504, 35840, 44032,
  53248, 63488, 74752, 87040, 93696, 100864, 104704, 106752, 108928, 113536,
  115968, 118528, 119872, 121280, 122016,
])

export const sizeBitsByLength = new Uint8Array([
  0, 0, 0, 0, 10, 10, 11, 11, 10, 10,
  10, 10, 10, 9, 9, 8, 7, 7, 8, 7,
  7, 6, 6, 5, 5,
])

export const minDictionaryWordLength = 4
export const maxDictionaryWordLength = 24

export function init(): void {
  getDictionary()
}
