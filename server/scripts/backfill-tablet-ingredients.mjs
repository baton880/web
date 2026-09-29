import prisma, { databaseReady } from '../src/database.js'
import { findTabletTaskForBatch } from '../src/modules/batches/tablet-ingredients.js'
import { postprocessCompletedBatch } from '../src/modules/batches/batch-postprocess-service.js'
import { getTelemetrySettings } from '../src/modules/telemetry/telemetry-settings.js'

await databaseReady
const apply = process.argv.includes('--apply')
try {
  if (!prisma.loaderTask) throw new Error('Backfill requires PostgreSQL loader tasks')
  const oldest = await prisma.loaderTask.findFirst({ where: { status: 'completed' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
  if (!oldest) {
    console.log('No completed tablet tasks')
  } else {
    const batches = await prisma.batch.findMany({
      where: { endTime: { not: null }, startTime: { gte: new Date(Number(oldest.createdAt) - 180000) } },
      select: { id: true, deviceId: true, groupId: true, rationId: true, startTime: true, endTime: true, actualIngredients: { select: { tabletTaskId: true } } },
      orderBy: { startTime: 'asc' }
    })
    const settings = apply ? await getTelemetrySettings(prisma) : null
    for (const batch of batches) {
      const task = await findTabletTaskForBatch(prisma, batch)
      if (!task || batch.actualIngredients.some(row => row.tabletTaskId === task.id)) continue
      console.log(`${batch.id}: ${task.id} ${task.steps.map(step => `${step.name} ${step.actualKg} кг`).join(', ')}`)
      if (!apply) continue
      const result = await postprocessCompletedBatch(prisma, batch.id, settings, { persist: true })
      if (result.status !== 'complete' || result.tabletTaskId !== task.id) throw new Error(`Batch ${batch.id}: tablet task changed during backfill`)
    }
  }
} finally {
  await prisma.$disconnect()
}
