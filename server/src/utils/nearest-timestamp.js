// Build once for an immutable series. Equal distances retain the original row order.
export function nearestTimestampIndex(rows) {
  const firstAtTime = new Map()
  rows.forEach((row, order) => {
    const time = new Date(row.timestamp).getTime()
    if (Number.isFinite(time) && !firstAtTime.has(time)) firstAtTime.set(time, { time, row, order })
  })
  const points = [...firstAtTime.values()].sort((a, b) => a.time - b.time)
  return time => {
    if (!Number.isFinite(time) || !points.length) return null
    let low = 0, high = points.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (points[mid].time < time) low = mid + 1
      else high = mid
    }
    const right = points[low], left = points[low - 1]
    if (!left) return right.row
    if (!right) return left.row
    const dl = time - left.time, dr = right.time - time
    return (dl < dr || (dl === dr && left.order < right.order) ? left : right).row
  }
}
