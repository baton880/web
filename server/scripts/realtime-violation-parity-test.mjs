import assert from 'node:assert/strict'

import prisma from '../src/database.js'
import { recalculateBatchViolations } from '../src/modules/batches/batch-violations.js'
import { recordLeftoverViolation } from '../src/modules/violations/violation-service.js'
import { collectReportData } from '../src/modules/reports/report-data.js'

const stamp = Date.now()
const names = {
  first: `__rt_first_${stamp}`,
  second: `__rt_second_${stamp}`,
  third: `__rt_third_${stamp}`
}
let ration
let group
let batch

try {
  ration = await prisma.ration.create({
    data: {
      name: `__rt_violation_ration_${stamp}`,
      feedingsPerDay: 1,
      ingredients: {
        create: [
          { name: names.first, sortOrder: 1, plannedWeight: 100, dryMatterWeight: 0 },
          { name: names.second, sortOrder: 2, plannedWeight: 200, dryMatterWeight: 0 },
          { name: names.third, sortOrder: 3, plannedWeight: 100, dryMatterWeight: 0 }
        ]
      }
    }
  })
  group = await prisma.livestockGroup.create({
    data: { name: `__rt_violation_group_${stamp}`, headcount: 1, rationId: ration.id }
  })
  const startedAt = new Date('2026-10-02T01:00:00.000Z')
  batch = await prisma.batch.create({
    data: {
      deviceId: `__rt_violation_device_${stamp}`,
      processingMode: 'realtime-v1',
      rationId: ration.id,
      groupId: group.id,
      startTime: startedAt,
      endTime: new Date(startedAt.getTime() + 4 * 60_000),
      actualIngredients: {
        create: [
          { ingredientName: names.third, actualWeight: 100, addedAt: new Date(startedAt.getTime() + 60_000) },
          { ingredientName: names.second, plannedWeight: 200, actualWeight: 200, tabletTaskId: `__rt_task_${stamp}`,
            algorithmWeight: 205, algorithmIngredientName: names.second, verificationStatus: 'confirmed',
            verificationReason: 'host_algorithm_match', addedAt: new Date(startedAt.getTime() + 120_000) },
          { ingredientName: 'unknown', actualWeight: 1000, addedAt: new Date(startedAt.getTime() + 180_000) }
        ]
      }
    },
    include: { actualIngredients: true }
  })
  const originalFacts = batch.actualIngredients.map(row => [row.id, row.ingredientName, Number(row.actualWeight)])
  await recordLeftoverViolation(prisma, {
    batchId: batch.id,
    deviceId: batch.deviceId,
    leftoverWeight: 75,
    detectedAt: batch.endTime
  })

  const result = await recalculateBatchViolations(prisma, batch.id)
  assert.equal(result.hasViolations, true)

  const stored = await prisma.violation.findMany({
    where: { batchId: batch.id, status: { in: ['OPEN', 'IN_PROGRESS'] } },
    orderBy: { code: 'asc' }
  })
  assert.deepEqual(
    stored.map(row => row.code).sort(),
    ['EXTRA_COMPONENT', 'LEFTOVER_WEIGHT', 'MISSING_COMPONENT', 'ORDER_MISMATCH']
  )
  assert.equal(stored.find(row => row.code === 'EXTRA_COMPONENT')?.source, 'system')
  assert.equal(stored.find(row => row.code === 'LEFTOVER_WEIGHT')?.category, 'LEFTOVER')
  const order = stored.find(row => row.code === 'ORDER_MISMATCH')
  assert.equal(order?.planWeight, 2, 'order plan stores a position, not a rounded weight')
  assert.equal(order?.actualWeight, 3, 'order fact stores a position, not a rounded weight')

  const refreshed = await prisma.batch.findUnique({
    where: { id: batch.id },
    include: { actualIngredients: { orderBy: { id: 'asc' } } }
  })
  assert.equal(refreshed.hasViolations, true, 'a business recalculation must preserve the leftover flag')
  assert.deepEqual(
    refreshed.actualIngredients.map(row => [row.id, row.ingredientName, Number(row.actualWeight)]),
    originalFacts.sort((left, right) => left[0] - right[0]),
    'derived violation updates must not alter facts'
  )

  const report = await collectReportData({
    fromDate: new Date('2026-10-02T00:00:00.000Z'),
    toDate: new Date('2026-10-02T23:59:59.999Z'),
    limit: 1000
  })
  const reportBatch = report.batches.find(row => row.id === batch.id)
  const reportComponent = report.components.find(row => row.batchId === batch.id && row.component === names.second)
  assert.equal(reportBatch?.factTotal, 1305, 'report total uses the accepted algorithm weight')
  assert.equal(reportComponent?.fact, 205, 'report component uses the accepted algorithm weight')

  console.log('PASS realtime violation parity: missing, extra/unknown, order and leftover')
} finally {
  if (batch?.id) {
    await prisma.violation.deleteMany({ where: { batchId: batch.id } })
    await prisma.batchIngredient.deleteMany({ where: { batchId: batch.id } })
    await prisma.batch.delete({ where: { id: batch.id } })
  }
  if (group?.id) await prisma.livestockGroup.delete({ where: { id: group.id } })
  if (ration?.id) await prisma.ration.delete({ where: { id: ration.id } })
  await prisma.$disconnect()
}
