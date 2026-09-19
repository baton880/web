export function maintainLease(store, row) {
  let error = null
  let pending = null
  let timer = null
  if (row.lease_token && typeof store.renewLease === 'function') {
    const interval = Math.max(100, Math.floor((store.leaseMs || 60000) / 3))
    timer = setInterval(() => {
      if (pending || error) return
      pending = store.renewLease(row.id, row.lease_token)
        .catch(cause => { error = cause })
        .finally(() => { pending = null })
    }, interval)
  }
  return {
    async stop(requireOwnership = false) {
      if (timer) clearInterval(timer)
      await pending
      if (requireOwnership && error) throw error
    }
  }
}
