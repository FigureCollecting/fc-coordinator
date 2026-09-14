import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as shared from './shared.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEAM = path.join(SRC, 'platform', 'shared.ts');
const PACKAGE = ['@figurecollecting', 'fc-shared'].join('/');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

describe('platform/shared — the single fc-shared seam', () => {
  it('re-exports the trace, sanitize and logger surface the coordinator is allowed to use', () => {
    const fns = [
      'getActiveTraceIds',
      'getTraceContext',
      'redactValue',
      'redactString',
      'redactAttributes',
      'configureLogger',
      'sanitizeLogValue',
    ];
    for (const name of fns) {
      expect(typeof (shared as unknown as Record<string, unknown>)[name]).toBe('function');
    }
    expect(shared.DEFAULT_SENSITIVE_KEY_PATTERN).toBeInstanceOf(RegExp);
    expect(shared.DEFAULT_SECRET_VALUE_PATTERNS.length).toBeGreaterThan(0);
  });

  it('re-exported redaction actually redacts, so the seam is not a hollow alias', () => {
    expect(shared.redactAttributes({ authorization: 'Bearer abc123' })).toEqual({
      authorization: '[REDACTED]',
    });
  });

  it('does NOT re-export the browser/legacy surface a Postgres-only service must never touch', () => {
    // api/* is the axios client for calling LEGACY fc-backend; stores/* are
    // fc-mobile's zustand singletons; Figure/User are Mongo-shaped (_id).
    for (const name of ['useAuthStore', 'useSyncStore', 'apiClient', 'figuresApi', 'scraperApi']) {
      expect(name in shared).toBe(false);
    }
  });

  it('is the ONLY non-test module in src/ that names the fc-shared package', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => file !== SEAM)
      .filter((file) => readFileSync(file, 'utf8').includes(PACKAGE));
    expect(offenders).toEqual([]);
  });
});
