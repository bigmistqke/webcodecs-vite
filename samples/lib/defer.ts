export function defer<T = void>(): Defer<T> {
  let resolvePromise: (value: T) => void = null!
  let resolved = false
  const promise = new Promise<T>(_resolve => (resolvePromise = _resolve))
  function resolve(value: T) {
    if (!resolved) {
      resolved = true
      resolvePromise(value)
    }
  }
  return {
    promise,
    resolve,
    get resolved() {
      return resolved
    },
  }
}
export type Defer<T = void> = {
  promise: Promise<T>
  resolve: (value: T) => void
  resolved: boolean
}
