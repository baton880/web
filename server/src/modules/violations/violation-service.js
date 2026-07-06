import { normalizeIngredientName } from '../../../../module-2/rationManager.js'
import { roundWeight } from '../../../../module-2/weightRounding.js'

function toViolationDescriptor(violation) {
  const plan = Number(violation?.plan || 0)
  const fact = Number(violation?.fact || 0)
  const deviation = fact - plan
  const deviationPercent = plan > 0
    ? Math.round(((deviation / plan) * 100) * 10) / 10
    : (fact > 0 ? 100 : 0)

  if (violation?.code === 'STRAW_ALFALFA_RATIO_MISMATCH') {
    return {
      code: 'STRAW_ALFALFA_RATIO_MISMATCH',
      title: 'Сол.+Люц.',
      message: violation.message || 'Общая масса соломы и люцерны в допуске, но пропорция между ними нарушена',
      deviation,
      deviationPercent: Number.isFinite(Number(violation.deviationPercent))
        ? Number(violation.deviationPercent)
        : deviationPercent
    }
  }

  if (violation?.code === 'STRAW_ALFALFA_TOTAL_MISMATCH') {
    return {
      code: 'STRAW_ALFALFA_TOTAL_MISMATCH',
      title: 'Сол.+Люц.',
      message: violation.message || 'Нарушена общая масса соломы и люцерны',
      deviation,
      deviationPercent: Number.isFinite(Number(violation.deviationPercent))
        ? Number(violation.deviationPercent)
        : deviationPercent
    }
  }

  if (violation?.code === 'ORDER_MISMATCH') {
    return {
      code: 'ORDER_MISMATCH',
      title: 'Нарушен порядок загрузки',
      message: violation.message || `Компонент ${violation.ingredient} загружен не по порядку`,
      deviation,
      deviationPercent: 0
    }
  }

  if (plan > 0 && fact === 0) {
    return {
      code: 'MISSING_COMPONENT',
      title: 'Пропуск компонента',
      message: `Не загружен плановый компонент ${violation.ingredient}`,
      deviation,
      deviationPercent
    }
  }

  if (plan === 0 && fact > 0) {
    return {
      code: 'EXTRA_COMPONENT',
      title: 'Лишний компонент',
      message: `Загружен компонент вне плана: ${violation.ingredient}`,
      deviation,
      deviationPercent
    }
  }

  if (deviation > 0) {
    return {
      code: 'OVERWEIGHT_COMPONENT',
      title: 'Перевложение',
      message: `Компонент ${violation.ingredient} загружен с перевесом`,
      deviation,
      deviationPercent
    }
  }

  return {
    code: 'UNDERWEIGHT_COMPONENT',
    title: 'Недовложение',
    message: `Компонент ${violation.ingredient} загружен с недовесом`,
    deviation,
    deviationPercent
  }
}

function buildComponentKey(name) {
  return normalizeIngredientName(name || '')
}

export async function syncBatchViolationLog(db, batch, checkResult, detectedAt = new Date()) {
  if (!batch?.id) {
    return { activeCount: 0 }
  }
  const defaultWorkflowStatus = batch.endTime ? 'OPEN' : 'IN_PROGRESS'

  const existing = await db.violation.findMany({
    where: {
      batchId: batch.id,
      category: 'BUSINESS'
    },
    select: {
      id: true,
      code: true,
      componentKey: true,
      status: true
    }
  })

  const existingMap = new Map(
    existing.map((item) => [`${item.code}:${item.componentKey}`, item])
  )
  const activeKeys = new Set()

  for (const violation of checkResult.violations || []) {
    const descriptor = toViolationDescriptor(violation)
    const componentKey = buildComponentKey(violation.ingredient)
    const compositeKey = `${descriptor.code}:${componentKey}`
    const existingItem = existingMap.get(compositeKey)
    activeKeys.add(compositeKey)

    await db.violation.upsert({
      where: {
        batchId_code_componentKey: {
          batchId: batch.id,
          code: descriptor.code,
          componentKey
        }
      },
      update: {
        deviceId: batch.deviceId,
        title: descriptor.title,
        componentName: violation.ingredient || null,
        message: descriptor.message,
        category: 'BUSINESS',
        planWeight: roundWeight(violation.plan),
        actualWeight: roundWeight(violation.fact),
        deviation: roundWeight(descriptor.deviation),
        deviationPercent: descriptor.deviationPercent,
        detectedAt,
        resolvedAt: null,
        status: existingItem?.status === 'CLOSED'
          ? 'CLOSED'
          : defaultWorkflowStatus
      },
      create: {
        batchId: batch.id,
        deviceId: batch.deviceId,
        code: descriptor.code,
        title: descriptor.title,
        componentKey,
        componentName: violation.ingredient || null,
        message: descriptor.message,
        category: 'BUSINESS',
        status: defaultWorkflowStatus,
        planWeight: roundWeight(violation.plan),
        actualWeight: roundWeight(violation.fact),
        deviation: roundWeight(descriptor.deviation),
        deviationPercent: descriptor.deviationPercent,
        detectedAt
      }
    })
  }

  for (const item of existing) {
    const compositeKey = `${item.code}:${item.componentKey}`
    if (activeKeys.has(compositeKey)) {
      continue
    }

    const nextStatus = item.status === 'CLOSED' ? 'CLOSED' : 'RESOLVED'
    await db.violation.update({
      where: { id: item.id },
      data: {
        status: nextStatus,
        resolvedAt: detectedAt
      }
    })
  }

  return { activeCount: activeKeys.size }
}

export async function recordLeftoverViolation(db, { batchId, deviceId, leftoverWeight, detectedAt = new Date() }) {
  if (!batchId) {
    return null
  }

  return db.violation.upsert({
    where: {
      batchId_code_componentKey: {
        batchId,
        code: 'LEFTOVER_WEIGHT',
        componentKey: '__leftover__'
      }
    },
    update: {
      deviceId,
      title: 'Остаток после выгрузки',
      componentName: 'Остаток',
      message: `После выгрузки осталось ${roundWeight(leftoverWeight)} кг`,
      category: 'LEFTOVER',
      actualWeight: roundWeight(leftoverWeight),
      detectedAt,
      resolvedAt: null,
      status: 'OPEN'
    },
    create: {
      batchId,
      deviceId,
      code: 'LEFTOVER_WEIGHT',
      title: 'Остаток после выгрузки',
      componentKey: '__leftover__',
      componentName: 'Остаток',
      message: `После выгрузки осталось ${roundWeight(leftoverWeight)} кг`,
      category: 'LEFTOVER',
      status: 'OPEN',
      actualWeight: roundWeight(leftoverWeight),
      detectedAt
    }
  })
}
