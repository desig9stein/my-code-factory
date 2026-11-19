import assert from 'node:assert/strict';
import { test } from 'node:test';
import { footprint, DEFAULT_ASSUMPTIONS, CAR_GRAMS_PER_KM, validateAssumptions } from '../web/footprint.mjs';
const usage = { input: 3100, cacheWrite: 27600, cacheRead: 1160000, output: 16000, availability: 'available' };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
test('electricity and carbon retain unrounded arithmetic and object equivalents', () => {
  const result = footprint(usage);
  near(result.wh, 16.935); near(result.grams, 6.774); near(result.hours, 1.6935);
  near(result.metres, 6.774 / CAR_GRAMS_PER_KM * 1000);
  near(footprint(usage, DEFAULT_ASSUMPTIONS, 'laptop').hours, 16.935 / 60);
  near(footprint(usage, { ...DEFAULT_ASSUMPTIONS, output: 800, carbonIntensity: 800 }).grams, 16.108);
});
test('unavailable usage is unknown, while recorded zero usage stays zero', () => {
  assert.equal(footprint({ ...usage, availability: 'unavailable' }), null);
  assert.equal(footprint(null), null);
  assert.equal(footprint({ ...usage, input: NaN }), null);
  assert.equal(footprint({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, availability: 'available' }).wh, 0);
});
test('invalid assumptions cannot produce plausible-looking estimates', () => {
  for (const value of [-1, NaN, Infinity, '600', 1000001]) assert.throws(() => validateAssumptions({ ...DEFAULT_ASSUMPTIONS, output: value }));
  assert.throws(() => validateAssumptions({ ...DEFAULT_ASSUMPTIONS, carbonIntensity: 5001 }));
});
