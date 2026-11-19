// The static dictionary, in the form the encoder core accepts

import { searchInStaticDictionary } from './static-dict-fast'
import { findAllStaticDictionaryMatches } from './static-dict'
import type { StaticDictionary } from './static-dict-types'

export const STATIC_DICTIONARY: StaticDictionary = {
  search: searchInStaticDictionary,
  findAll: findAllStaticDictionaryMatches,
}
