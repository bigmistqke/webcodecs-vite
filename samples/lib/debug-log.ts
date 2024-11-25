const ENABLE_DEBUG_LOGGING = false

export function debugLog(...msg: Array<unknown>) {
  if (!ENABLE_DEBUG_LOGGING) {
    return
  }
  console.debug(msg)
}
