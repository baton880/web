export const WEIGHT_ROUNDING_STEP_KG = 5;

export function roundWeight(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  const rounded = Math.round(parsed / WEIGHT_ROUNDING_STEP_KG) * WEIGHT_ROUNDING_STEP_KG;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function roundOptionalWeight(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? roundWeight(parsed) : null;
}

export function roundNonNegativeWeight(value) {
  return Math.max(0, roundWeight(value));
}
