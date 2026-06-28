import assert from 'node:assert/strict'

import prisma from '../src/database.js'
import { buildOrderViolations, recalculateBatchViolations } from '../src/modules/batches/batch-violations.js'
import { calculatePlan } from '../../module-2/rationManager.js'
import { buildDigestHtml } from '../src/modules/digest/digest-scheduler.js'
import { buildDailyDeviationRows } from '../../frontend/js/report-export-utils.mjs'
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

function todayAt(hours, minutes = 0) {
  const date = new Date()
  date.setHours(hours, minutes, 0, 0)
  return date
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000)
}

function todayReportPeriod() {
  const fromDate = new Date()
  fromDate.setHours(0, 0, 0, 0)

  const toDate = new Date()
  toDate.setHours(23, 59, 59, 999)

  return { fromDate, toDate }
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

runCase('daily ration weights are divided by feedings per day', () => {
  const plan = calculatePlan(
    [
      { name: 'silage', sortOrder: 1, plannedWeight: 12, dryMatterWeight: 4 },
      { name: 'grain', sortOrder: 2, plannedWeight: 6, dryMatterWeight: 2 }
    ],
    10,
    3
  )

  assert.equal(plan.feedingsPerDay, 3)
  assert.equal(plan.totalBatchWeight, 60)
  assert.deepEqual(
    plan.ingredients.map((item) => ({
      name: item.name,
      targetWeight: item.targetWeight,
      dailyTargetWeight: item.dailyTargetWeight
    })),
    [
      { name: 'silage', targetWeight: 40, dailyTargetWeight: 120 },
      { name: 'grain', targetWeight: 20, dailyTargetWeight: 60 }
    ]
  )
})

runCase('daily deviation rows sum multiple batches per day', () => {
  const rows = buildDailyDeviationRows([
    {
      date: '2026-06-27T08:00:00.000Z',
      rationName: 'Дойные',
      groupName: 'Группа 1',
      component: 'Силос',
      plan: 50,
      fact: 48
    },
    {
      date: '2026-06-27T15:00:00.000Z',
      rationName: 'Дойные',
      groupName: 'Группа 1',
      component: 'Силос',
      plan: 50,
      fact: 53
    },
    {
      date: '2026-06-28T08:00:00.000Z',
      rationName: 'Дойные',
      groupName: 'Группа 1',
      component: 'Силос',
      plan: 50,
      fact: 50
    }
  ])

  assert.deepEqual(rows[1], [
    '2026-06-27',
    'Дойные',
    'Группа 1',
    'Силос',
    100,
    101,
    1
  ])
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
  const batchStartTime = todayAt(11)

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
            { ingredientName: 'alpha', actualWeight: 10, addedAt: batchStartTime },
            { ingredientName: 'gamma', actualWeight: 10, addedAt: addMinutes(batchStartTime, 1) },
            { ingredientName: 'beta', actualWeight: 10, addedAt: addMinutes(batchStartTime, 2) }
          ]
        }
      }
    })

    await recalculateBatchViolations(prisma, batch.id, { percentThreshold: 10, minDeviationKg: 1 })

    const reportData = await collectReportData({
      ...todayReportPeriod(),
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

await (async function runFeedingsReportIntegrationCase() {
  const stamp = Date.now()
  const rationName = `__feedings_report_ration_${stamp}`
  const groupName = `__feedings_report_group_${stamp}`
  const batchStartTime = todayAt(12)

  let ration = null
  let group = null
  let batch = null

  try {
    ration = await prisma.ration.create({
      data: {
        name: rationName,
        feedingsPerDay: 2,
        isActive: true,
        ingredients: {
          create: [
            { name: 'daily-silage', sortOrder: 1, plannedWeight: 10, dryMatterWeight: 0 }
          ]
        }
      }
    })

    group = await prisma.livestockGroup.create({
      data: {
        name: groupName,
        headcount: 10,
        rationId: ration.id
      }
    })

    batch = await prisma.batch.create({
      data: {
        deviceId: `__feedings_report_device_${stamp}`,
        rationId: ration.id,
        groupId: group.id,
        startTime: batchStartTime,
        actualIngredients: {
          create: [
            { ingredientName: 'daily-silage', actualWeight: 50, addedAt: batchStartTime }
          ]
        }
      }
    })

    await recalculateBatchViolations(prisma, batch.id, { percentThreshold: 10, minDeviationKg: 1 })

    const reportData = await collectReportData({
      ...todayReportPeriod(),
      limit: 50
    })
    const componentRow = reportData.components.find((item) => (
      item.batchId === batch.id && item.component === 'daily-silage'
    ))

    assert.ok(componentRow, 'collectReportData should expose the feedings test component')
    assert.equal(componentRow.feedingsPerDay, 2)
    assert.equal(componentRow.plan, 50)
    assert.equal(componentRow.fact, 50)
    assert.equal(componentRow.deviation, 0)
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

  console.log('PASS report integration divides daily ration by feedings')
})().catch((error) => {
  console.error('FAIL report integration divides daily ration by feedings')
  throw error
})

console.log('PASS order alerts suite')
