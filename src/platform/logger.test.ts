import Fastify from 'fastify';
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

// What server.ts hands over is process.env.LOG_LEVEL as it was typed: nothing checked it before.
describe('platform/logger: the level it is given', () => {
  const FALLBACK = 'log.level_fallback';
  const levelsOf = (lines: string[]): string[] => lines.map((l) => (JSON.parse(l) as { level: string }).level);

  function emitAll(level: unknown): Line[] {
    const { lines, sink } = capture();
    const log = createStructuredLogger({ level: level as string, sink });
    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    log.fatal('f');
    return lines.map((l) => JSON.parse(l) as Line);
  }

  it.each([
    ['INFO', ['info', 'warn', 'error', 'fatal']],
    ['Info', ['info', 'warn', 'error', 'fatal']],
    [' info', ['info', 'warn', 'error', 'fatal']],
    ['\tWARN \n', ['warn', 'error', 'fatal']],
    ['Debug', ['debug', 'info', 'warn', 'error', 'fatal']],
    ['TRACE', ['trace', 'debug', 'info', 'warn', 'error', 'fatal']],
    ['FATAL', ['fatal']],
    ['Silent', []],
  ])('reads %j as the level it names, in any case and with spaces around it, and says nothing about it', (given, expected) => {
    const entries = emitAll(given);
    expect(entries.map((e) => e['level'])).toEqual(expected);
    expect(entries.filter((e) => e['event'] === FALLBACK)).toEqual([]);
  });

  it.each([['warning'], ['verbose'], [''], ['   '], ['constructor'], ['toString'], ['30'], [30], [null]])(
    'logs at info for %j, which is no level, rather than going silent',
    (given) => {
      const entries = emitAll(given);
      const own = entries.filter((e) => e['event'] !== FALLBACK);
      expect(own.map((e) => e['level'])).toEqual(['info', 'warn', 'error', 'fatal']);
    },
  );

  it('says so once, first, at warn, naming what it was given', () => {
    const { lines, sink } = capture();
    const log = createStructuredLogger({ level: 'verbose', sink });

    expect(lines).toHaveLength(1);
    expect(first(lines)).toMatchObject({ level: 'warn', event: FALLBACK, log_level_given: 'verbose', log_level: 'info' });
    expect(first(lines)['msg']).toContain('LOG_LEVEL');

    log.info('one');
    log.child({ reqId: 'r-1' }).info('two');
    log.child({ reqId: 'r-2' }, { level: 'nonsense' as never }).info('three');
    expect(lines.filter((l) => l.includes(FALLBACK))).toHaveLength(1);
    expect(lines).toHaveLength(4);
  });

  it('reports info as its level after a fallback: Fastify reads it', () => {
    expect(createStructuredLogger({ level: 'verbose', sink: () => {} }).level).toBe('info');
    expect(createStructuredLogger({ level: ' WARN', sink: () => {} }).level).toBe('warn');
  });

  it('says nothing when no level is given', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ sink });
    expect(lines).toEqual([]);
  });

  it('prints the value it was given as any other field: a secret-shaped one is masked, a long one cut', () => {
    const jws = 'eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand0In0.eyJzdWIiOiJyb3NzIn0.c2ln';
    const { lines, sink } = capture();
    createStructuredLogger({ level: `${jws}\n${'x'.repeat(5000)}`, sink });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(jws);
    expect((lines[0] as string).length).toBeLessThan(1500);
    expect(levelsOf(lines)).toEqual(['warn']);
  });
});

// S2 (chal1): a 500 logged no stack at all once the line went through fc-shared, whose `err` is
// {type, message}. The frames are back, as error_stack, on error and fatal lines only.
describe('platform/logger: an error line carries the stack', () => {
  const HERE = 'logger.test.ts';

  it('writes the frames as error_stack when an Error is the first argument, and keeps err and msg', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ sink }).error(new Error('db down'));

    const entry = first(lines);
    expect(entry['err']).toEqual({ type: 'Error', message: 'db down' });
    expect(entry['msg']).toBe('db down');
    expect(entry['error_stack']).toMatch(/^\s*at /);
    expect(entry['error_stack']).toContain(HERE);
    expect(lines[0]).not.toContain('\\n');
  });

  it('keeps the message a caller gives after the Error', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ sink }).error(new Error('db down'), 'sync push', 'failed');

    expect(first(lines)).toMatchObject({ msg: 'sync push failed', err: { type: 'Error', message: 'db down' } });
    expect(first(lines)['error_stack']).toContain(HERE);
  });

  it('writes it for the shape Fastify logs a 500 in: ({ err, ... }, msg)', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ sink }).error({ err: new TypeError('x is not a function'), reqId: 'r-1' }, 'handler failed');

    const entry = first(lines);
    expect(entry).toMatchObject({ msg: 'handler failed', req_id: 'r-1', err: { type: 'TypeError', message: 'x is not a function' } });
    expect(entry['error_stack']).toContain(HERE);
  });

  it('writes it at fatal, and on a child logger', () => {
    const { lines, sink } = capture();
    const log = createStructuredLogger({ sink });
    log.fatal(new Error('out of memory'));
    log.child({ reqId: 'r-1' }).child({ route: '/x' }).error({ err: new Error('nested') }, 'child');

    const entries = lines.map((l) => JSON.parse(l) as Line);
    expect(entries[0]?.['level']).toBe('fatal');
    expect(entries[0]?.['error_stack']).toContain(HERE);
    expect(entries[1]).toMatchObject({ req_id: 'r-1', route: '/x' });
    expect(entries[1]?.['error_stack']).toContain(HERE);
  });

  it('writes none below error: a 4xx Fastify logs at info, and a warn, stay one short line', () => {
    const { lines, sink } = capture();
    const log = createStructuredLogger({ level: 'trace', sink });
    log.trace(new Error('t'));
    log.debug({ err: new Error('d') }, 'd');
    log.info({ err: new Error('i') }, 'i');
    log.warn(new Error('w'));

    expect(lines).toHaveLength(4);
    for (const line of lines) expect(JSON.parse(line) as Line).not.toHaveProperty('error_stack');
  });

  it('writes nothing at all when the level is above error, and nothing extra at silent', () => {
    const { lines, sink } = capture();
    createStructuredLogger({ level: 'fatal', sink }).error(new Error('dropped'));
    createStructuredLogger({ level: 'silent', sink }).fatal(new Error('dropped'));
    expect(lines).toEqual([]);
  });

  it('leaves a line with no Error on it alone', () => {
    const { lines, sink } = capture();
    const log = createStructuredLogger({ sink });
    log.error('boom');
    log.error({ err: 'not an Error', count: 2 }, 'odd');
    log.error({ reqId: 'r-1' }, 'no err');
    log.error(null, 'null first');
    log.error(['a', 'b']);
    (log.error as () => void)();

    expect(lines).toHaveLength(6);
    for (const line of lines) expect(JSON.parse(line) as Line).not.toHaveProperty('error_stack');
    expect(JSON.parse(lines[1] as string)).toMatchObject({ msg: 'odd', err: { type: 'string', message: 'not an Error' }, count: 2 });
  });

  it('writes no error_stack for an Error with no frames, and still writes the line', () => {
    const { lines, sink } = capture();
    const log = createStructuredLogger({ sink });
    const bare = new Error('no stack');
    delete bare.stack;
    const custom = new Error('custom stack');
    custom.stack = 'custom stack: a line that is no frame';
    const numeric = new Error('numeric stack');
    (numeric as { stack: unknown }).stack = 42;
    log.error(bare);
    log.error({ err: custom }, 'custom');
    log.error(numeric);

    expect(lines).toHaveLength(3);
    for (const line of lines) expect(JSON.parse(line) as Line).not.toHaveProperty('error_stack');
    expect(lines.join('\n')).not.toContain('a line that is no frame');
  });

  it('never throws for an Error it cannot read: the line is written without the stack', () => {
    const { lines, sink } = capture();
    const hostile = new Error('hostile');
    Object.defineProperty(hostile, 'stack', {
      get() {
        throw new Error('stack getter');
      },
    });

    expect(() => createStructuredLogger({ sink }).error({ err: hostile }, 'handler failed')).not.toThrow();
    expect(first(lines)).toMatchObject({ msg: 'handler failed', err: { type: 'Error', message: 'hostile' } });
    expect(first(lines)).not.toHaveProperty('error_stack');
  });

  it('only reads err on a plain object: a class instance is passed on as it came', () => {
    class Wrapper {
      err = new Error('inside a class');
    }
    const { lines, sink } = capture();
    createStructuredLogger({ sink }).error(new Wrapper(), 'wrapped');
    createStructuredLogger({ sink }).error(Object.assign(Object.create(null) as object, { err: new Error('null proto') }), 'bare');

    expect(JSON.parse(lines[0] as string) as Line).not.toHaveProperty('error_stack');
    expect((JSON.parse(lines[1] as string) as Line)['error_stack']).toContain(HERE);
  });

  it('does not change the object it was handed', () => {
    const fields = { err: new Error('db down'), reqId: 'r-1' };
    createStructuredLogger({ sink: () => {} }).error(fields, 'handler failed');
    expect(Object.keys(fields)).toEqual(['err', 'reqId']);
  });

  it('cuts a long stack at the value cap, top frames first', () => {
    const deep = new Error('deep');
    deep.stack = `Error: deep\n${Array.from({ length: 200 }, (_, i) => `    at fn${i} (/app/dist/file${i}.js:${i}:1)`).join('\n')}`;
    const { lines, sink } = capture();
    createStructuredLogger({ sink }).error(deep);

    const stack = first(lines)['error_stack'] as string;
    expect(stack).toContain('at fn0 (/app/dist/file0.js:0:1)');
    expect(stack).not.toContain('fn199');
    expect(stack.length).toBeLessThan(1100);
  });
});

// The ruling on S2: no secret may ride a stack. V8 copies the message into the stack's header, and
// fc-shared masks a message as a whole (a JSON document's keys, a header line, a form body): rules
// that do not see it once frames follow it. So the header is not printed again; the frames are.
describe('platform/logger: no secret rides the stack', () => {
  const JWS = 'eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand0In0.eyJzdWIiOiJyb3NzIn0.c2ln';

  it.each([
    ['a bearer token', 'upstream said no: Bearer SxMARKERbearer0123456789abcdef', 'SxMARKERbearer'],
    ['a compact JWS', `assertion rejected ${JWS}`, JWS],
    ['a URL with userinfo and a query', 'GET https://fc:SxMARKERuserinfo@pg.example/db?token=SxMARKERquery failed', 'SxMARKER'],
    ['a JSON document with a secret key', '{"password":"SxMARKERjson","user":"ross"}', 'SxMARKERjson'],
    ['a header line', 'Authorization: Basic SxMARKERheader', 'SxMARKERheader'],
    ['a cookie header line', 'Cookie: sid=SxMARKERcookie', 'SxMARKERcookie'],
    ['a form body', 'client_secret=SxMARKERform&grant_type=refresh_token', 'SxMARKERform'],
    ['a message of several lines', `first line\nBearer SxMARKERmultiline0123456789abcdef\nlast line`, 'SxMARKERmultiline'],
    ['a frame-shaped line in the message', `failed\n    at Bearer SxMARKERframe0123456789abcdef`, 'SxMARKERframe'],
  ])('masks %s in the message and does not print it in the stack', (_label, message, marker) => {
    const { lines, sink } = capture();
    const log = createStructuredLogger({ sink });
    log.error(new Error(message));
    log.error({ err: new Error(message) }, 'handler failed');

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain(marker);
      expect((JSON.parse(line) as Line)['error_stack']).toContain('logger.test.ts');
    }
  });

  it('masks a secret a custom stack carries in a frame', () => {
    const custom = new Error('custom');
    custom.stack = `Error: custom\n    at handler (https://fc:SxMARKERpw@h.example/app.js?sig=SxMARKERsig:1:2)\n    at Bearer SxMARKERbearer0123456789abcdef`;
    const { lines, sink } = capture();
    createStructuredLogger({ sink }).error(custom);

    expect(lines[0]).not.toContain('SxMARKER');
    expect(first(lines)['error_stack']).toContain('at handler');
  });

  it('a real Fastify 500 logs the stack, with the secret in its message masked', async () => {
    const { lines, sink } = capture();
    const app = Fastify({ loggerInstance: createStructuredLogger({ sink }) });
    app.get('/boom', async function boomHandler() {
      throw new Error('{"password":"SxMARKERfastify","detail":"pg: relation does not exist"}');
    });
    const response = await app.inject({ method: 'GET', url: '/boom' });
    await app.close();

    expect(response.statusCode).toBe(500);
    const failed = lines.map((l) => JSON.parse(l) as Line).filter((e) => e['level'] === 'error');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.['error_stack']).toContain('boomHandler');
    expect(failed[0]?.['error_stack']).toContain('logger.test.ts');
    expect(failed[0]?.['err']).toMatchObject({ type: 'Error' });
    expect(lines.join('\n')).not.toContain('SxMARKERfastify');
  });
});
