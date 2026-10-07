// Everything the Phase-2 client prints goes through here. It is built never to print a token, a
// code, a verifier, a proof, a nonce or key material, and the full-run test asserts both that
// none appears and that this writer never had to scrub one. This is the second line: every
// secret the run handles is registered, and any line that would carry one is scrubbed.

export const REDACTED = '[redacted]';
/** Shorter values are not secrets worth scrubbing, and scrubbing them would mangle ordinary text. */
export const MIN_SECRET_LENGTH = 8;

export interface Sink {
  write(chunk: string): unknown;
}

export interface SafeOutput {
  out(line: string): void;
  err(line: string): void;
  /** Register a value that must never be printed. A JWT's segments are registered too. */
  secret(value: string | undefined): void;
  /** How many occurrences were scrubbed: zero on a well-behaved run. */
  readonly redactions: number;
}

export function createSafeOutput(stdout: Sink, stderr: Sink): SafeOutput {
  const secrets = new Set<string>();
  let redactions = 0;

  const scrub = (line: string): string => {
    let text = line;
    // Longest first, so a secret that contains another is replaced whole.
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      const parts = text.split(secret);
      redactions += parts.length - 1;
      text = parts.join(REDACTED);
    }
    return text;
  };

  const register = (value: string): void => {
    if (value.length >= MIN_SECRET_LENGTH) secrets.add(value);
  };

  return {
    out: (line) => void stdout.write(`${scrub(line)}\n`),
    err: (line) => void stderr.write(`${scrub(line)}\n`),
    secret(value) {
      if (value === undefined) return;
      register(value);
      for (const segment of value.split('.')) register(segment);
    },
    get redactions() {
      return redactions;
    },
  };
}
