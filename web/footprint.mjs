// scenario-v1: arithmetic, not a provider measurement or a calibrated model.
export const DEFAULT_ASSUMPTIONS = Object.freeze({ input: 50, cacheWrite: 50, cacheRead: 5, output: 600, carbonIntensity: 400 });
export const TOKEN_KINDS = ['input', 'cacheWrite', 'cacheRead', 'output'];
export const OBJECTS = Object.freeze({ bulb: { label: 'a 10 W LED bulb', watts: 10 }, laptop: { label: 'a 60 W laptop', watts: 60 }, fan: { label: 'a 40 W fan', watts: 40 } });
export const CAR_GRAMS_PER_KM = 393 / 1.609344;
export function validateAssumptions(values) {
  for (const key of [...TOKEN_KINDS, 'carbonIntensity']) {
    if (typeof values[key] !== 'number' || !Number.isFinite(values[key]) || values[key] < 0 || values[key] > (key === 'carbonIntensity' ? 5000 : 1e6)) throw new Error(`Invalid ${key}: enter a nonnegative number within the field limit.`);
  }
  return Object.fromEntries([...TOKEN_KINDS, 'carbonIntensity'].map(key => [key, values[key]]));
}
export function footprint(usage, assumptions = DEFAULT_ASSUMPTIONS, object = 'bulb') {
  const rates = validateAssumptions(assumptions);
  if (!OBJECTS[object]) throw new Error('Unknown comparison object.');
  if (!usage || usage.availability === 'unavailable') return null;
  if (TOKEN_KINDS.some(key => !Number.isFinite(usage[key]) || usage[key] < 0)) return null;
  const contributions = Object.fromEntries(TOKEN_KINDS.map(key => [key, usage[key] * rates[key] / 1e6]));
  const wh = Object.values(contributions).reduce((a, b) => a + b, 0);
  const grams = wh / 1000 * rates.carbonIntensity;
  return { contributions, wh, grams, hours: wh / OBJECTS[object].watts, metres: grams / CAR_GRAMS_PER_KM * 1000 };
}
