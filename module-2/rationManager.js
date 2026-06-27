export function normalizeIngredientName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function areSameIngredient(left, right) {
  return normalizeIngredientName(left) === normalizeIngredientName(right);
}

/**
 * Рассчитывает план замеса рациона на группу коров
 * @param {Array} parsedRation - Массив ингредиентов с нормами на 1 голову
 * @param {number} headcount - Количество голов в группе
 * @returns {Object} Объект с общими и целевыми весами
 */
export function calculatePlan(parsedRation, headcount) {
  // 1. Базовая защита от некорректных данных
  if (!Array.isArray(parsedRation) || typeof headcount !== 'number' || headcount <= 0) {
    return { totalBatchWeight: 0, totalDryMatterWeight: 0, ingredients: [] };
  }

  const orderedRation = parsedRation
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
    const leftOrder = Number(left.item?.sortOrder || left.index + 1);
    const rightOrder = Number(right.item?.sortOrder || right.index + 1);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.index - right.index;
  })
    .map((entry) => entry.item);

  let totalBatchWeight = 0;
  let totalDryMatterWeight = 0;
  const ingredients = [];

  // 2. Проходим по каждому ингредиенту и считаем замес
  for (const item of orderedRation) {
    const targetWeight = item.plannedWeight * headcount;
    const targetDryMatter = Number(item.dryMatterWeight || 0) * headcount;

    // Суммируем общие показатели
    totalBatchWeight += targetWeight;
    totalDryMatterWeight += targetDryMatter;

    // Формируем объект ингредиента для результата
    ingredients.push({
      name: item.name,
      sortOrder: Number(item.sortOrder || ingredients.length + 1),
      targetWeight: targetWeight,
      targetDryMatter: targetDryMatter,
      isCompound: Boolean(item.isCompound),
      componentsJson: item.componentsJson || null,
      components: Array.isArray(item.components) ? item.components : undefined
    });
  }

  // 3. Возвращаем итоговый объект
  return {
    totalBatchWeight,
    totalDryMatterWeight,
    ingredients
  };
}


function resolveViolationThresholds(thresholdOrOptions = 10, minDeviationKg = 0) {
  if (thresholdOrOptions && typeof thresholdOrOptions === 'object') {
    const percentRaw = Number(
      thresholdOrOptions.percentThreshold
      ?? thresholdOrOptions.deviationPercentThreshold
      ?? thresholdOrOptions.threshold
      ?? 10
    );
    const minKgRaw = Number(
      thresholdOrOptions.minDeviationKg
      ?? thresholdOrOptions.deviationMinKgThreshold
      ?? thresholdOrOptions.minKg
      ?? 0
    );

    return {
      percentThreshold: Number.isFinite(percentRaw) && percentRaw > 0 ? percentRaw : 10,
      minDeviationKg: Number.isFinite(minKgRaw) && minKgRaw > 0 ? minKgRaw : 0
    };
  }

  const percentRaw = Number(thresholdOrOptions);
  const minKgRaw = Number(minDeviationKg);

  return {
    percentThreshold: Number.isFinite(percentRaw) && percentRaw > 0 ? percentRaw : 10,
    minDeviationKg: Number.isFinite(minKgRaw) && minKgRaw > 0 ? minKgRaw : 0
  };
}

/**
 * Сравнивает идеальный план с тем, что реально насыпал тракторист
 * @param {Array} planArr - Массив ингредиентов из calculatePlan
 * @param {Array} factArr - Массив фактических загрузок
 * @param {number|object} thresholdOrOptions - Допустимое отклонение (процент или объект настроек)
 * @param {number} minDeviationKg - Минимальное отклонение в кг (используется только с числовым третьим аргументом)
 * @returns {Object} { matches: [], violations: [] }
 */
export function checkViolations(planArr, factArr, thresholdOrOptions = 10, minDeviationKg = 0) {
  const { percentThreshold, minDeviationKg: minDeviationKgValue } = resolveViolationThresholds(thresholdOrOptions, minDeviationKg);
  const result = {
    matches: [],
    violations: []
  };

  // Создаем карту плановых ингредиентов для быстрого поиска по нормализованному имени
  const planMap = new Map();
  planArr.forEach(item => {
    planMap.set(normalizeIngredientName(item.name), item);
  });

  const loadedKeys = new Set();

  // Проходим по всем фактическим загрузкам
  factArr.forEach(factItem => {
    const factKey = normalizeIngredientName(factItem.name);
    const planItem = planMap.get(factKey);
    loadedKeys.add(factKey);
    
    // Если компонента нет в плане (или это Unknown)
    if (!planItem || factKey === 'unknown') {
      // Это нарушение - загружен компонент вне плана
      result.violations.push({
        ingredient: factItem.name,
        plan: 0,
        fact: factItem.actualWeight,
        deviationPercent: 100,
        message: 'Загружен нераспознанный компонент вне зон'
      });
      return;
    }

    // Рассчитываем отклонение
    const planWeight = planItem.targetWeight || planItem.plannedWeight;
    const factWeight = factItem.actualWeight;
    
    // Формула: ((факт - план) / план) * 100
    const deviationPercent = ((factWeight - planWeight) / planWeight) * 100;
    const absDeviation = Math.abs(deviationPercent);
    const absDeviationKg = Math.abs(factWeight - planWeight);
    const allowedDeviationKg = Math.max((planWeight * percentThreshold) / 100, minDeviationKgValue);
    
    // Округляем до 1 знака после запятой
    const roundedDeviation = Math.round(deviationPercent * 10) / 10;

    // Проверяем, превышает ли отклонение порог
    if (absDeviationKg > allowedDeviationKg) {
      // Определяем тип нарушения
      const deviationType = deviationPercent > 0 ? 'Перевес' : 'Недовес';
      const absRounded = Math.round(absDeviation * 10) / 10;
      
      result.violations.push({
        ingredient: planItem.name || factItem.name,
        plan: planWeight,
        fact: factWeight,
        deviationPercent: roundedDeviation,
        message: `${deviationType} на ${absRounded}%`
      });
    } else {
      // Отклонение в пределах нормы
      result.matches.push({
        ingredient: planItem.name || factItem.name,
        plan: planWeight,
        fact: factWeight,
        deviationPercent: roundedDeviation
      });
    }
  });

  // Проверяем, все ли плановые компоненты были загружены
  planArr.forEach(planItem => {
    if (!loadedKeys.has(normalizeIngredientName(planItem.name))) {
      // Компонент был в плане, но не загружен
      const planWeight = planItem.targetWeight || planItem.plannedWeight;
      
      result.violations.push({
        ingredient: planItem.name,
        plan: planWeight,
        fact: 0,
        deviationPercent: -100,
        message: 'Не загружен плановый компонент'
      });
    }
  });

  return result;
}

export default {
  calculatePlan,
  checkViolations,
  normalizeIngredientName,
  areSameIngredient
};
