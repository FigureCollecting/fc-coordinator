import { describe, expect, it } from 'vitest';
import { createStructuredLogger } from './logger.js';

function capture() {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

const ESC = String.fromCharCode(27);

describe('platform/logger', () => {
  it('emits one JSON object per line with level, time, name and msg', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ name: 'app', level: 'info', sink }).info('started');

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['level']).toBe('info');
    expect(entry['name']).toBe('app');
    expect(entry['msg']).toBe('started');
    expect(typeof entry['time']).toBe('string');
  });

  it('omits the trace tag when no span is active, leaving the line shape valid', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ sink }).error('boom');
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['trace']).toBeUndefined();
    expect(entry['traceId']).toBeUndefined();
    expect(entry['msg']).toBe('boom');
  });

  it('strips newlines and ANSI escapes so a log line cannot be forged', () => {
    const { lines, sink } = capture();
    // Log injection: an attacker-controlled value carrying a fake log line.
    const hostile = 'user=\n{"level":"error","msg":"forged"}' + ESC + '[31m';
    createStructuredLogger({ sink }).warn(hostile);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['msg']).not.toContain('\n');
    expect(entry['msg']).not.toContain(ESC);
  });

  it('honours the level threshold', () => {
    const { lines, sink } = capture();
    const log = createStructuredLogger({ level: 'warn', sink });
    log.debug('d');
    log.trace('t');
    log.info('i');
    log.warn('w');
    log.error('e');
    log.fatal('f');
    expect(lines.map((l) => (JSON.parse(l) as { level: string }).level)).toEqual([
      'warn',
      'error',
      'fatal',
    ]);
  });

  it('is silent at level "silent"', () => {
    const { lines, sink } = capture();
    const log = createStructuredLogger({ level: 'silent', sink });
    log.fatal('nothing escapes');
    expect(lines).toEqual([]);
  });

  it('merges child bindings into every line and nests children', () => {
    const { lines, sink } = capture();
    const root = createStructuredLogger({ name: 'app', level: 'info', sink });
    root.child({ reqId: 'r-1' }).child({ route: '/healthz' }).info('handled');

    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['reqId']).toBe('r-1');
    expect(entry['route']).toBe('/healthz');
    expect(entry['name']).toBe('app');
  });

  it('accepts pino-style (mergeObject, msg) calls and sanitizes the merged values', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ level: 'info', sink }).info({ note: 'a\nb' }, 'with fields');
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['msg']).toBe('with fields');
    expect(entry['note']).toBe('a b');
  });

  it('serialises an Error argument to its message rather than dropping it', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ level: 'info', sink }).error(new Error('db down'));
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['msg']).toContain('db down');
  });

  it('redacts a secret-shaped field that reaches a log line', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ level: 'info', sink }).info({ password: 'hunter2' }, 'never log this');
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['password']).toBe('[REDACTED]');
    expect(lines[0]).not.toContain('hunter2');
  });

  it('exposes a pino-compatible level property for Fastify', () => {
    const log = createStructuredLogger({ level: 'warn', sink: () => {} });
    expect(log.level).toBe('warn');
    expect(typeof log.silent).toBe('function');
  });
});

describe('platform/logger — default sink', () => {
  it('writes one newline-terminated line to stdout when no sink is given', () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      createStructuredLogger({ name: 'stdout-test' }).info('to stdout');
    } finally {
      process.stdout.write = original;
    }

    expect(written).toHaveLength(1);
    expect(written[0]?.endsWith('\n')).toBe(true);
    expect((JSON.parse(written[0] as string) as { msg: string }).msg).toBe('to stdout');
  });

  it('silent() emits nothing even at trace level', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ level: 'trace', sink }).silent('ignored');
    expect(lines).toEqual([]);
  });
});

describe('platform/logger — serializers keep a log line bounded', () => {
  // Fastify logs `{ req: request }`. A Fastify Request exposes method/url as
  // PROTOTYPE getters and carries raw/socket/server, whose object graph is
  // circular and enormous. This fake reproduces both properties.
  function fakeFastifyRequest(): object {
    const proto = {
      get method(): string {
        return 'GET';
      },
      get url(): string {
        return '/healthz';
      },
    };
    const req = Object.create(proto) as Record<string, unknown>;
    req['id'] = 'req-1';
    req['ip'] = '127.0.0.1';
    req['params'] = {};
    req['headers'] = { authorization: 'Bearer super-secret-value' };
    req['socket'] = { server: { connections: 1 } };
    (req['socket'] as Record<string, unknown>)['parent'] = req;
    req['raw'] = { _readableState: { buffer: [], highWaterMark: 65536 } };
    return req;
  }

  it('reduces a request to a handful of fields instead of walking the socket graph', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ level: 'info', sink }).info(
      { req: fakeFastifyRequest() },
      'incoming request',
    );

    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['req']).toEqual({
      id: 'req-1',
      method: 'GET',
      url: '/healthz',
      remoteAddress: '127.0.0.1',
    });
    expect(lines[0]?.length).toBeLessThan(400);
    expect(lines[0]).not.toContain('super-secret-value');
    expect(lines[0]).not.toContain('highWaterMark');
  });

  it('reduces a reply to its status code', () => {
    const { lines, sink } = capture();
    const reply = { statusCode: 503, raw: { _writableState: { highWaterMark: 65536 } }, request: {} };
    createStructuredLogger({ level: 'info', sink }).info({ res: reply, responseTime: 2 }, 'done');

    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['res']).toEqual({ statusCode: 503 });
    expect(entry['responseTime']).toBe(2);
    expect(lines[0]).not.toContain('highWaterMark');
  });

  it('truncates an arbitrarily deep field rather than serialising it whole', () => {
    const { lines, sink } = capture();
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too far' } } } } } } };
    createStructuredLogger({ level: 'info', sink }).info(deep, 'deep');
    expect(lines[0]).not.toContain('too far');
    expect(lines[0]).toContain('truncated');
  });

  it('leaves a non-object req or res value alone', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ level: 'info', sink }).info({ req: 'not-an-object', res: null }, 'odd');
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['req']).toBe('not-an-object');
    expect(entry['res']).toBeNull();
  });
});

describe('logger — DPoP secrets', () => {
  it('redacts an opaque dpop_nonce field, which only the local KEY pattern catches', () => {
    const lines: string[] = [];
    const log = createStructuredLogger({ sink: (line) => lines.push(line), level: 'info' });
    const nonce = 'q8Zr3kVn1xMpLb7TfGhQaWcEdRyUiOpAsDfGhJkLzXcVbNm0';

    log.info({ dpop_nonce: nonce, auth_outcome: 'nonce_missing' }, 'rejected dpop proof');

    expect(lines[0]).not.toContain(nonce);
    expect(JSON.parse(lines[0]!)['dpop_nonce']).toBe('[REDACTED]');
    // the OUTCOME is deliberately still legible: an operator needs it
    expect(JSON.parse(lines[0]!)['auth_outcome']).toBe('nonce_missing');
  });
});
