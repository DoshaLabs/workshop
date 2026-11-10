import type { CoreApi } from './index'

declare global {
  interface Window {
    core: CoreApi
  }
}
