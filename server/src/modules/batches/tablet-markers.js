// Tablet button times are independent of telemetry packet/receipt times.
export function buildTabletMarkers(tasks, events, startMs, endMs) {
  const states = new Map(tasks.map(task => [task.id, JSON.parse(task.state)]))
  const markers = []
  const begun = new Set()
  for (const row of events) {
    const event = JSON.parse(row.payload)
    const task = states.get(row.taskId)
    if (!task || event.type !== 'begin') continue
    const first = !begun.has(row.taskId)
    begun.add(row.taskId)
    const at = Number(event.at)
    if (!Number.isFinite(at) || at < startMs || at > endMs) continue
    const stepIndex = Number.isInteger(event.stepIndex) ? event.stepIndex : 0
    const name = task.steps?.[stepIndex]?.name || `Компонент ${stepIndex + 1}`
    const common = { taskId: row.taskId, eventId: event.id, timestamp: new Date(at).toISOString(), stepIndex, groupName: task.groupName || '' }
    if (first) markers.push({ ...common, kind: 'batch-start', label: 'Старт замеса с планшета' })
    markers.push({ ...common, kind: 'component-start', label: `Начало: ${name}` })
  }
  return markers.sort((a,b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
}

export async function getTabletMarkers(prisma, batch) {
  if (!prisma.loaderTask || !prisma.loaderTaskEvent) return [] // Legacy SQLite fixtures have a separate task store.
  const startMs = new Date(batch.startTime).getTime() - 180000
  const endMs = new Date(batch.endTime || Date.now()).getTime() + 180000
  const tasks = await prisma.loaderTask.findMany({ where: { deviceId: batch.deviceId, createdAt: { lte: BigInt(endMs) } }, select: { id: true, state: true } })
  if (!tasks.length) return []
  const events = await prisma.loaderTaskEvent.findMany({ where: { taskId: { in: tasks.map(t => t.id) } }, orderBy: [{ taskId: 'asc' }, { revision: 'asc' }], select: { taskId: true, payload: true } })
  return buildTabletMarkers(tasks, events, startMs, endMs)
}
