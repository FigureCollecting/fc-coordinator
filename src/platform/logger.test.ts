import { describe, expect, it } from 'vitest';
import { createStructuredLogger, DEFAULT_SERVICE_NAME } from './logger.js';

type Line = Record<string, unknown>;

function capture() {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

const first = (lines: string[]): Line => JSON.parse(lines[0] as string) as Line;

const ESC = String.fromCharCode(27);

describe('platform/logger: the estate log shape', () => {
  it('emits one JSON object per line: time, level, service, version, event, msg, in that order', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ service: 'app', version: 'abc1234', level: 'info', sink }).info('started');

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    const entry = first(lines);
    expect(Object.keys(entry)).toEqual(['time', 'level', 'service', 'version', 'event', 'msg']);
    expect(entry).toMatchObject({ level: 'info', service: 'app', version: 'abc1234', event: 'app.log', msg: 'started' });
    expect(new Date(entry['time'] as string).toISOString()).toBe(entry['time']);
  });

  it('names the service fc-coordinator and the version unknown by default', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ sink }).info('started');

    expect(DEFAULT_SERVICE_NAME).toBe('fc-coordinator');
    expect(first(lines)).toMatchObject({ service: 'fc-coordinator', version: 'unknown' });
  });

  it('reads nothing from the environment: not the level, the format, the identity or a job name', () => {
    const names = ['LOG_LEVEL', 'FC_LOG_FORMAT', 'SERVICE_VERSION', 'OTEL_SERVICE_NAME', 'JOB_NAME'] as const;
    const saved = names.map((name) => process.env[name]);
    process.env['LOG_LEVEL'] = 'error';
    process.env['FC_LOG_FORMAT'] = 'text';
    process.env['SERVICE_VERSION'] = 'env-version';
    process.env['OTEL_SERVICE_NAME'] = 'env-service';
    process.env['JOB_NAME'] = 'env-job';
    try {
      const { lines, sink } = capture();
      createStructuredLogger({ sink }).info('started');

      expect(first(lines)).toMatchObject({ level: 'info', service: 'fc-coordinator', version: 'unknown' });
      expect(first(lines)).not.toHaveProperty('job');
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
      });
    }
  });

  it('omits trace_id and span_id when no span is active, leaving the line shape valid', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ sink }).error('boom');
    const entry = first(lines);
    expect(entry).not.toHaveProperty('trace_id');
    expect(entry).not.toHaveProperty('span_id');
    expect(entry['msg']).toBe('boom');
  });

  it('strips newlines and ANSI escapes so a log line cannot be forged', () => {
    const { lines, sink } = capture();
    // Log injection: an attacker-controlled value carrying a fake log line.
    const hostile = 'user=\n{"level":"error","msg":"forged"}' + ESC + '[31m';
    createStructuredLogger({ sink }).warn(hostile);
    expect(lines).toHaveLength(1);
    const entry = first(lines);
    expect(entry['msg']).not.toContain('\n');
    expect(entry['msg']).not.toContain(ESC);
    expect(entry['level']).toBe('warn');
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
    expect(lines.map((l) => (JSON.parse(l) as { level: string }).level)).toEqual(['warn', 'error', 'fatal']);
  });

  it('is silent at level "silent"', () => {
    const { lines, sink } = capture();
    const log = createStructuredLogger({ level: 'silent', sink });
    log.fatal('nothing escapes');
    expect(lines).toEqual([]);
  });

  it('merges child bindings into every line, nests children, and prints keys in snake_case', () => {
    const { lines, sink } = capture();
    const root = createStructuredLogger({ service: 'app', level: 'info', sink });
    root.child({ reqId: 'r-1' }).child({ route: '/healthz' }).info('handled');

    const entry = first(lines);
    expect(entry['req_id']).toBe('r-1');
    expect(entry['route']).toBe('/healthz');
    expect(entry['service']).toBe('app');
    expect(entry).not.toHaveProperty('reqId');
  });

  it('keeps its level on a child Fastify creates with an empty level', () => {
    const { lines, sink } = capture();
    const child = createStructuredLogger({ level: 'warn', sink }).child({ reqId: 'r-1' }, { level: '' });
    child.info('dropped');
    child.warn('kept');
    expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(['kept']);
  });

  it('accepts pino-style (mergeObject, msg) calls and sanitizes the merged values', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ level: 'info', sink }).info({ note: 'a\nb' }, 'with fields');
    const entry = first(lines);
    expect(entry['msg']).toBe('with fields');
    expect(entry['note']).toBe('a b');
  });

  it('a field cannot overwrite the keys the logger owns', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ service: 'app', level: 'info', sink }).info(
      { service: 'forged', version: 'forged', level: 'fatal', trace_id: 'f'.repeat(32), time: 'never' },
      'owned',
    );
    const entry = first(lines);
    expect(entry).toMatchObject({ service: 'app', version: 'unknown', level: 'info' });
    expect(entry).not.toHaveProperty('trace_id');
    expect(lines[0]).not.toContain('forged');
  });

  it('serialises an Error argument to its message and an err field, rather than dropping it', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ level: 'info', sink }).error(new Error('db down'));
    const entry = first(lines);
    expect(entry['msg']).toContain('db down');
    expect(entry['err']).toEqual({ type: 'Error', message: 'db down' });
  });

  it('redacts a secret-shaped field that reaches a log line', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ level: 'info', sink }).info({ password: 'hunter2' }, 'never log this');
    expect(first(lines)['password']).toBe('[REDACTED]');
    expect(lines[0]).not.toContain('hunter2');
  });

  it('strips the query, the fragment and the userinfo from a URL it prints', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ level: 'info', sink }).info(
      { db_target: 'postgres://fc:hunter2@pg.data.svc:5432/coordinator?sslmode=verify-full' },
      'connect https://auth.example/callback?state=opaque-state-value#frag',
    );
    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).not.toContain('opaque-state-value');
    expect(lines[0]).not.toContain('frag');
    expect(first(lines)['msg']).toContain('https://auth.example/callback');
  });

  it('exposes a pino-compatible surface for Fastify', () => {
    const log = createStructuredLogger({ level: 'warn', sink: () => {} });
    expect(log.level).toBe('warn');
    for (const method of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent', 'child'] as const) {
      expect(typeof log[method]).toBe('function');
    }
  });
});

describe('platform/logger: default sink', () => {
  it('writes one newline-terminated line to stdout when no sink is given', () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      createStructuredLogger({ service: 'stdout-test' }).info('to stdout');
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

describe('platform/logger: a log line stays bounded', () => {
  // Fastify logs `{ req: request }`. A Fastify Request exposes method/url as
  // PROTOTYPE getters and carries raw/socket/server, whose object graph is
  // circular and enormous. This fake reproduces both properties, without the
  // node stream a real one holds in `raw` (http-trace.test.ts logs real ones).
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

  it('prints a circular framework object as one bounded JSON string, its secrets masked', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ level: 'info', sink }).info({ req: fakeFastifyRequest() }, 'incoming request');

    const entry = first(lines);
    expect(typeof entry['req']).toBe('string');
    expect((entry['req'] as string).length).toBeLessThanOrEqual(1000);
    expect(lines[0]).not.toContain('super-secret-value');
    expect(lines[0]).toContain('[circular]');
  });

  it('prints an object field as ONE JSON string, never a nested value', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ level: 'info', sink }).info({ ages: { '<10s': 2, '>=7d': 1 }, list: ['a', 'b'], responseTime: 2 }, 'done');

    const entry = first(lines);
    expect(entry['ages']).toBe('{"<10s":2,">=7d":1}');
    expect(entry['list']).toBe('["a","b"]');
    expect(entry['response_time']).toBe(2);
  });

  it('truncates an arbitrarily deep field rather than serialising it whole', () => {
    const { lines, sink } = capture();
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too far' } } } } } } };
    createStructuredLogger({ level: 'info', sink }).info(deep, 'deep');
    expect(lines[0]).not.toContain('too far');
    expect(lines[0]).toContain('truncated');
  });

  it('leaves a scalar or null field alone', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ level: 'info', sink }).info({ req: 'not-an-object', res: null, count: 3, on: true }, 'odd');
    expect(first(lines)).toMatchObject({ req: 'not-an-object', res: null, count: 3, on: true });
  });
});

describe('platform/logger: DPoP secrets', () => {
  it('redacts an opaque dpop_nonce field, which only the local KEY pattern catches', () => {
    const { lines, sink } = capture();
    const log = createStructuredLogger({ sink, level: 'info' });
    const nonce = 'q8Zr3kVn1xMpLb7TfGhQaWcEdRyUiOpAsDfGhJkLzXcVbNm0';

    log.info({ dpop_nonce: nonce, auth_outcome: 'nonce_missing' }, 'rejected dpop proof');

    expect(lines[0]).not.toContain(nonce);
    expect(first(lines)['dpop_nonce']).toBe('[REDACTED]');
    // the OUTCOME is deliberately still legible: an operator needs it
    expect(first(lines)['auth_outcome']).toBe('nonce_missing');
  });
});
