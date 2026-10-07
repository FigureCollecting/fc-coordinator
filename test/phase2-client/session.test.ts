// The session's reading of answers that are not the happy path: an enrolment with no device id,
// a session body that names none, and Connect error bodies in the shapes the edge and Connect use.
import { create } from '@bufbuild/protobuf';
import { StatusRequestSchema, StatusResponseSchema } from '@figurecollecting/fc-api-contract';
import { describe, expect, it } from 'vitest';
import { generateClientKey } from '../../scripts/phase2-client/dpop.js';
import { createSafeOutput } from '../../scripts/phase2-client/output.js';
import { Session, type Exchange } from '../../scripts/phase2-client/session.js';
import type { Transport } from '../../scripts/phase2-client/transport.js';

const answering = (status: number, body: string): Transport => ({
  count: 0,
  request: async () => ({ status, headers: new Headers({ 'content-type': 'application/json' }), body: new TextEncoder().encode(body) }),
});
const session = (t: Transport) =>
  new Session(t, { origin: 'https://api.test.invalid', prefix: '/api' }, 'access-token-value', createSafeOutput({ write: () => true }, { write: () => true }));
const exchange = (body: string): Exchange => ({ status: 200, headers: new Headers(), body: new TextEncoder().encode(body), error: undefined, nonce: undefined, jti: undefined });

describe('Session', () => {
  it('refuses an enrolment answer that carries no device id', async () => {
    await expect(session(answering(201, '{}')).enrol(await generateClientKey(), 'enrol')).rejects.toThrow(/without a deviceId/);
  });

  it('takes 200 as well as 201: a key enrolled already is answered with its device', async () => {
    expect(await session(answering(200, '{"deviceId":"d-1"}')).enrol(await generateClientKey(), 'enrol')).toBe('d-1');
    await expect(session(answering(204, '{"deviceId":"d-1"}')).enrol(await generateClientKey(), 'enrol')).rejects.toThrow(/enrolment answered 204/);
  });

  it('reads the bound device id only when there is one', () => {
    expect(Session.deviceOf(exchange('{"deviceId":"d-1"}'))).toBe('d-1');
    expect(Session.deviceOf(exchange('{"deviceId":5}'))).toBeUndefined();
    expect(Session.deviceOf(exchange('<html>'))).toBeUndefined();
  });

  it("reads a Connect error's code, the edge's error, or nothing", async () => {
    const key = await generateClientKey();
    const status = (t: Transport) =>
      session(t).unary(key, '/coordinator.v1.SyncService/Status', StatusRequestSchema, StatusResponseSchema, create(StatusRequestSchema, {}), 'x');
    expect(await status(answering(503, '{"code":"unavailable","message":"m"}'))).toMatchObject({ ok: false, status: 503, code: 'unavailable' });
    expect(await status(answering(401, '{"error":"invalid_token"}'))).toMatchObject({ ok: false, status: 401, code: 'invalid_token' });
    expect(await status(answering(500, '{"message":"m"}'))).toMatchObject({ ok: false, status: 500, code: '' });
    expect(await status(answering(502, '<html>bad gateway</html>'))).toMatchObject({ ok: false, status: 502, code: '' });
  });
});
