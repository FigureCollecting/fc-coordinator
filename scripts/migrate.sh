#!/bin/sh
# ============================================================================
# migrate.sh - PRODUCTION migration runner for fc-coordinator.
#
#   sh scripts/migrate.sh [migrations-dir]        (default: <repo>/migrations)
#
# Raw SQL + psql only: the estate's proven doctrine, carried over from
# fc-aggregation's tools/migrate.sh. No ORM, no migration framework. This is
# the script the k8s migration Job wraps; it assumes nothing about k8s.
#
# Contract:
#   * Applies pending migrations/NNNN_*.sql in numeric-prefix order.
#   * Each file commits ATOMICALLY WITH its ledger row:
#       psql -1 -v ON_ERROR_STOP=1 -f NNNN_x.sql -c "INSERT INTO schema_migrations ..."
#     --single-transaction (-1) wraps the -f and the -c in ONE transaction, so
#     a crash can never leave an applied-but-unrecorded migration. The files
#     are deliberately NON-idempotent (bare CREATE TABLE/INDEX), so that state
#     would wedge every retry on the first duplicate object. -1 is valid here
#     because every file is transactional DDL: no CREATE INDEX CONCURRENTLY,
#     no BEGIN/COMMIT of its own (enforced mechanically - next bullet).
#   * Pre-apply transaction-control scan (exit 5): every PENDING file is
#     tokenized BEFORE anything is applied; a top-level BEGIN / START / COMMIT
#     / END / ABORT / ROLLBACK / SAVEPOINT / RELEASE refuses the WHOLE run.
#     The runner owns transaction boundaries: an in-file COMMIT would end the
#     -1 wrapper early, so a later error would leave committed DDL with no
#     ledger row - the exact wedge -1 exists to prevent. The scan flags only
#     keywords that LEAD a statement (file start or after a top-level ";"),
#     outside -- and /* */ comments, single-quoted literals, double-quoted
#     identifiers and $tag$ bodies - so a plpgsql BEGIN/END body, a commit_sha
#     column, or "commit" in a comment never false-trips. Not modeled
#     (documented limits): SQL-standard BEGIN ATOMIC bodies (their inner ";"
#     would false-trip on END - use a $tag$-quoted language instead) and
#     E-strings with backslash-escaped quotes (do not use E in migrations).
#   * Fix-forward ordering (exit 6): a pending file whose numeric prefix is <=
#     the highest APPLIED prefix refuses the whole run - a late-added
#     back-dated file would make a fresh-DB numeric replay diverge from this
#     DB's real apply history. Numbering GAPS above the max stay allowed;
#     only the back-dated case is the error. Fix forward with a higher NNNN.
#   * Ledger public.schema_migrations (filename PK, sha256, applied_at) is
#     created if absent.
#   * Provenance guard: BEFORE anything is applied, every recorded row is
#     re-verified against the on-disk file. A changed sha256 - or a recorded
#     file missing from the tree - refuses the WHOLE run (exit 4): applied
#     migrations are immutable; fix forward with a new NNNN file.
#   * Already-applied, hash-identical files are skipped: re-run is a no-op.
#   * Runs as the schema OWNER role against the real database - NEVER a
#     superuser (SHOW is_superuser enforced, exit 2) and never the postgres/
#     template maintenance DBs. Extension creation, if fc-coordinator ever
#     needs one, is a separate one-time superuser BOOTSTRAP.
#
# Connection: standard libpq environment passed straight through to psql -
#   PGDATABASE (required), PGUSER (required), PGHOST, PGPORT, PGPASSWORD,
#   PGSSLMODE, PGSSLROOTCERT, ... - TLS is a deployment setting
#   (PGSSLMODE=verify-full + PGSSLROOTCERT), never a script change.
#
# Exit codes: 0 = success (applied and/or skipped) - 2 = config/preflight
#   refusal - 4 = provenance refusal - 5 = transaction control inside a
#   pending file - 6 = out-of-order (back-dated) pending file - other = psql
#   failure (that file's transaction rolled back whole: no DDL kept, no
#   ledger row).
#
# Concurrency: serialized on session-level advisory lock key
#   7377849944825291881 (0x6663636f6f726469, ASCII "fccoordi"), held by a
#   dedicated background psql session for the entire run (advisory locks are
#   per-database: runners against different databases do not collide). A
#   second runner blocks at "acquiring advisory lock...", then finds
#   everything applied and no-ops. The wait is indefinite by design - the
#   Job wrapper owns the timeout.
# ============================================================================
set -eu
export LC_ALL=C   # deterministic glob ordering + byte-exact tooling

die() { _c=$1; shift; printf 'migrate: ERROR: %s\n' "$*" >&2; exit "$_c"; }

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MIG_DIR=${1:-$ROOT/migrations}
[ -d "$MIG_DIR" ] || die 2 "migrations dir not found: $MIG_DIR"

[ -n "${PGDATABASE:-}" ] || die 2 "set PGDATABASE to the real target database"
[ -n "${PGUSER:-}" ]     || die 2 "set PGUSER to the schema OWNER role (never a superuser)"
case $PGDATABASE in
  postgres|template0|template1)
    die 2 "refusing maintenance database '$PGDATABASE' — point PGDATABASE at the real application database" ;;
esac

command -v psql >/dev/null 2>&1 || die 2 "psql not on PATH"
if command -v sha256sum >/dev/null 2>&1; then SHATOOL="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SHATOOL="shasum -a 256"
else die 2 "need sha256sum or shasum on PATH"; fi
sha256_of() { $SHATOOL -- "$1" | awk '{print $1}'; }

export PGAPPNAME=${PGAPPNAME:-fccoord-migrate}
PSQL="psql -X -q -v ON_ERROR_STOP=1"

# --- preflight: prove who/where, refuse superuser ---------------------------
info=$($PSQL -At -c "SELECT current_database()||' '||current_user||' '||current_setting('is_superuser')") ||
  die 2 "cannot connect (check PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD/PGSSLMODE)"
read -r cur_db cur_user is_super <<EOF
$info
EOF
[ "$is_super" = "off" ] ||
  die 2 "connected as SUPERUSER '$cur_user' — refused; run as the schema owner role (extensions are a separate superuser bootstrap)"
printf 'migrate: db=%s user=%s host=%s sslmode=%s dir=%s\n' \
  "$cur_db" "$cur_user" "${PGHOST:-<local socket>}" "${PGSSLMODE:-<libpq default>}" "$MIG_DIR"

# --- advisory lock: serialize concurrent runners ----------------------------
# Session-level lock on key 7377849944825291881, per-database. Every other psql here is its own short session,
# so the lock lives in a DEDICATED background psql that stays connected for
# the whole run: it takes the lock (-c), then blocks reading the FIFO (-f)
# until we close FD 9 at exit — session ends, lock releases. The parent's
# blocking open of the FIFO's write end doubles as the sync point: psql only
# opens the -f file AFTER the -c has returned, i.e. exec 9> unblocks exactly
# when the lock is held. A contested lock therefore blocks right here — the
# intended wait. Early exit (die/psql failure) auto-releases: process exit
# closes FD 9, the holder sees EOF and disconnects.
LOCK_KEY=7377849944825291881
WORK=$(mktemp -d "${TMPDIR:-/tmp}/fccoord-migrate.XXXXXX") || die 2 "mktemp failed"
trap 'rm -rf "$WORK"' EXIT
mkfifo "$WORK/lock.hold" || die 2 "mkfifo failed in $WORK"
$PSQL -At -c "SELECT pg_advisory_lock($LOCK_KEY)" -f "$WORK/lock.hold" >/dev/null 2>&1 &
LOCK_PID=$!
printf 'migrate: acquiring advisory lock %s (waits if another runner is active)...\n' "$LOCK_KEY"
exec 9>"$WORK/lock.hold"
printf 'migrate: advisory lock held\n'

# --- ledger (idempotent) ----------------------------------------------------
PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning" $PSQL -c "
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text        PRIMARY KEY,
  sha256     text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
)" >/dev/null

applied=$($PSQL -At -c "SELECT filename || ' ' || sha256 FROM schema_migrations ORDER BY filename")

# --- provenance sweep: refuse BEFORE touching anything ----------------------
if [ -n "$applied" ]; then
  while read -r fn rec_sha; do
    [ -n "$fn" ] || continue
    f="$MIG_DIR/$fn"
    [ -f "$f" ] ||
      die 4 "provenance: applied migration '$fn' is MISSING from $MIG_DIR — tree does not match history; refusing to run"
    disk_sha=$(sha256_of "$f")
    [ "$disk_sha" = "$rec_sha" ] ||
      die 4 "provenance: '$fn' on disk (sha256 $disk_sha) differs from its applied ledger row (sha256 $rec_sha) — applied migrations are immutable; refusing to apply or re-run anything (fix forward with a new NNNN file)"
  done <<EOF
$applied
EOF
fi

# --- enumerate: numeric-prefix order, safe names, unambiguous ---------------
set -- "$MIG_DIR"/[0-9][0-9][0-9][0-9]_*.sql
[ -e "$1" ] || die 2 "no NNNN_*.sql migration files in $MIG_DIR"
for f in "$@"; do
  b=$(basename "$f")
  case $b in
    *[!A-Za-z0-9._-]*) die 2 "unsafe migration filename (allowed: A-Za-z0-9 . _ -): $b" ;;
  esac
done
dups=$(for f in "$@"; do basename "$f"; done | cut -c1-4 | sort | uniq -d)
[ -z "$dups" ] || die 2 "duplicate numeric prefix(es) — ordering ambiguous: $(printf '%s' "$dups" | tr '\n' ' ')"

# --- pre-apply preflight on the PENDING set (nothing applied until it passes)
# tc_scan: tokenize one SQL file; emit "[line N: WORD]" for every top-level
# statement-LEADING transaction-control keyword. A tiny SQL lexer, not a grep:
# tracks ''-literals ('' doubling), ""-identifiers, $tag$-bodies, -- and
# nested /* */ comments; only the first word token after start-of-file or a
# top-level ';' is checked, as a whole word. Matching contract + documented
# limits (BEGIN ATOMIC, E'') in the header.
tc_scan() {
  awk '
  BEGIN { st = "n"; new = 1; depth = 0; tag = "" }
  {
    L = length($0); i = 1
    while (i <= L) {
      c = substr($0, i, 1)
      if (st == "sq") {
        if (c == "\047") { if (substr($0, i+1, 1) == "\047") i += 2; else { st = "n"; i++ } }
        else i++
        continue
      }
      if (st == "dq") { if (c == "\"") st = "n"; i++; continue }
      if (st == "dol") {
        if (c == "$" && substr($0, i, length(tag)) == tag) { st = "n"; i += length(tag) }
        else i++
        continue
      }
      if (st == "bc") {
        if (c == "*" && substr($0, i+1, 1) == "/") { depth--; i += 2; if (depth == 0) st = "n" }
        else if (c == "/" && substr($0, i+1, 1) == "*") { depth++; i += 2 }
        else i++
        continue
      }
      if (c == "-" && substr($0, i+1, 1) == "-") break
      if (c == "/" && substr($0, i+1, 1) == "*") { st = "bc"; depth = 1; i += 2; continue }
      if (c == "\047") { st = "sq"; new = 0; i++; continue }
      if (c == "\"") { st = "dq"; new = 0; i++; continue }
      if (c == "$") {
        rest = substr($0, i); tag = ""
        if (substr(rest, 2, 1) == "$") tag = "$$"
        else if (match(rest, /^\$[A-Za-z_][A-Za-z0-9_]*\$/)) tag = substr(rest, 1, RLENGTH)
        if (tag != "") { st = "dol"; new = 0; i += length(tag); continue }
        new = 0; i++; continue
      }
      if (c == ";") { new = 1; i++; continue }
      if (c ~ /[A-Za-z_]/) {
        w = c; i++
        while (i <= L) { d = substr($0, i, 1); if (d ~ /[A-Za-z0-9_]/) { w = w d; i++ } else break }
        if (new) {
          lw = tolower(w)
          if (lw == "begin" || lw == "start" || lw == "commit" || lw == "end" ||
              lw == "abort" || lw == "rollback" || lw == "savepoint" || lw == "release")
            printf "[line %d: %s]", NR, w
        }
        new = 0
        continue
      }
      if (c == " " || c == "\t" || c == "\r") { i++; continue }
      new = 0; i++
    }
  }' "$1"
}

max_applied=$(printf '%s\n' "$applied" | awk '{ p = substr($1, 1, 4); if (p > m) m = p } END { print m }')
for f in "$@"; do
  b=$(basename "$f")
  rec_sha=$(printf '%s\n' "$applied" | awk -v f="$b" '$1==f{print $2}')
  if [ -n "$rec_sha" ]; then continue; fi   # applied files are sha-locked, not rescanned
  if [ -n "$max_applied" ] && [ "${b%%_*}" -le "$max_applied" ]; then
    die 6 "out-of-order migration '$b': prefix ${b%%_*} <= highest applied prefix $max_applied — a back-dated file would make a fresh-DB replay diverge from this DB's history; fix forward with a prefix above $max_applied (gaps are fine)"
  fi
  tc=$(tc_scan "$f")
  [ -z "$tc" ] ||
    die 5 "transaction control inside '$b' $tc — the runner owns transaction boundaries (psql -1); migration files must not BEGIN/COMMIT/END/ROLLBACK/SAVEPOINT; remove these statements"
done

# --- apply pending, in order, one transaction per file+ledger-row -----------
n_applied=0 n_skipped=0
for f in "$@"; do
  b=$(basename "$f")
  disk_sha=$(sha256_of "$f")
  rec_sha=$(printf '%s\n' "$applied" | awk -v f="$b" '$1==f{print $2}')
  if [ -n "$rec_sha" ]; then
    # sweep above already proved rec_sha == disk_sha
    printf 'migrate: skip  %s (already applied, sha256 verified)\n' "$b"
    n_skipped=$((n_skipped+1))
    continue
  fi
  printf 'migrate: apply %s (sha256 %s)\n' "$b" "$disk_sha"
  if $PSQL -1 -f "$f" -c "INSERT INTO schema_migrations (filename, sha256, applied_at) VALUES ('$b', '$disk_sha', now())"; then
    n_applied=$((n_applied+1))
  else
    rc=$?   # actual psql exit status (the failing condition's own code)
    printf 'migrate: FAILED %s — single transaction rolled back: no DDL kept, no ledger row; fix and re-run\n' "$b" >&2
    exit "$rc"
  fi
done

# --- release advisory lock (EOF the holder session) -------------------------
exec 9>&-
wait "$LOCK_PID" 2>/dev/null || true
printf 'migrate: done — applied=%d skipped=%d (db=%s ledger=schema_migrations)\n' "$n_applied" "$n_skipped" "$cur_db"
