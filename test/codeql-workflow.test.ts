// ============================================================================
// The CodeQL workflow's contract (.github/workflows/codeql.yml). This repo is
// public, so code scanning is free and the SARIF upload is accepted. The file
// is read as text: it is small and flat, and the things that matter (triggers,
// the token's scopes, the action pins) are each one line.
// ============================================================================
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PATH = fileURLToPath(new URL('../.github/workflows/codeql.yml', import.meta.url));
const yml = existsSync(PATH) ? readFileSync(PATH, 'utf8') : '';
// Comments say what the file does not do; only the YAML itself is asserted on.
const code = yml
  .split('\n')
  .map((l) => l.replace(/\s+#.*$/, ''))
  .filter((l) => !/^\s*#/.test(l) && l.trim() !== '')
  .join('\n');

// The pins fc-mobile's CodeQL workflow carries on develop: one CodeQL release
// across the estate, so an alert means the same thing in every repo.
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const CODEQL = '24c54180a607b1449ed407dd24f251e4e9147c8d';

/** The lines of a top-level or nested block: everything indented deeper than `key:`. */
function block(key: string): string {
  const lines = code.split('\n');
  const at = lines.findIndex((l) => l.trim() === `${key}:`);
  if (at === -1) return '';
  const indent = lines[at]!.search(/\S/);
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.search(/\S/) <= indent) break;
    out.push(l.trim());
  }
  return out.join('\n');
}

describe('CodeQL workflow', () => {
  it('exists', () => {
    expect(existsSync(PATH), '.github/workflows/codeql.yml is missing').toBe(true);
  });

  it('runs on develop pushes, pull requests to develop and a weekly schedule, and on nothing else', () => {
    expect(block('on')).toMatch(
      /^push:\nbranches: \[develop\]\npull_request:\nbranches: \[develop\]\nschedule:\n- cron: '\d{1,2} \d{1,2} \* \* [0-6]'$/,
    );
  });

  it('skips a develop push on a fork, which is a mirror of upstream', () => {
    expect(code).toMatch(/if: github\.event_name != 'push' \|\| github\.repository_owner == 'FigureCollecting'\n/);
  });

  it('holds exactly the three scopes the upload needs, and no workflow-level grant', () => {
    expect(block('permissions').split('\n').sort()).toEqual([
      'actions: read',
      'contents: read',
      'security-events: write',
    ]);
    expect(code.match(/permissions:/g)).toHaveLength(1);
    expect(code).not.toMatch(/secrets\./);
  });

  it('pins every action by full commit SHA, the ones fc-mobile uses', () => {
    const uses = [...code.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    expect(uses).toEqual([CHECKOUT, `github/codeql-action/init@${CODEQL}`, `github/codeql-action/analyze@${CODEQL}`]);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });

  it('analyses javascript-typescript under one category, with a timeout', () => {
    expect(code).toMatch(/languages: javascript-typescript\n/);
    expect(code).toMatch(/category: "\/language:javascript-typescript"/);
    expect(code).toMatch(/timeout-minutes: \d+\n/);
  });

  it('has nothing that turns the analysis off, narrows it, or lets it fail silently', () => {
    // Only the job's own gate may carry an `if:`; no step is skipped.
    expect(code.match(/^\s*if:/gm)).toHaveLength(1);
    expect(code).not.toMatch(/continue-on-error|upload:|config|queries|paths-ignore|paths:|packs|external-repository-token/);
    expect(code).toMatch(/^\s+runs-on: ubuntu-latest$/m);
    const minutes = Number(/timeout-minutes: (\d+)/.exec(code)?.[1]);
    expect(minutes).toBeGreaterThanOrEqual(10);
    // Each action takes exactly the inputs it needs and nothing else.
    const withKeys = (action: string): string[] => {
      const at = code.indexOf(`uses: ${action}`);
      const rest = code.slice(at).split('\n').slice(1);
      const keys: string[] = [];
      let inWith = false;
      for (const l of rest) {
        if (/^\s*- name:/.test(l)) break;
        if (/^\s+with:$/.test(l)) inWith = true;
        else if (inWith) keys.push(l.trim().replace(/:.*$/, ''));
      }
      return keys;
    };
    expect(withKeys('github/codeql-action/init')).toEqual(['languages']);
    expect(withKeys('github/codeql-action/analyze')).toEqual(['category']);
    expect(withKeys('actions/checkout')).toEqual([]);
  });
});
