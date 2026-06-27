import assert from 'node:assert/strict'

import prisma from '../src/database.js'
import { buildOrderViolations, recalculateBatchViolations } from '../src/modules/batches/batch-violations.js'
import { buildDigestHtml } from '../src/modules/digest/digest-scheduler.js'
import { collectReportData, toUiViolationStatus } from '../src/modules/reports/report-data.js'

function runCase(name, fn) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

runCase('correct sequence has no order violations', () => {
  const plan = [
    { id: 1, name: 'Комбикорм', sortOrder: 1 },
    { id: 2, name: 'Силос', sortOrder: 2 },
    { id: 3, name: 'Сено', sortOrder: 3 }
  ]
  const actual = [
    { id: 1, ingredientName: 'Комбикорм', actualWeight: 500, addedAt: '2026-06-27T10:00:00.000Z' },
    { id: 2, ingredientName: 'Силос', actualWeight: 300, addedAt: '2026-06-27T10:01:00.000Z' },
    { id: 3, ingredientName: 'Сено', actualWeight: 200, addedAt: '2026-06-27T10:02:00.000Z' }
  ]

  assert.deepEqual(buildOrderViolations(plan, actual), [])
})

runCase('swapped components create ORDER_MISMATCH', () => {
  const plan = [
    { id: 1, name: 'Комбикорм', sortOrder: 1 },
    { id: 2, name: 'Силос', sortOrder: 2 },
    { id: 3, name: 'Сено', sortOrder: 3 }
  ]
  const actual = [
    { id: 1, ingredientName: 'Комбикорм', actualWeight: 500, addedAt: '2026-06-27T10:00:00.000Z' },
    { id: 2, ingredientName: 'Сено', actualWeight: 200, addedAt: '2026-06-27T10:01:00.000Z' },
    { id: 3, ingredientName: 'Силос', actualWeight: 300, addedAt: '2026-06-27T10:02:00.000Z' }
  ]

  const violations = buildOrderViolations(plan, actual)

  assert.equal(violations.length, 2)
  assert.deepEqual(
    violations.map((item) => ({ ingredient: item.ingredient, plan: item.plan, fact: item.fact })),
    [
      { ingredient: 'Сено', plan: 3, fact: 2 },
      { ingredient: 'Силос', plan: 2, fact: 3 }
    ]
  )
})

runCase('extra components do not break order validation', () => {
  const plan = [
    { id: 1, name: 'Комбикорм', sortOrder: 1 },
    { id: 2, name: 'Силос', sortOrder: 2 }
  ]
  const actual = [
    { id: 1, ingredientName: 'Комбикорм', actualWeight: 500, addedAt: '2026-06-27T10:00:00.000Z' },
    { id: 2, ingredientName: 'Лишний корм', actualWeight: 50, addedAt: '2026-06-27T10:01:00.000Z' },
    { id: 3, ingredientName: 'Силос', actualWeight: 300, addedAt: '2026-06-27T10:02:00.000Z' }
  ]

  assert.deepEqual(buildOrderViolations(plan, actual), [])
})

runCase('starting from a later component is still an order violation', () => {
  const plan = [
    { id: 1, name: 'Солома', sortOrder: 1 },
    { id: 2, name: 'Люцерна', sortOrder: 2 },
    { id: 3, name: 'Комбикорм', sortOrder: 3 },
    { id: 4, name: 'Силос', sortOrder: 4 }
  ]
  const actual = [
    { id: 1, ingredientName: 'Комбикорм', actualWeight: 500, addedAt: '2026-06-27T10:00:00.000Z' },
    { id: 2, ingredientName: 'Силос', actualWeight: 300, addedAt: '2026-06-27T10:01:00.000Z' }
  ]

  const violations = buildOrderViolations(plan, actual)

  assert.equal(violations.length, 2)
  assert.deepEqual(
    violations.map((item) => ({ ingredient: item.ingredient, plan: item.plan, fact: item.fact })),
    [
      { ingredient: 'Комбикорм', plan: 3, fact: 1 },
      { ingredient: 'Силос', plan: 4, fact: 2 }
    ]
  )
})

runCase('ORDER_MISMATCH is critical for alert status', () => {
  const status = toUiViolationStatus({
    code: 'ORDER_MISMATCH',
    status: 'OPEN',
    deviationPercent: 0
  })

  assert.equal(status, 'critical')
})

runCase('digest shows positions instead of kilograms for order mismatch', () => {
  const html = buildDigestHtml(
    {
      enabled: true,
      timezone: 'Asia/Novosibirsk',
      sendTime: '08:00'
    },
    {
      batches: [
        { id: 77, violationsCount: 1 }
      ],
      violations: [
        {
          batchId: 77,
          batchLabel: 'Замес #77',
          groupName: 'Дойные базовые',
          component: 'Силос',
          type: 'Нарушен порядок загрузки',
          code: 'ORDER_MISMATCH',
          plan: 2,
          fact: 3,
          deviation: 1
        }
      ]
    },
    new Date('2026-06-27T10:05:00.000Z')
  )

  assert.match(html, /Нарушен порядок загрузки/)
  assert.match(html, /#2/)
  assert.match(html, /#3/)
  assert.match(html, /Порядок/)
})

await (async function runReportIntegrationCase() {
  const stamp = Date.now()
  const rationName = `__order_report_ration_${stamp}`
  const groupName = `__order_report_group_${stamp}`
  const batchStartTime = new Date('2026-06-27T11:00:00.000Z')

  let ration = null
  let group = null
  let batch = null

  try {
    ration = await prisma.ration.create({
      data: {
        name: rationName,
        isActive: true,
        ingredients: {
          create: [
            { name: 'alpha', sortOrder: 1, plannedWeight: 10, dryMatterWeight: 0 },
            { name: 'beta', sortOrder: 2, plannedWeight: 10, dryMatterWeight: 0 },
            { name: 'gamma', sortOrder: 3, plannedWeight: 10, dryMatterWeight: 0 }
          ]
        }
      }
    })

    group = await prisma.livestockGroup.create({
      data: {
        name: groupName,
        headcount: 1,
        rationId: ration.id
      }
    })

    batch = await prisma.batch.create({
      data: {
        deviceId: `__order_report_device_${stamp}`,
        rationId: ration.id,
        groupId: group.id,
        startTime: batchStartTime,
        actualIngredients: {
          create: [
            { ingredientName: 'alpha', actualWeight: 10, addedAt: new Date('2026-06-27T11:00:00.000Z') },
            { ingredientName: 'gamma', actualWeight: 10, addedAt: new Date('2026-06-27T11:01:00.000Z') },
            { ingredientName: 'beta', actualWeight: 10, addedAt: new Date('2026-06-27T11:02:00.000Z') }
          ]
        }
      }
    })

    await recalculateBatchViolations(prisma, batch.id, { percentThreshold: 10, minDeviationKg: 1 })

    const reportData = await collectReportData({
      fromDate: new Date('2026-06-27T00:00:00.000Z'),
      toDate: new Date('2026-06-27T23:59:59.999Z'),
      limit: 50
    })

    const reportViolations = reportData.violations.filter((item) => item.batchId === batch.id && item.code === 'ORDER_MISMATCH')

    assert.equal(reportViolations.length, 2, 'collectReportData should expose both order violations')
    assert.ok(reportViolations.every((item) => item.status === 'critical'))
    assert.ok(reportData.summary.counts.violationsCritical >= 2)
  } finally {
    if (batch?.id) {
      await prisma.violation.deleteMany({ where: { batchId: batch.id } })
      await prisma.batchIngredient.deleteMany({ where: { batchId: batch.id } })
      await prisma.batch.delete({ where: { id: batch.id } })
    }
    if (group?.id) {
      await prisma.livestockGroup.delete({ where: { id: group.id } })
    }
    if (ration?.id) {
      await prisma.ration.delete({ where: { id: ration.id } })
    }
  }

  console.log('PASS report integration exposes ORDER_MISMATCH')
})().catch((error) => {
  console.error('FAIL report integration exposes ORDER_MISMATCH')
  throw error
})

console.log('PASS order alerts suite')
