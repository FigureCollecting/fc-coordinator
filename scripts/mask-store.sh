#!/bin/sh
# ============================================================================
# mask-store.sh - revoke or restore ONE store's cut-out masks at the coordinator (MASK-G, Ross
# 2026-10-11 option b; the runbook "a store asks for its cut-outs to be removed").
#
#   sh scripts/mask-store.sh revoke  <source> [--reason TEXT] [--apply]
#   sh scripts/mask-store.sh restore <source> [--apply]
#
# <source> is the store's site key (the spine's source.site, media-manager's gallery source): white
# space around it is dropped and A-Z folded to a-z, as the coordinator matches it. Without --apply it
# only prints what it would do. A revocation is one display_restriction row (migration 0008):
# rule mask-store:<source>, level source, scope no_mask. GetProductImages then sends every image
# captured from the store with its clean copy and without its mask (and the grounding and appearance
# that come from it), within the coordinator's restriction cache period (30 s, src/display/source.ts);
# a phone drops the masks it kept at its next owned sync. restore removes that row and nothing else:
# any other restriction naming the store stays, and is listed.
#
# Connection: the libpq environment, as scripts/migrate.sh takes it (PGDATABASE and PGUSER required;
# PGHOST, PGPORT, PGPASSWORD, PGSSLMODE, ...). Run it as the coordinator MIGRATOR: the app role may
# only read restrictions (0007), so it is refused.
#
# Exit codes: 0 = done, or nothing to do - 2 = refused before connecting (usage, source, environment)
#   - 3 = the database refused or could not be reached (nothing written).
# ============================================================================
set -eu
export LC_ALL=C

die() { _c=$1; shift; printf 'mask-store: ERROR: %s\n' "$*" >&2; exit "$_c"; }
say() { printf 'mask-store: %s\n' "$*"; }
USAGE="usage: mask-store.sh revoke <source> [--reason TEXT] [--apply] | restore <source> [--apply]"

[ $# -ge 2 ] || die 2 "$USAGE"
action=$1
raw=$2
shift 2
case $action in
  revoke | restore) ;;
  *) die 2 "unknown action '$action'; $USAGE" ;;
esac

apply=0
reason="a store asked for its cut-outs to be removed (MASK-G)"
while [ $# -gt 0 ]; do
  case $1 in
    --apply) apply=1 ;;
    --reason)
      [ "$action" = revoke ] || die 2 "--reason is for revoke only"
      [ $# -ge 2 ] && [ -n "$2" ] || die 2 "--reason needs a text"
      reason=$2
      shift
      ;;
    *) die 2 "unknown argument '$1'; $USAGE" ;;
  esac
  shift
done

# The site key as the coordinator matches it: surrounding white space dropped, A-Z folded, nothing else.
key=$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' | tr 'A-Z' 'a-z')
[ -n "$key" ] || die 2 "the source is empty"
case $key in
  *[[:space:]]* | *[[:cntrl:]]*) die 2 "a site key has no white space or control character inside it" ;;
esac
# rule_id holds 128 characters (0007), 11 of them 'mask-store:'.
[ ${#key} -le 117 ] || die 2 "the source is longer than 117 characters"
rule="mask-store:$key"

[ -n "${PGDATABASE:-}" ] || die 2 "set PGDATABASE to the coordinator's database"
[ -n "${PGUSER:-}" ] || die 2 "set PGUSER to the coordinator migrator role"
command -v psql >/dev/null 2>&1 || die 2 "psql not on PATH"
export PGAPPNAME=${PGAPPNAME:-fccoord-mask-store}

q() { psql -X -q -At -v ON_ERROR_STOP=1 -v key="$key" -v rule="$rule" -v reason="$reason" -f - 2>&1; }

who=$(q <<'SQL'
SELECT current_database() || ' ' || current_user;
SQL
) || die 3 "cannot connect (check PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD/PGSSLMODE): $who"
say "db=${who% *} user=${who#* } source=$key rule=$rule"

state=$(q <<'SQL'
SELECT 'since|' || to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  FROM display_restriction WHERE rule_id = :'rule';
SELECT 'other|' || rule_id || ' (' || level || ', ' || scope || ')'
  FROM display_restriction
 WHERE rule_id <> :'rule'
   AND translate(subject, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') = :'key'
 ORDER BY rule_id;
SQL
) || die 3 "cannot read display_restriction: $state"
since=$(printf '%s\n' "$state" | sed -n 's/^since|//p')
others=$(printf '%s\n' "$state" | sed -n 's/^other|//p' | awk 'NR > 1 { printf "; " } { printf "%s", $0 }')

if [ -n "$since" ]; then say "$key: revoked since $since"; else say "$key: not revoked"; fi
[ -z "$others" ] || say "other restrictions naming $key stay: $others"

if [ "$apply" -eq 0 ]; then
  case $action:$since in
    revoke:) say "DRY RUN: --apply would add rule $rule (level source, scope no_mask): every image captured from $key keeps its clean copy and loses its mask" ;;
    revoke:*) say "DRY RUN: already revoked, --apply would write nothing" ;;
    restore:) say "DRY RUN: not revoked, --apply would remove nothing" ;;
    restore:*) say "DRY RUN: --apply would remove rule $rule" ;;
  esac
  exit 0
fi

if [ "$action" = revoke ]; then
  done=$(q <<'SQL'
INSERT INTO display_restriction (rule_id, level, subject, scope, reason)
VALUES (:'rule', 'source', :'key', 'no_mask', :'reason')
ON CONFLICT (rule_id) DO NOTHING
RETURNING 'written';
SQL
  ) || die 3 "the revocation was not written: $done"
  if [ "$done" = written ]; then
    say "REVOKED $key: rule $rule written; GetProductImages withholds its masks within the coordinator's restriction cache period (30 s), and a phone drops the masks it kept at its next owned sync"
  else
    say "$key was already revoked (since $since): nothing written"
  fi
else
  done=$(q <<'SQL'
DELETE FROM display_restriction WHERE rule_id = :'rule' RETURNING 'removed';
SQL
  ) || die 3 "the revocation was not removed: $done"
  if [ "$done" = removed ]; then
    say "RESTORED $key: rule $rule removed; GetProductImages sends its masks again within the coordinator's restriction cache period (30 s)"
  else
    say "$key was not revoked: nothing removed"
  fi
fi
