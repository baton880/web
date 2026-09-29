// Preserve the tablet response contract; packet weight is already filtered.
export const REALTIME_WEIGHT_FILTER = Object.freeze({ source: 'weight', causal: true, roundToKg: 5 })
export function filterRealtimeWeightSeries(rows = []) {
  const points = rows.map((row, index) => ({ row, index, at: new Date(row.timestamp).getTime() }))
    .filter(item => Number.isFinite(item.at)).sort((a,b) => a.at-b.at || a.index-b.index)
    .map(({row}) => {
      const v = row.weight
      const weight = v === null || v === undefined || v === '' ? NaN : Number(v)
      const valid = row.weightValid !== false && row.weightValid !== 0 && Number.isFinite(weight)
      return {...row, realtimeWeight: valid ? Math.round(weight/5)*5 : null,
        source: valid ? 'weight' : null, sampleCount: valid ? 1 : 0}
    })
  return {points, latest: points.at(-1) || null, options: REALTIME_WEIGHT_FILTER}
}
