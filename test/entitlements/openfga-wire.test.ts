/**
 * THE WIRE CONTRACT OF THE VENDORED SLICE, CHECKED AGAINST UPSTREAM ITSELF.
 *
 * `proto/openfga/v1/openfga_service.proto` is a SLICE of
 * buf.build/openfga/api — the Check call and nothing else — and the generated
 * TypeScript beside it is committed. Both choices are deliberate (see the
 * proto's own header), and both put the same obligation here: a slice is only
 * as good as its field NUMBERS, because those are the whole of the wire. A
 * name is ours to choose; a number is not.
 *
 * THIS IS NOT A HYPOTHETICAL. The feasibility proof this unit was built on
 * (~/tmp/zt-transport/fga-poc/proto) wrote `authorization_model_id = 5`.
 * Upstream that number is `bool trace`, and 4 is the model id. Against the real
 * OpenFGA the pinned model id would have been written into a bool field: at
 * best a decode error, at worst a Check answered against whatever model happens
 * to be latest — which is precisely the reproducibility the pin exists to buy.
 * The proof passed anyway, because both ends of it used the same wrong slice.
 * Two servers agreeing is not a wire contract; agreement with UPSTREAM is.
 *
 * WHY THE UPSTREAM FILE IS VENDORED HERE RATHER THAN TRANSCRIBED. The first
 * version of this suite carried a hand-copied table of field numbers, which is
 * the same class of artifact as the slice it was checking: something a person
 * typed. Two hand-copies agreeing proves that one hand made the same decision
 * twice. So `test/fixtures/upstream-openfga_service.proto` is the ACTUAL
 * upstream file, byte for byte, its sha256 asserted below, and the numbers are
 * PARSED out of it rather than transcribed.
 *
 * WHY NOT FETCH IT IN CI. Because then the suite fails when GitHub is slow, a
 * runner has no egress, or a proxy is between them — and a test that is red for
 * reasons unrelated to the code is a test people learn to ignore. The fixture
 * makes the check offline and deterministic; the sha256 says exactly which
 * bytes were checked against, so the pin is auditable rather than a matter of
 * trust. Refresh it deliberately, as its own commit:
 *
 *   curl -sS -o test/fixtures/upstream-openfga_service.proto \
 *     https://raw.githubusercontent.com/openfga/api/<commit>/openfga/v1/openfga_service.proto
 *   sha256sum test/fixtures/upstream-openfga_service.proto   # update UPSTREAM_SHA256
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CheckRequestSchema,
  CheckRequestTupleKeySchema,
  CheckResponseSchema,
  OpenFGAService,
} from '../../src/entitlements/gen/openfga/v1/openfga_service_pb.js';

/** openfga/api, openfga/v1/openfga_service.proto @ this commit. */
const UPSTREAM_COMMIT = '7a79d2abab5b9ccc962ae995a1aab70c0a1cf19d';
const UPSTREAM_SHA256 = 'd05816c630c6f99f66ebda17a1c389e5612935316943c0e4abb0f70cd14f4695';

const UPSTREAM_PATH = path.resolve(
  import.meta.dirname,
  '../fixtures/upstream-openfga_service.proto',
);
const SLICE_PATH = path.resolve(
  import.meta.dirname,
  '../../proto/openfga/v1/openfga_service.proto',
);

const read = (file: string): string => fs.readFileSync(file, 'utf8');

/**
 * The body of one `message X { … }`, brace-matched.
 *
 * A regex cannot do this on the upstream file: its fields carry annotation
 * blocks with their own braces, so the obvious `[^}]*` stops at the first
 * `(validate.rules).string = {` and reports a message with two fields in it.
 */
function messageBody(source: string, name: string): string {
  const start = source.search(new RegExp(`\\bmessage\\s+${name}\\s*\\{`));
  if (start < 0) throw new Error(`no message ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated message ${name}`);
}

/**
 * Field name to number, from proto text. Anchored at the start of a line so an
 * annotation's `max_length: 512` or `example: "…"` cannot be read as a field,
 * and terminated by `;` or `[` so an annotated declaration counts.
 */
function fieldsOf(body: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [, name, number] of body.matchAll(
    /^\s*(?:repeated\s+)?[\w.]+\s+(\w+)\s*=\s*(\d+)\s*[;[]/gm,
  )) {
    out[name as string] = Number(number);
  }
  return out;
}

const numbersOf = (schema: {
  fields: readonly { name: string; number: number }[];
}): Record<string, number> => Object.fromEntries(schema.fields.map((f) => [f.name, f.number]));

const MESSAGES: [string, { fields: readonly { name: string; number: number }[] }][] = [
  ['CheckRequest', CheckRequestSchema],
  ['CheckRequestTupleKey', CheckRequestTupleKeySchema],
  ['CheckResponse', CheckResponseSchema],
];

describe('the vendored upstream fixture', () => {
  it(`is openfga/api @ ${UPSTREAM_COMMIT.slice(0, 7)}, byte for byte`, () => {
    // Without this, the fixture is just another file someone could edit to
    // agree with a wrong slice — which would make every assertion below
    // circular. The hash is what makes it evidence.
    const actual = createHash('sha256').update(fs.readFileSync(UPSTREAM_PATH)).digest('hex');
    expect(actual).toBe(UPSTREAM_SHA256);
  });

  it('parses into the three messages the Check uses, non-vacuously', () => {
    // A parser that quietly returned {} would make the comparison below pass
    // for the worst possible reason.
    const upstream = read(UPSTREAM_PATH);
    expect(Object.keys(fieldsOf(messageBody(upstream, 'CheckRequest')))).toEqual(
      expect.arrayContaining(['store_id', 'tuple_key', 'authorization_model_id', 'trace']),
    );
    expect(Object.keys(fieldsOf(messageBody(upstream, 'CheckResponse')))).toEqual(
      expect.arrayContaining(['allowed', 'resolution']),
    );
  });
});

describe('the vendored openfga.v1 slice', () => {
  it('is the service and method OpenFGA actually serves on 8081', () => {
    // The gRPC path is built from these two strings and nothing else:
    // POST /openfga.v1.OpenFGAService/Check. A typo here is a 404 at the far
    // end, dressed up as Code.Unimplemented.
    expect(OpenFGAService.typeName).toBe('openfga.v1.OpenFGAService');
    expect(Object.keys(OpenFGAService.method)).toEqual(['check']);
    expect(OpenFGAService.method.check.name).toBe('Check');
    expect(OpenFGAService.method.check.input.typeName).toBe('openfga.v1.CheckRequest');
    expect(OpenFGAService.method.check.output.typeName).toBe('openfga.v1.CheckResponse');
  });

  it.each(MESSAGES)('gives every %s field the number upstream gives it', (name, schema) => {
    const upstream = fieldsOf(messageBody(read(UPSTREAM_PATH), name));
    for (const [field, number] of Object.entries(numbersOf(schema))) {
      expect({ field, number }).toEqual({ field, number: upstream[field] });
    }
  });

  it('answers `allowed` as a bool, so a deny cannot arrive as a truthy string', () => {
    const allowed = CheckResponseSchema.fields.find((f) => f.name === 'allowed');
    expect(allowed?.scalar).toBe(8 /* ScalarType.BOOL */);
  });

  it('reserves exactly the upstream numbers it does not send', () => {
    // DERIVED, not listed. Upstream CheckRequest has seven fields; the slice
    // carries three; the other four must be reserved, or proto3 will let a
    // later edit take one and the far end will read it as something else
    // entirely — `trace`, or a contextual tuple set.
    const upstream = fieldsOf(messageBody(read(UPSTREAM_PATH), 'CheckRequest'));
    const carried = new Set(Object.values(numbersOf(CheckRequestSchema)));
    const expected = Object.values(upstream)
      .filter((n) => !carried.has(n))
      .sort((a, b) => a - b);

    const match = /reserved\s+([0-9,\s]+);/.exec(read(SLICE_PATH));
    expect(match).not.toBeNull();
    const reserved = (match?.[1] ?? '')
      .split(',')
      .map((n) => Number(n.trim()))
      .sort((a, b) => a - b);

    expect(reserved).toEqual(expected);
    // Anti-vacuous: upstream really does have fields we are not carrying.
    expect(expected.length).toBeGreaterThan(0);
  });

  it('has generated code that still matches the .proto text beside it', () => {
    // Committed generated output drifts the moment someone edits the proto and
    // does not run `npm run proto:generate`. CI cannot re-run buf without
    // adding a binary to the install path, so the check is done the cheap way:
    // read the numbers out of the text and compare them with the descriptor.
    const slice = read(SLICE_PATH);
    const fromText = Object.fromEntries(
      MESSAGES.map(([name]) => [name, fieldsOf(messageBody(slice, name))]),
    );
    expect(fromText).toEqual(Object.fromEntries(MESSAGES.map(([name, s]) => [name, numbersOf(s)])));
  });
});
