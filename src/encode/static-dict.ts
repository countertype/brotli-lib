// Static dictionary match search for the encoder, used by quality 10 and 11.
// Reference: c/enc/static_dict.c (BrotliFindAllStaticDictionaryMatches)
//
// The search body is a transliteration of the reference's hand-unrolled
// transform matching and is best reviewed against it. The transform indices it
// carries (`id + 49 * n` and the like) address the RFC transform table, so they
// must stay in step with the table the decoder applies

import {
  SIZE_BITS_BY_LENGTH,
  OFFSETS_BY_LENGTH,
  getDictionaryData,
} from './dictionary-data'
import {
  getDictionaryLut,
  hashDictionaryPrefix,
  dictWordLength,
  dictWordIsLast,
  dictWordTransform,
  dictWordIndex,
  TRANSFORM_TYPE_UPPERCASE_FIRST,
  TRANSFORM_IDX_UPPERCASE_FIRST,
  TRANSFORM_IDX_UPPERCASE_ALL,
} from './static-dict-lut'

import { MAX_STATIC_DICTIONARY_MATCH_LEN, INVALID_MATCH } from './static-dict-types'
export { MAX_STATIC_DICTIONARY_MATCH_LEN, INVALID_MATCH }

// transformId for an OMIT_LAST_<cut> transform is (cut << 2) + this table.
// The reference packs these as 6-bit fields of a uint64; JavaScript's 32-bit
// shifts cannot reach the upper fields, so they are spelled out
const CUTOFF_TRANSFORMS = new Uint8Array([0, 8, 19, 11, 26, 43, 32, 20, 27, 28])

function findMatchLengthWithLimit(
  a: Uint8Array, aPos: number, b: Uint8Array, bPos: number, limit: number
): number {
  let i = 0
  while (i < limit && a[aPos + i] === b[bPos + i]) i++
  return i
}

// Length of the common prefix between the input at `pos` and dictionary word
// `id` of length `len`
function dictMatchLength(
  data: Uint8Array, pos: number, id: number, len: number, maxlen: number
): number {
  const dict = getDictionaryData()
  const offset = OFFSETS_BY_LENGTH[len] + len * id
  return findMatchLengthWithLimit(dict, offset, data, pos, Math.min(len, maxlen))
}

// Does dictionary word `id` (under `transformType`) match the input at `pos`?
function isMatch(
  data: Uint8Array, pos: number, len: number, id: number,
  transformType: number, maxLength: number
): boolean {
  if (len > maxLength) return false
  const dict = getDictionaryData()
  const offset = OFFSETS_BY_LENGTH[len] + len * id
  if (transformType === 0) {
    return findMatchLengthWithLimit(dict, offset, data, pos, len) === len
  }
  if (transformType === TRANSFORM_TYPE_UPPERCASE_FIRST) {
    // Only ASCII words reach the uppercase entries in the lookup table
    const c = dict[offset]
    return c >= 97 && c <= 122 && (c ^ 32) === data[pos] &&
      findMatchLengthWithLimit(dict, offset + 1, data, pos + 1, len - 1) === len - 1
  }
  for (let i = 0; i < len; ++i) {
    const c = dict[offset + i]
    if (c >= 97 && c <= 122) {
      if ((c ^ 32) !== data[pos + i]) return false
    } else if (c !== data[pos + i]) {
      return false
    }
  }
  return true
}

// matches[len] keeps the cheapest (lowest) encoding seen for that length
function addMatch(distance: number, len: number, lenCode: number, matches: Uint32Array): void {
  const match = ((distance << 5) + lenCode) >>> 0
  if (match < matches[len]) matches[len] = match
}

// Fills `matches` (length MAX_STATIC_DICTIONARY_MATCH_LEN + 1, pre-filled with
// INVALID_MATCH) with dictionary matches for the input at `pos`. Each entry
// packs (dictionary id << 5) | length code. Returns whether anything matched.
// Numeric literals in the branches below are ASCII byte values, matching the
// character comparisons in the reference
export function findAllStaticDictionaryMatches(
  data: Uint8Array,
  pos: number,
  minLength: number,
  maxLength: number,
  matches: Uint32Array
): boolean {
  const { buckets, words } = getDictionaryLut()
  let hasFoundMatch = false
  let sOff = 0
    {
      let offset = buckets[hashDictionaryPrefix(data, pos)];
      let end = offset === 0;
      while (!end) {
        const w = words[offset++];
        const l = dictWordLength(w);
        const n = 1 << SIZE_BITS_BY_LENGTH[l];
        const id = dictWordIndex(w);
        end = dictWordIsLast(w);
        if (dictWordTransform(w) === 0) {
          const matchlen =
              dictMatchLength(data, pos, id, l, maxLength);
          let minlen: number
          let maxlen: number
          let len: number
          // Transform "" + BROTLI_TRANSFORM_IDENTITY + ""
          if (matchlen === l) {
            addMatch(id, l, l, matches);
            hasFoundMatch = true;
          }
          // Transforms "" + BROTLI_TRANSFORM_OMIT_LAST_1 + "" and "" + BROTLI_TRANSFORM_OMIT_LAST_1 + "ing "
          if (matchlen >= l - 1) {
            addMatch(id + 12 * n, l - 1, l, matches);
            if (l + 2 < maxLength &&
                data[pos + l - 1] === 105 && data[pos + l] === 110 && data[pos + l + 1] === 103 &&
                data[pos + l + 2] === 32) {
              addMatch(id + 49 * n, l + 3, l, matches);
            }
            hasFoundMatch = true;
          }
          // Transform "" + BROTLI_TRANSFORM_OMIT_LAST_# + "" (# = 2 .. 9)
          minlen = minLength;
          if (l > 9) minlen = Math.max(minlen, l - 9);
          maxlen = Math.min(matchlen, l - 2);
          for (len = minlen; len <= maxlen; ++len) {
            let cut = l - len;
            let transformId = (cut << 2) +
                CUTOFF_TRANSFORMS[cut];
            addMatch(id + transformId * n, len, l, matches);
            hasFoundMatch = true;
          }
          if (matchlen < l || l + 6 >= maxLength) {
            continue;
          }
          sOff = pos + l;
          // Transforms "" + BROTLI_TRANSFORM_IDENTITY + <suffix>
          if (data[sOff] === 32) {
            addMatch(id + n, l + 1, l, matches);
            if (data[sOff + 1] === 97) {
              if (data[sOff + 2] === 32) {
                addMatch(id + 28 * n, l + 3, l, matches);
              } else if (data[sOff + 2] === 115) {
                if (data[sOff + 3] === 32) addMatch(id + 46 * n, l + 4, l, matches);
              } else if (data[sOff + 2] === 116) {
                if (data[sOff + 3] === 32) addMatch(id + 60 * n, l + 4, l, matches);
              } else if (data[sOff + 2] === 110) {
                if (data[sOff + 3] === 100 && data[sOff + 4] === 32) {
                  addMatch(id + 10 * n, l + 5, l, matches);
                }
              }
            } else if (data[sOff + 1] === 98) {
              if (data[sOff + 2] === 121 && data[sOff + 3] === 32) {
                addMatch(id + 38 * n, l + 4, l, matches);
              }
            } else if (data[sOff + 1] === 105) {
              if (data[sOff + 2] === 110) {
                if (data[sOff + 3] === 32) addMatch(id + 16 * n, l + 4, l, matches);
              } else if (data[sOff + 2] === 115) {
                if (data[sOff + 3] === 32) addMatch(id + 47 * n, l + 4, l, matches);
              }
            } else if (data[sOff + 1] === 102) {
              if (data[sOff + 2] === 111) {
                if (data[sOff + 3] === 114 && data[sOff + 4] === 32) {
                  addMatch(id + 25 * n, l + 5, l, matches);
                }
              } else if (data[sOff + 2] === 114) {
                if (data[sOff + 3] === 111 && data[sOff + 4] === 109 && data[sOff + 5] === 32) {
                  addMatch(id + 37 * n, l + 6, l, matches);
                }
              }
            } else if (data[sOff + 1] === 111) {
              if (data[sOff + 2] === 102) {
                if (data[sOff + 3] === 32) addMatch(id + 8 * n, l + 4, l, matches);
              } else if (data[sOff + 2] === 110) {
                if (data[sOff + 3] === 32) addMatch(id + 45 * n, l + 4, l, matches);
              }
            } else if (data[sOff + 1] === 110) {
              if (data[sOff + 2] === 111 && data[sOff + 3] === 116 && data[sOff + 4] === 32) {
                addMatch(id + 80 * n, l + 5, l, matches);
              }
            } else if (data[sOff + 1] === 116) {
              if (data[sOff + 2] === 104) {
                if (data[sOff + 3] === 101) {
                  if (data[sOff + 4] === 32) addMatch(id + 5 * n, l + 5, l, matches);
                } else if (data[sOff + 3] === 97) {
                  if (data[sOff + 4] === 116 && data[sOff + 5] === 32) {
                    addMatch(id + 29 * n, l + 6, l, matches);
                  }
                }
              } else if (data[sOff + 2] === 111) {
                if (data[sOff + 3] === 32) addMatch(id + 17 * n, l + 4, l, matches);
              }
            } else if (data[sOff + 1] === 119) {
              if (data[sOff + 2] === 105 && data[sOff + 3] === 116 && data[sOff + 4] === 104 && data[sOff + 5] === 32) {
                addMatch(id + 35 * n, l + 6, l, matches);
              }
            }
          } else if (data[sOff] === 34) {
            addMatch(id + 19 * n, l + 1, l, matches);
            if (data[sOff + 1] === 62) {
              addMatch(id + 21 * n, l + 2, l, matches);
            }
          } else if (data[sOff] === 46) {
            addMatch(id + 20 * n, l + 1, l, matches);
            if (data[sOff + 1] === 32) {
              addMatch(id + 31 * n, l + 2, l, matches);
              if (data[sOff + 2] === 84 && data[sOff + 3] === 104) {
                if (data[sOff + 4] === 101) {
                  if (data[sOff + 5] === 32) addMatch(id + 43 * n, l + 6, l, matches);
                } else if (data[sOff + 4] === 105) {
                  if (data[sOff + 5] === 115 && data[sOff + 6] === 32) {
                    addMatch(id + 75 * n, l + 7, l, matches);
                  }
                }
              }
            }
          } else if (data[sOff] === 44) {
            addMatch(id + 76 * n, l + 1, l, matches);
            if (data[sOff + 1] === 32) {
              addMatch(id + 14 * n, l + 2, l, matches);
            }
          } else if (data[sOff] === 10) {
            addMatch(id + 22 * n, l + 1, l, matches);
            if (data[sOff + 1] === 9) {
              addMatch(id + 50 * n, l + 2, l, matches);
            }
          } else if (data[sOff] === 93) {
            addMatch(id + 24 * n, l + 1, l, matches);
          } else if (data[sOff] === 39) {
            addMatch(id + 36 * n, l + 1, l, matches);
          } else if (data[sOff] === 58) {
            addMatch(id + 51 * n, l + 1, l, matches);
          } else if (data[sOff] === 40) {
            addMatch(id + 57 * n, l + 1, l, matches);
          } else if (data[sOff] === 61) {
            if (data[sOff + 1] === 34) {
              addMatch(id + 70 * n, l + 2, l, matches);
            } else if (data[sOff + 1] === 39) {
              addMatch(id + 86 * n, l + 2, l, matches);
            }
          } else if (data[sOff] === 97) {
            if (data[sOff + 1] === 108 && data[sOff + 2] === 32) {
              addMatch(id + 84 * n, l + 3, l, matches);
            }
          } else if (data[sOff] === 101) {
            if (data[sOff + 1] === 100) {
              if (data[sOff + 2] === 32) addMatch(id + 53 * n, l + 3, l, matches);
            } else if (data[sOff + 1] === 114) {
              if (data[sOff + 2] === 32) addMatch(id + 82 * n, l + 3, l, matches);
            } else if (data[sOff + 1] === 115) {
              if (data[sOff + 2] === 116 && data[sOff + 3] === 32) {
                addMatch(id + 95 * n, l + 4, l, matches);
              }
            }
          } else if (data[sOff] === 102) {
            if (data[sOff + 1] === 117 && data[sOff + 2] === 108 && data[sOff + 3] === 32) {
              addMatch(id + 90 * n, l + 4, l, matches);
            }
          } else if (data[sOff] === 105) {
            if (data[sOff + 1] === 118) {
              if (data[sOff + 2] === 101 && data[sOff + 3] === 32) {
                addMatch(id + 92 * n, l + 4, l, matches);
              }
            } else if (data[sOff + 1] === 122) {
              if (data[sOff + 2] === 101 && data[sOff + 3] === 32) {
                addMatch(id + 100 * n, l + 4, l, matches);
              }
            }
          } else if (data[sOff] === 108) {
            if (data[sOff + 1] === 101) {
              if (data[sOff + 2] === 115 && data[sOff + 3] === 115 && data[sOff + 4] === 32) {
                addMatch(id + 93 * n, l + 5, l, matches);
              }
            } else if (data[sOff + 1] === 121) {
              if (data[sOff + 2] === 32) addMatch(id + 61 * n, l + 3, l, matches);
            }
          } else if (data[sOff] === 111) {
            if (data[sOff + 1] === 117 && data[sOff + 2] === 115 && data[sOff + 3] === 32) {
              addMatch(id + 106 * n, l + 4, l, matches);
            }
          }
        } else {
          // Set isAllCaps=0 for BROTLI_TRANSFORM_UPPERCASE_FIRST and isAllCaps=1 otherwise (BROTLI_TRANSFORM_UPPERCASE_ALL) transform
          const isAllCaps = dictWordTransform(w) !== TRANSFORM_TYPE_UPPERCASE_FIRST
                  if (!isMatch(data, pos, l, id, dictWordTransform(w), maxLength)) {
            continue;
          }
          // Transform "" + kUppercase{First,All} + ""
          addMatch(id + (isAllCaps ? TRANSFORM_IDX_UPPERCASE_ALL : TRANSFORM_IDX_UPPERCASE_FIRST) * n, l, l, matches);
          hasFoundMatch = true;
          if (l + 1 >= maxLength) {
            continue;
          }
          // Transforms "" + kUppercase{First,All} + <suffix>
          sOff = pos + l;
          if (data[sOff] === 32) {
            addMatch(id + (isAllCaps ? 68 : 4) * n, l + 1, l, matches);
          } else if (data[sOff] === 34) {
            addMatch(id + (isAllCaps ? 87 : 66) * n, l + 1, l, matches);
            if (data[sOff + 1] === 62) {
              addMatch(id + (isAllCaps ? 97 : 69) * n, l + 2, l, matches);
            }
          } else if (data[sOff] === 46) {
            addMatch(id + (isAllCaps ? 101 : 79) * n, l + 1, l, matches);
            if (data[sOff + 1] === 32) {
              addMatch(id + (isAllCaps ? 114 : 88) * n, l + 2, l, matches);
            }
          } else if (data[sOff] === 44) {
            addMatch(id + (isAllCaps ? 112 : 99) * n, l + 1, l, matches);
            if (data[sOff + 1] === 32) {
              addMatch(id + (isAllCaps ? 107 : 58) * n, l + 2, l, matches);
            }
          } else if (data[sOff] === 39) {
            addMatch(id + (isAllCaps ? 94 : 74) * n, l + 1, l, matches);
          } else if (data[sOff] === 40) {
            addMatch(id + (isAllCaps ? 113 : 78) * n, l + 1, l, matches);
          } else if (data[sOff] === 61) {
            if (data[sOff + 1] === 34) {
              addMatch(id + (isAllCaps ? 105 : 104) * n, l + 2, l, matches);
            } else if (data[sOff + 1] === 39) {
              addMatch(id + (isAllCaps ? 116 : 108) * n, l + 2, l, matches);
            }
          }
        }
      }
    }
    // Transforms with prefixes " " and "."
    if (maxLength >= 5 && (data[pos] === 32 || data[pos] === 46)) {
      const isSpace = (data[pos] === 32);
      let offset = buckets[hashDictionaryPrefix(data, pos + 1)];
      let end = offset === 0;
      while (!end) {
        const w = words[offset++];
        const l = dictWordLength(w);
        const n = 1 << SIZE_BITS_BY_LENGTH[l];
        const id = dictWordIndex(w);
        end = dictWordIsLast(w);
        if (dictWordTransform(w) === 0) {
                  if (!isMatch(data, pos + 1, l, id, dictWordTransform(w), maxLength - 1)) {
            continue;
          }
          // Transforms " " + BROTLI_TRANSFORM_IDENTITY + "" and "." + BROTLI_TRANSFORM_IDENTITY + ""
          addMatch(id + (isSpace ? 6 : 32) * n, l + 1, l, matches);
          hasFoundMatch = true;
          if (l + 2 >= maxLength) {
            continue;
          }
          // Transforms " " + BROTLI_TRANSFORM_IDENTITY + <suffix> and "." + BROTLI_TRANSFORM_IDENTITY + <suffix> 
          sOff = pos + l + 1;
          if (data[sOff] === 32) {
            addMatch(id + (isSpace ? 2 : 77) * n, l + 2, l, matches);
          } else if (data[sOff] === 40) {
            addMatch(id + (isSpace ? 89 : 67) * n, l + 2, l, matches);
          } else if (isSpace) {
            if (data[sOff] === 44) {
              addMatch(id + 103 * n, l + 2, l, matches);
              if (data[sOff + 1] === 32) {
                addMatch(id + 33 * n, l + 3, l, matches);
              }
            } else if (data[sOff] === 46) {
              addMatch(id + 71 * n, l + 2, l, matches);
              if (data[sOff + 1] === 32) {
                addMatch(id + 52 * n, l + 3, l, matches);
              }
            } else if (data[sOff] === 61) {
              if (data[sOff + 1] === 34) {
                addMatch(id + 81 * n, l + 3, l, matches);
              } else if (data[sOff + 1] === 39) {
                addMatch(id + 98 * n, l + 3, l, matches);
              }
            }
          }
        } else if (isSpace) {
          // Set isAllCaps=0 for BROTLI_TRANSFORM_UPPERCASE_FIRST and isAllCaps=1 otherwise (BROTLI_TRANSFORM_UPPERCASE_ALL) transform
          const isAllCaps = dictWordTransform(w) !== TRANSFORM_TYPE_UPPERCASE_FIRST
                  if (!isMatch(data, pos + 1, l, id, dictWordTransform(w), maxLength - 1)) {
            continue;
          }
          // Transforms " " + kUppercase{First,All} + ""
          addMatch(id + (isAllCaps ? 85 : 30) * n, l + 1, l, matches);
          hasFoundMatch = true;
          if (l + 2 >= maxLength) {
            continue;
          }
          // Transforms " " + kUppercase{First,All} + <suffix>
          sOff = pos + l + 1;
          if (data[sOff] === 32) {
            addMatch(id + (isAllCaps ? 83 : 15) * n, l + 2, l, matches);
          } else if (data[sOff] === 44) {
            if (!isAllCaps) {
              addMatch(id + 109 * n, l + 2, l, matches);
            }
            if (data[sOff + 1] === 32) {
              addMatch(id + (isAllCaps ? 111 : 65) * n, l + 3, l, matches);
            }
          } else if (data[sOff] === 46) {
            addMatch(id + (isAllCaps ? 115 : 96) * n, l + 2, l, matches);
            if (data[sOff + 1] === 32) {
              addMatch(id + (isAllCaps ? 117 : 91) * n, l + 3, l, matches);
            }
          } else if (data[sOff] === 61) {
            if (data[sOff + 1] === 34) {
              addMatch(id + (isAllCaps ? 110 : 118) * n, l + 3, l, matches);
            } else if (data[sOff + 1] === 39) {
              addMatch(id + (isAllCaps ? 119 : 120) * n, l + 3, l, matches);
            }
          }
        }
      }
    }
    if (maxLength >= 6) {
      // Transforms with prefixes "e ", "s ", ", " and "\xC2\xA0"
      if ((data[pos + 1] === 32 &&
           (data[pos] === 101 || data[pos] === 115 || data[pos] === 44)) ||
          (data[pos] === 0xC2 && data[pos + 1] === 0xA0)) {
        let offset = buckets[hashDictionaryPrefix(data, pos + 2)];
        let end = offset === 0;
        while (!end) {
          const w = words[offset++];
          const l = dictWordLength(w);
          const n = 1 << SIZE_BITS_BY_LENGTH[l];
          const id = dictWordIndex(w);
          end = dictWordIsLast(w);
          if (dictWordTransform(w) === 0 &&
              isMatch(data, pos + 2, l, id, dictWordTransform(w), maxLength - 2)) {
            if (data[pos] === 0xC2) {
              addMatch(id + 102 * n, l + 2, l, matches);
              hasFoundMatch = true;
            } else if (l + 2 < maxLength && data[pos + l + 2] === 32) {
              let t = data[pos] === 101 ? 18 : (data[pos] === 115 ? 7 : 13);
              addMatch(id + t * n, l + 3, l, matches);
              hasFoundMatch = true;
            }
          }
        }
      }
    }
    if (maxLength >= 9) {
      // Transforms with prefixes " the " and ".com/"
      if ((data[pos] === 32 && data[pos + 1] === 116 && data[pos + 2] === 104 &&
           data[pos + 3] === 101 && data[pos + 4] === 32) ||
          (data[pos] === 46 && data[pos + 1] === 99 && data[pos + 2] === 111 &&
           data[pos + 3] === 109 && data[pos + 4] === 47)) {
        let offset = buckets[hashDictionaryPrefix(data, pos + 5)];
        let end = offset === 0;
        while (!end) {
          const w = words[offset++];
          const l = dictWordLength(w);
          const n = 1 << SIZE_BITS_BY_LENGTH[l];
          const id = dictWordIndex(w);
          end = dictWordIsLast(w);
          if (dictWordTransform(w) === 0 &&
              isMatch(data, pos + 5, l, id, dictWordTransform(w), maxLength - 5)) {
            addMatch(id + (data[pos] === 32 ? 41 : 72) * n, l + 5, l, matches);
            hasFoundMatch = true;
            if (l + 5 < maxLength) {
              sOff = pos + l + 5;
              if (data[pos] === 32) {
                if (l + 8 < maxLength &&
                    data[sOff] === 32 && data[sOff + 1] === 111 && data[sOff + 2] === 102 && data[sOff + 3] === 32) {
                  addMatch(id + 62 * n, l + 9, l, matches);
                  if (l + 12 < maxLength &&
                      data[sOff + 4] === 116 && data[sOff + 5] === 104 && data[sOff + 6] === 101 && data[sOff + 7] === 32) {
                    addMatch(id + 73 * n, l + 13, l, matches);
                  }
                }
              }
            }
          }
        }
      }
    }

  return hasFoundMatch
}
