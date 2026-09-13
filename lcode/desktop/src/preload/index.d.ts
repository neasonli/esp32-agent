import type { LCodeApi } from '../shared/types'

declare global {
  interface Window {
    lcode: LCodeApi
  }
}

export {}
