/**
 * Обрабатывает массив строк из Excel с рационами
 * @param {Array} rawExelData - Массив объектов с русскими ключами
 * @returns {Object} Результат: { success, data, errors }
 */
export const NAME_COLUMNS = ['Ингредиент', 'Название', 'Компонент', 'Корм', 'ingredient', 'name'];
export const PLAN_COLUMNS = ['План', 'Вес на голову в сутки, кг', 'Вес/голову', 'Вес на голову', 'plannedWeight'];
export const DRY_COLUMNS = ['СВ', 'Вес на голову в сутки СВ, кг', 'Вес СВ/голову', 'Сухое вещество', 'dryMatterWeight'];

export function normalizeIngredientName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function areSameIngredient(left, right) {
  return normalizeIngredientName(left) === normalizeIngredientName(right);
}

function firstValue(row, columns) {
  for (const column of columns) {
    if (row[column] !== undefined && row[column] !== null && String(row[column]).trim() !== '') {
      return row[column];
    }
  }
  return undefined;
}

function normalizeNumber(value) {
  if (typeof value === 'number') return value;
  if (value === undefined || value === null) return NaN;
  return Number(String(value).replace(',', '.').trim());
}

export function processRationRows(rawExelData) {
  const result = {
    success: true,
    data: [],
    errors: []
  };

  if (!Array.isArray(rawExelData) || rawExelData.length === 0) {
    return {
      success: false,
      data: [],
      errors: ['В файле не найдено строк с рационом']
    };
  }

  const availableColumns = new Set(rawExelData.flatMap(row => Object.keys(row)));
  const hasColumn = columns => columns.some(column => availableColumns.has(column));

  if (!hasColumn(NAME_COLUMNS)) {
    result.errors.push(`Не найдена колонка ингредиента. Поддерживаются: ${NAME_COLUMNS.join(', ')}`);
  }
  if (!hasColumn(PLAN_COLUMNS)) {
    result.errors.push(`Не найдена колонка планового веса. Поддерживаются: ${PLAN_COLUMNS.join(', ')}`);
  }

  if (result.errors.length > 0) {
    result.success = false;
    return result;
  }

  rawExelData.forEach((row, index) => {
    const lineNumber = index + 1;

    // 1. Пропускаем пустые строки
    const values = Object.values(row);
    const isEmptyRow = values.every(val => 
      val === undefined || val === null || String(val).trim() === ''
    );
    if (isEmptyRow) return;

    // 2. Маппинг и очистка
    const name = firstValue(row, NAME_COLUMNS) ? String(firstValue(row, NAME_COLUMNS)).trim().replace(/\s+/g, ' ') : '';
    const plannedWeightRaw = firstValue(row, PLAN_COLUMNS);
    const dryMatterWeightRaw = firstValue(row, DRY_COLUMNS);

    if (!name) {
      result.errors.push(`Строка ${lineNumber}: Не указано название ингредиента`);
      result.success = false;
      return;
    }

    // 3. Валидация: План
    const plannedWeight = normalizeNumber(plannedWeightRaw);
    if (isNaN(plannedWeight) || plannedWeight <= 0) {
      result.errors.push(`Строка ${lineNumber}: Вес '${plannedWeightRaw}' не является числом или меньше/равен 0`);
      result.success = false;
      return;
    }

    // 4. СВ не обязательно. Если нет в файле — подставляем 0.
    let dryMatterWeight = 0;
    if (dryMatterWeightRaw !== undefined && String(dryMatterWeightRaw).trim() !== '') {
      dryMatterWeight = normalizeNumber(dryMatterWeightRaw);
      if (isNaN(dryMatterWeight) || dryMatterWeight < 0) {
        result.errors.push(`Строка ${lineNumber}: Сухое вещество '${dryMatterWeightRaw}' не является числом или меньше 0`);
        result.success = false;
        return;
      }

      // 5. Физика: СВ <= вес
      if (dryMatterWeight > plannedWeight) {
        result.errors.push(`Строка ${lineNumber}: Сухое вещество (${dryMatterWeight}) не может быть больше планового веса (${plannedWeight})`);
        result.success = false;
        return;
      }
    }

    // 6. Успех — добавляем в результат
    result.data.push({ name, plannedWeight, dryMatterWeight });
  });

  if (result.success && result.data.length === 0) {
    result.errors.push('В файле не найдено ни одной строки рациона');
    result.success = false;
  }

  return result;
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

  let totalBatchWeight = 0;
  let totalDryMatterWeight = 0;
  const ingredients = [];

  // 2. Проходим по каждому ингредиенту и считаем замес
  for (const item of parsedRation) {
    const targetWeight = item.plannedWeight * headcount;
    const targetDryMatter = Number(item.dryMatterWeight || 0) * headcount;

    // Суммируем общие показатели
    totalBatchWeight += targetWeight;
    totalDryMatterWeight += targetDryMatter;

    // Формируем объект ингредиента для результата
    ingredients.push({
      name: item.name,
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
  processRationRows,
  calculatePlan,
  checkViolations,
  normalizeIngredientName,
  areSameIngredient
};
