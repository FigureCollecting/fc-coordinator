/**
 * THE WIRE CONTRACT OF THE VENDORED SLICE.
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
 * Two servers agreeing is not a wire contract; agreement with UPSTREAM is, and
 * nothing but a table of upstream numbers can assert it.
 *
 * So this file carries that table, copied from openfga/api at commit
 * 7a79d2abab5b9ccc962ae995a1aab70c0a1cf19d (openfga/v1/openfga_service.proto,
 * sha256 d05816c630c6f99f66ebda17a1c389e5612935316943c0e4abb0f70cd14f4695),
 * and asserts three things against it:
 *
 *   1. the generated descriptor matches the table — the committed code is the
 *      contract it claims to be;
 *   2. the vendored .proto TEXT matches the generated descriptor — the two
 *      committed artifacts cannot drift apart, which is the failure mode that
 *      comes free with checking generated output in;
 *   3. the numbers this slice does NOT use are the ones upstream has spoken
 *      for, and are reserved rather than merely absent.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CheckRequestSchema,
  CheckRequestTupleKeySchema,
  CheckResponseSchema,
  OpenFGAService,
} from '../../src/entitlements/gen/openfga/v1/openfga_service_pb.js';

/** Upstream openfga/v1/openfga_service.proto — message name to {field: number}. */
const UPSTREAM_FIELDS: Record<string, Record<string, number>> = {
  CheckRequest: { store_id: 1, tuple_key: 2, authorization_model_id: 4 },
  CheckRequestTupleKey: { user: 1, relation: 2, object: 3 },
  CheckResponse: { allowed: 1, resolution: 2 },
};

/**
 * Upstream CheckRequest numbers this slice deliberately does not carry. Named,
 * because "3 is free" is exactly the mistake: it is not free, it is
 * `contextual_tuples`, and a local edit that took it would send contextual
 * tuples where none were meant.
 */
const UPSTREAM_UNUSED: Record<number, string> = {
  3: 'contextual_tuples',
  5: 'trace',
  6: 'context',
  7: 'consistency',
};

const PROTO_PATH = path.resolve(
  import.meta.dirname,
  '../../proto/openfga/v1/openfga_service.proto',
);

const numbersOf = (schema: { fields: readonly { name: string; number: number }[] }): Record<string, number> =>
  Object.fromEntries(schema.fields.map((f) => [f.name, f.number]));

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

  it.each([
    ['CheckRequest', CheckRequestSchema],
    ['CheckRequestTupleKey', CheckRequestTupleKeySchema],
    ['CheckResponse', CheckResponseSchema],
  ])('gives %s the upstream field numbers', (name, schema) => {
    expect(numbersOf(schema)).toEqual(UPSTREAM_FIELDS[name]);
  });

  it('answers `allowed` as a bool, so a deny cannot arrive as a truthy string', () => {
    const allowed = CheckResponseSchema.fields.find((f) => f.name === 'allowed');
    expect(allowed?.scalar).toBe(8 /* ScalarType.BOOL */);
  });

  it('reserves every upstream number it does not send', () => {
    // Absence is not protection: proto3 will happily let a later edit take 5
    // for something of its own, and the far end will read it as `trace`.
    const text = fs.readFileSync(PROTO_PATH, 'utf8');
    const reserved = text.match(/reserved\s+([0-9,\s]+);/);
    expect(reserved).not.toBeNull();
    const numbers = (reserved?.[1] ?? '')
      .split(',')
      .map((n) => Number(n.trim()))
      .sort((a, b) => a - b);
    expect(numbers).toEqual(Object.keys(UPSTREAM_UNUSED).map(Number).sort((a, b) => a - b));
  });

  it('has generated code that still matches the .proto text beside it', () => {
    // Committed generated output drifts the moment someone edits the proto and
    // does not run `npm run proto:generate`. CI cannot re-run buf without
    // adding a binary to the install path, so the check is done the cheap way:
    // read the numbers out of the text and compare them with the descriptor.
    const text = fs.readFileSync(PROTO_PATH, 'utf8');
    const fromText: Record<string, Record<string, number>> = {};
    for (const [, name, body] of text.matchAll(/message\s+(\w+)\s*\{([^}]*)\}/g)) {
      const fields: Record<string, number> = {};
      for (const [, field, number] of (body as string).matchAll(/\b(\w+)\s*=\s*(\d+)\s*;/g)) {
        fields[field as string] = Number(number);
      }
      fromText[name as string] = fields;
    }
    expect(fromText).toEqual({
      CheckRequest: numbersOf(CheckRequestSchema),
      CheckRequestTupleKey: numbersOf(CheckRequestTupleKeySchema),
      CheckResponse: numbersOf(CheckResponseSchema),
    });
  });
});
