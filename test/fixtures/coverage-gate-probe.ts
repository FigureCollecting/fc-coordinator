// A deliberately UNTESTED module, used only by test/coverage-gate.test.ts to
// prove the coverage gate bites per file.
//
// Nothing imports it. It is outside the coverage `include` of the real suite
// (src/**/*.ts), so it never affects the project's own numbers; the gate test
// points a child vitest run at it explicitly.
export function classify(value: number): string {
  if (value < 0) return 'negative';
  if (value === 0) return 'zero';
  if (value > 100) return 'large';
  return 'small';
}

export function describeFlag(flag: boolean, label?: string): string {
  return flag ? `on:${label ?? 'unnamed'}` : 'off';
}
