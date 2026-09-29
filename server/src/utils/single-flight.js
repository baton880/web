// Share only concurrent work. No time-based cache: late packets remain visible.
export function singleFlight() {
  const pending = new Map()
  return (key, run) => {
    if (pending.has(key)) return pending.get(key)
    const promise = Promise.resolve().then(run).finally(() => {
      if (pending.get(key) === promise) pending.delete(key)
    })
    pending.set(key, promise)
    return promise
  }
}
