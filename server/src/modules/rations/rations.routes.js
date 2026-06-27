import { Router } from 'express';
import prisma from '../../database.js'; 
import { requireReadAccess, requireWriteAccess } from '../../middleware/auth.js';
import { recalculateBatchViolations } from '../batches/batch-violations.js';

const router = Router();

function normalizeRationName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseId(value) {
  const id = parseInt(value, 10);
  return Number.isInteger(id) ? id : null;
}

function parseStrictBoolean(value) {
  if (typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return { ok: true, value: true };
    if (normalized === 'false') return { ok: true, value: false };
  }
  return { ok: false, value: null };
}

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().replace(',', '.');
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parsePositiveInteger(value) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function serializeCompoundComponents(components) {
  if (!Array.isArray(components) || components.length === 0) {
    return null;
  }

  return JSON.stringify(components.map((component) => ({
    name: component.name,
    plannedWeight: component.plannedWeight
  })));
}

function parseCompoundComponentsJson(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((component) => ({
        name: normalizeText(component?.name),
        plannedWeight: parseNumber(component?.plannedWeight)
      }))
      .filter((component) => component.name && component.plannedWeight !== null && component.plannedWeight > 0);
  } catch (error) {
    return [];
  }
}

function formatRationIngredient(ingredient) {
  const components = parseCompoundComponentsJson(ingredient?.componentsJson);

  return {
    id: ingredient.id,
    rationId: ingredient.rationId,
    name: ingredient.name,
    sortOrder: Number(ingredient.sortOrder || 0),
    plannedWeight: ingredient.plannedWeight,
    dryMatterWeight: ingredient.dryMatterWeight,
    isCompound: Boolean(ingredient.isCompound),
    components
  };
}

function formatRation(ration) {
  if (!ration) return ration;
  const ingredients = Array.isArray(ration.ingredients)
    ? [...ration.ingredients].sort((left, right) => {
      const orderDiff = Number(left?.sortOrder || 0) - Number(right?.sortOrder || 0);
      if (orderDiff !== 0) return orderDiff;
      return Number(left?.id || 0) - Number(right?.id || 0);
    })
    : [];

  return {
    ...ration,
    feedingsPerDay: parsePositiveInteger(ration.feedingsPerDay) || 1,
    ingredients: ingredients.map(formatRationIngredient)
  };
}

function parseGroupIdsInput(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, groupIds: null };
  }

  let rawList = value;
  if (typeof value === 'string') {
    try {
      rawList = JSON.parse(value);
    } catch (error) {
      return { ok: false, error: 'groups должен быть корректным JSON-массивом ID групп' };
    }
  }

  if (!Array.isArray(rawList)) {
    return { ok: false, error: 'groups должен быть массивом ID групп' };
  }

  const groupIds = [...new Set(rawList.map((id) => parseInt(id, 10)))];
  if (groupIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    return { ok: false, error: 'groups должен содержать только положительные числовые ID групп' };
  }

  return { ok: true, groupIds };
}

function validateIngredients(ingredients) {
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return { ok: false, error: 'ingredients должен быть непустым массивом' };
  }

  const result = [];
  const seen = new Set();

  for (let i = 0; i < ingredients.length; i += 1) {
    const row = ingredients[i] || {};
    const ingredientName = normalizeText(row.name);

    if (!ingredientName) {
      return { ok: false, error: `Ингредиент #${i + 1}: не заполнено поле name` };
    }

    const normalizedIngredientName = ingredientName.toLowerCase();
    if (seen.has(normalizedIngredientName)) {
      return { ok: false, error: `Ингредиент "${ingredientName}" дублируется в рационе` };
    }
    seen.add(normalizedIngredientName);

    const isCompound = row.isCompound === true || row.type === 'compound';
    let components = [];
    let plannedWeight = parseNumber(row.plannedWeight);

    if (isCompound) {
      if (!Array.isArray(row.components) || row.components.length === 0) {
        return { ok: false, error: `Составной ингредиент "${ingredientName}": добавьте состав` };
      }

      const seenComponents = new Set();
      for (let componentIndex = 0; componentIndex < row.components.length; componentIndex += 1) {
        const component = row.components[componentIndex] || {};
        const componentName = normalizeText(component.name);

        if (!componentName) {
          return { ok: false, error: `Составной ингредиент "${ingredientName}", строка #${componentIndex + 1}: укажите название` };
        }

        const normalizedComponentName = componentName.toLowerCase();
        if (seenComponents.has(normalizedComponentName)) {
          return { ok: false, error: `Составной ингредиент "${ingredientName}": компонент "${componentName}" дублируется` };
        }
        seenComponents.add(normalizedComponentName);

        const componentWeight = parseNumber(component.plannedWeight);
        if (componentWeight === null || componentWeight <= 0) {
          return { ok: false, error: `Составной ингредиент "${ingredientName}", "${componentName}": вес должен быть > 0` };
        }

        components.push({
          name: componentName,
          plannedWeight: componentWeight
        });
      }

      plannedWeight = components.reduce((sum, component) => sum + component.plannedWeight, 0);
    }
    if (plannedWeight === null || plannedWeight <= 0) {
      return { ok: false, error: `Ингредиент "${ingredientName}": plannedWeight должен быть > 0` };
    }

    const hasDryMatterWeight = row.dryMatterWeight !== undefined
      && row.dryMatterWeight !== null
      && String(row.dryMatterWeight).trim() !== '';
    let dryMatterWeight = 0;

    if (hasDryMatterWeight) {
      dryMatterWeight = parseNumber(row.dryMatterWeight);
      if (dryMatterWeight === null || dryMatterWeight < 0) {
        return { ok: false, error: `Ингредиент "${ingredientName}": dryMatterWeight должен быть >= 0` };
      }

      if (dryMatterWeight > plannedWeight) {
        return { ok: false, error: `Ингредиент "${ingredientName}": dryMatterWeight не может быть больше plannedWeight` };
      }
    }

    result.push({
      name: ingredientName,
      sortOrder: parsePositiveInteger(row.sortOrder) || i + 1,
      plannedWeight,
      dryMatterWeight,
      isCompound,
      componentsJson: isCompound ? serializeCompoundComponents(components) : null
    });
  }

  return { ok: true, ingredients: result };
}

async function validateGroupIdsExist(groupIds) {
  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    return { ok: true };
  }

  const existingGroups = await prisma.livestockGroup.findMany({
    where: { id: { in: groupIds } },
    select: { id: true }
  });

  if (existingGroups.length !== groupIds.length) {
    return { ok: false, error: 'Одна или несколько групп не найдены' };
  }

  return { ok: true };
}

async function findRationByNormalizedName(name) {
  const normalizedName = normalizeRationName(name);
  if (!normalizedName) return null;

  const rations = await prisma.ration.findMany({
    select: { id: true, name: true }
  });

  return rations.find((item) => normalizeRationName(item.name) === normalizedName) || null;
}

async function recalculateBatchesForRation(rationId) {
  const batches = await prisma.batch.findMany({
    where: {
      OR: [
        { rationId },
        { group: { rationId } }
      ]
    },
    select: { id: true },
    orderBy: { startTime: 'desc' }
  });

  for (const batch of batches) {
    await recalculateBatchViolations(prisma, batch.id);
  }

  return batches.length;
}

// ============================================================================
// POST / - Ручное создание рациона
// ============================================================================
router.post('/', requireWriteAccess, async (req, res) => {
  try {
    const rationName = normalizeText(req.body.name);
    const feedingsPerDay = parsePositiveInteger(req.body.feedingsPerDay) || 1;
    const parsedGroups = parseGroupIdsInput(req.body.groups);
    const parsedIsActive = req.body.isActive === undefined
      ? { ok: true, value: false }
      : parseStrictBoolean(req.body.isActive);
    const validatedIngredients = validateIngredients(req.body.ingredients);

    if (!rationName) {
      return res.status(400).json({ error: 'Необходимо указать название рациона' });
    }
    if (!parsedGroups.ok) {
      return res.status(400).json({ error: parsedGroups.error });
    }
    if (!parsedIsActive.ok) {
      return res.status(400).json({ error: 'isActive должен быть boolean true/false' });
    }
    if (!validatedIngredients.ok) {
      return res.status(400).json({ error: validatedIngredients.error });
    }

    const existing = await findRationByNormalizedName(rationName);
    if (existing) {
      return res.status(400).json({ error: `Рацион с названием "${rationName}" уже существует` });
    }

    if (parsedGroups.groupIds) {
      const groupCheck = await validateGroupIdsExist(parsedGroups.groupIds);
      if (!groupCheck.ok) {
        return res.status(404).json({ error: groupCheck.error });
      }
    }

    const ration = await prisma.$transaction(async (tx) => {
      const created = await tx.ration.create({
        data: {
          name: rationName,
          feedingsPerDay,
          isActive: parsedIsActive.value,
          ingredients: {
            create: validatedIngredients.ingredients
          }
        }
      });

      if (parsedGroups.groupIds && parsedGroups.groupIds.length > 0) {
        await tx.livestockGroup.updateMany({
          where: { id: { in: parsedGroups.groupIds } },
          data: { rationId: created.id }
        });
      }

      return tx.ration.findUnique({
        where: { id: created.id },
        include: {
          ingredients: true,
          livestockGroups: {
            select: {
              id: true,
              name: true,
              headcount: true
            }
          }
        }
      });
    });

    res.status(201).json({ status: 'ok', ration: formatRation(ration) });
  } catch (error) {
    console.error('[Ошибка POST /rations]:', error);
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Рацион с таким названием уже существует' });
    }
    res.status(500).json({ error: 'Внутренняя ошибка сервера при создании рациона' });
  }
});

// ============================================================================
// GET / - Получить все рационы
// ============================================================================
router.get('/', requireReadAccess, async (req, res) => {
  try {
    const rations = await prisma.ration.findMany({
      include: {
        ingredients: true,
        livestockGroups: {
          select: {
            id: true,
            name: true,
            headcount: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(rations.map(formatRation));
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// PATCH /:id/toggle - Активировать/Деактивировать рацион (Для кнопок Сони)
// ============================================================================
router.patch('/:id/toggle', requireWriteAccess, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const { isActive } = req.body; // Фронт передает { "isActive": true/false }
    const parsedIsActive = parseStrictBoolean(isActive);

    if (!id) {
      return res.status(400).json({ error: 'Некорректный ID рациона' });
    }

    if (!parsedIsActive.ok) {
      return res.status(400).json({ error: 'isActive должен быть boolean true/false' });
    }

    const updated = await prisma.ration.update({
      where: { id },
      data: { isActive: parsedIsActive.value }
    });

    res.json({ status: 'ok', message: parsedIsActive.value ? 'Рацион активирован' : 'Рацион деактивирован', ration: updated });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Рацион не найден' });
    res.status(500).json({ error: 'Ошибка при изменении статуса рациона' });
  }
});

// ============================================================================
// PATCH /:id - Ручное редактирование рациона
// ============================================================================
router.patch('/:id', requireWriteAccess, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Некорректный ID рациона' });
    }

    const existingRation = await prisma.ration.findUnique({
      where: { id },
      include: { ingredients: true }
    });

    if (!existingRation) {
      return res.status(404).json({ error: 'Рацион не найден' });
    }

    const hasName = Object.prototype.hasOwnProperty.call(req.body, 'name');
    const hasFeedingsPerDay = Object.prototype.hasOwnProperty.call(req.body, 'feedingsPerDay');
    const hasIngredients = Object.prototype.hasOwnProperty.call(req.body, 'ingredients');
    const hasGroups = Object.prototype.hasOwnProperty.call(req.body, 'groups');
    const hasIsActive = Object.prototype.hasOwnProperty.call(req.body, 'isActive');

    if (!hasName && !hasFeedingsPerDay && !hasIngredients && !hasGroups && !hasIsActive) {
      return res.status(400).json({ error: 'Нет полей для обновления' });
    }

    let nextName = existingRation.name;
    if (hasName) {
      nextName = normalizeText(req.body.name);
      if (!nextName) {
        return res.status(400).json({ error: 'Название рациона не может быть пустым' });
      }

      const existingWithSameName = await findRationByNormalizedName(nextName);
      if (existingWithSameName && existingWithSameName.id !== id) {
        return res.status(400).json({ error: `Рацион с названием "${nextName}" уже существует` });
      }
    }

    let nextFeedingsPerDay = existingRation.feedingsPerDay || 1;
    if (hasFeedingsPerDay) {
      nextFeedingsPerDay = parsePositiveInteger(req.body.feedingsPerDay);
      if (!nextFeedingsPerDay) {
        return res.status(400).json({ error: 'feedingsPerDay РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ РїРѕР»РѕР¶РёС‚РµР»СЊРЅС‹Рј С†РµР»С‹Рј С‡РёСЃР»РѕРј' });
      }
    }

    let validatedIngredients = null;
    if (hasIngredients) {
      validatedIngredients = validateIngredients(req.body.ingredients);
      if (!validatedIngredients.ok) {
        return res.status(400).json({ error: validatedIngredients.error });
      }
    }

    let parsedGroups = { ok: true, groupIds: null };
    if (hasGroups) {
      parsedGroups = parseGroupIdsInput(req.body.groups);
      if (!parsedGroups.ok) {
        return res.status(400).json({ error: parsedGroups.error });
      }
      const groupCheck = await validateGroupIdsExist(parsedGroups.groupIds || []);
      if (!groupCheck.ok) {
        return res.status(404).json({ error: groupCheck.error });
      }
    }

    let parsedIsActive = { ok: true, value: undefined };
    if (hasIsActive) {
      parsedIsActive = parseStrictBoolean(req.body.isActive);
      if (!parsedIsActive.ok) {
        return res.status(400).json({ error: 'isActive должен быть boolean true/false' });
      }
    }

    const ration = await prisma.$transaction(async (tx) => {
      const updateData = {};
      if (hasName) updateData.name = nextName;
      if (hasFeedingsPerDay) updateData.feedingsPerDay = nextFeedingsPerDay;
      if (hasIsActive) updateData.isActive = parsedIsActive.value;

      if (Object.keys(updateData).length > 0) {
        await tx.ration.update({
          where: { id },
          data: updateData
        });
      }

      if (hasIngredients) {
        await tx.rationIngredient.deleteMany({ where: { rationId: id } });
        if (validatedIngredients.ingredients.length > 0) {
          await tx.rationIngredient.createMany({
            data: validatedIngredients.ingredients.map((item) => ({
              rationId: id,
              name: item.name,
              sortOrder: item.sortOrder,
              plannedWeight: item.plannedWeight,
              dryMatterWeight: item.dryMatterWeight,
              isCompound: item.isCompound,
              componentsJson: item.componentsJson
            }))
          });
        }
      }

      if (hasGroups) {
        await tx.livestockGroup.updateMany({
          where: { rationId: id },
          data: { rationId: null }
        });
        if (parsedGroups.groupIds && parsedGroups.groupIds.length > 0) {
          await tx.livestockGroup.updateMany({
            where: { id: { in: parsedGroups.groupIds } },
            data: { rationId: id }
          });
        }
      }

      return tx.ration.findUnique({
        where: { id },
        include: {
          ingredients: true,
          livestockGroups: {
            select: {
              id: true,
              name: true,
              headcount: true
            }
          }
        }
      });
    });

    const recalculatedBatches = (hasFeedingsPerDay || hasIngredients || hasGroups)
      ? await recalculateBatchesForRation(id)
      : 0;

    res.json({ status: 'ok', ration: formatRation(ration), recalculatedBatches });
  } catch (error) {
    console.error('[Ошибка PATCH /rations/:id]:', error);
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Рацион с таким названием уже существует' });
    }
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Рацион не найден' });
    }
    res.status(500).json({ error: 'Не удалось обновить рацион' });
  }
});

// ============================================================================
// DELETE /:id - Удалить рацион
// ============================================================================
router.delete('/:id', requireWriteAccess, async (req, res) => {
  try {
    const id = parseId(req.params.id);

    if (!id) {
      return res.status(400).json({ error: 'Некорректный ID рациона' });
    }

    const ration = await prisma.ration.findUnique({ where: { id } });
    if (!ration) {
      return res.status(404).json({ error: 'Рацион не найден' });
    }

    const [linkedGroups, linkedBatches] = await Promise.all([
      prisma.livestockGroup.count({ where: { rationId: id } }),
      prisma.batch.count({ where: { rationId: id } })
    ]);

    if (linkedBatches > 0) {
      return res.status(409).json({
        error: 'Рацион нельзя удалить: он уже используется в истории замесов',
        details: {
          linkedGroups,
          linkedBatches,
          hint: 'Сначала назначьте другой рацион в замесах или оставьте рацион для истории'
        }
      });
    }

    await prisma.$transaction([
      prisma.livestockGroup.updateMany({
        where: { rationId: id },
        data: { rationId: null }
      }),
      prisma.ration.delete({ where: { id } })
    ]);

    res.json({
      status: 'ok',
      message: linkedGroups > 0
        ? 'Рацион удален, привязки к группам сняты'
        : 'Рацион успешно удален'
    });
  } catch (error) {
    if (error.code === 'P2025') return res.status(404).json({ error: 'Рацион не найден' });
    console.error('[Ошибка DELETE /rations/:id]:', error);
    res.status(500).json({ error: 'Не удалось удалить рацион' });
  }
});

export default router;
