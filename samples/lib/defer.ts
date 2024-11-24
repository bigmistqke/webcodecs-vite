export function defer<T = void>(): Defer<T> {
  let resolvePromise: (value: T) => void = null!
  let resolved = false
  const promise = new Promise<T>(_resolve => (resolvePromise = _resolve))
  function resolve(value: T) {
    resolved = true
    return resolvePromise(value)
  }
  return { promise, resolve, resolved }
}
export type Defer<T> = { promise: Promise<T>; resolve: (value: T) => void; resolved: boolean }
