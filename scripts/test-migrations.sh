#!/usr/bin/env bash
# Applies database/migrations/001-010 to a throwaway local PostgreSQL 15,
# re-applies 010 to prove it is idempotent, seeds fixtures and runs the SQL
# assertions in scripts/migration-tests/. Never touches a remote database:
# the server listens only on a unix socket in a temp directory, and is
# stopped and deleted on exit.
#
# Usage: scripts/test-migrations.sh
#
# Finding PostgreSQL 15 server binaries (initdb, pg_ctl, postgres), in order:
#   1. PG_BIN=/path/to/bin
#   2. /usr/lib/postgresql/15/bin, then pg_config --bindir if it reports 15
#   3. FETCH_PG=1 downloads the @embedded-postgres/linux-x64 15.x binaries
#      from npm into ${PG_CACHE_DIR:-$HOME/.cache/ai-cost-dashboard/pg15}
# psql may be any recent client; it's taken from PG_BIN if present, else PATH.
# PG_REQUIRE_MAJOR (default 15) sets the required server major version.
# When run as root, the server runs as PG_RUN_AS (default: postgres).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS="$ROOT/database/migrations"
TESTS="$ROOT/scripts/migration-tests"
REQUIRE_MAJOR="${PG_REQUIRE_MAJOR:-15}"
EMBEDDED_PG_VERSION="${EMBEDDED_PG_VERSION:-15.19.0-beta.19}"

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

fetch_pg() {
  local cache="${PG_CACHE_DIR:-$HOME/.cache/ai-cost-dashboard/pg15}"
  if [[ ! -x "$cache/package/native/bin/postgres" ]]; then
    command -v npm >/dev/null || die "FETCH_PG=1 needs npm"
    log "Downloading @embedded-postgres/linux-x64@$EMBEDDED_PG_VERSION into $cache" >&2
    mkdir -p "$cache"
    (cd "$cache" && npm pack --silent "@embedded-postgres/linux-x64@$EMBEDDED_PG_VERSION" >/dev/null \
      && tar xzf embedded-postgres-linux-x64-*.tgz \
      && node package/scripts/hydrate-symlinks.js)
    chmod -R a+rX "$cache"
  fi
  echo "$cache/package/native/bin"
}

find_pg_bin() {
  if [[ -n "${PG_BIN:-}" ]]; then echo "$PG_BIN"; return; fi
  if [[ -x "/usr/lib/postgresql/$REQUIRE_MAJOR/bin/postgres" ]]; then
    echo "/usr/lib/postgresql/$REQUIRE_MAJOR/bin"; return
  fi
  if command -v pg_config >/dev/null; then
    local bindir; bindir="$(pg_config --bindir)"
    if [[ -x "$bindir/postgres" ]] && "$bindir/postgres" --version | grep -q " $REQUIRE_MAJOR\."; then
      echo "$bindir"; return
    fi
  fi
  if [[ "${FETCH_PG:-0}" == "1" ]]; then fetch_pg; return; fi
  die "PostgreSQL $REQUIRE_MAJOR server binaries not found. Set PG_BIN, install postgresql-$REQUIRE_MAJOR, or re-run with FETCH_PG=1."
}

PG_BIN="$(find_pg_bin)"
for b in initdb pg_ctl postgres; do
  [[ -x "$PG_BIN/$b" ]] || die "$PG_BIN/$b not found"
done
PG_VERSION="$("$PG_BIN/postgres" --version)"
[[ "$PG_VERSION" == *" $REQUIRE_MAJOR."* ]] || die "need PostgreSQL $REQUIRE_MAJOR, found: $PG_VERSION"
if [[ -x "$PG_BIN/psql" ]]; then PSQL="$PG_BIN/psql"; else PSQL="$(command -v psql)" || die "psql not found"; fi
log "Server: $PG_VERSION ($PG_BIN)"
log "Client: $("$PSQL" --version)"

# initdb/postgres refuse to run as root.
AS=()
if [[ "$(id -u)" == "0" ]]; then
  RUN_AS="${PG_RUN_AS:-postgres}"
  id "$RUN_AS" >/dev/null 2>&1 || die "running as root: create user '$RUN_AS' or set PG_RUN_AS"
  AS=(runuser -u "$RUN_AS" --)
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ai-cost-migrations.XXXXXX")"
DATA="$WORK/data"
SOCK="$WORK/sock"
mkdir -p "$SOCK"
[[ ${#AS[@]} -gt 0 ]] && chown -R "$RUN_AS" "$WORK"

cleanup() {
  "${AS[@]}" "$PG_BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

log "initdb in $WORK"
"${AS[@]}" "$PG_BIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 --no-locale >"$WORK/initdb.log" 2>&1 \
  || { cat "$WORK/initdb.log"; die "initdb failed"; }
"${AS[@]}" "$PG_BIN/pg_ctl" -D "$DATA" -l "$WORK/server.log" -w \
  -o "-k $SOCK -c listen_addresses='' -c port=54329 -c fsync=off" start >/dev/null \
  || { cat "$WORK/server.log"; die "postgres failed to start"; }

export PGHOST="$SOCK" PGPORT=54329 PGUSER=postgres PGDATABASE=postgres
unset PGPASSWORD PGSERVICE DATABASE_URL

run_sql() { # file -> prints psql output minus "already exists, skipping" noise
  local rc=0
  "$PSQL" -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$1" >"$WORK/last.out" 2>&1 || rc=$?
  grep -Ev 'NOTICE:  .*(skipping|already exists)' "$WORK/last.out" || true
  return "$rc"
}

log "Applying Supabase auth stub"
run_sql "$TESTS/auth_stub.sql" >/dev/null

mapfile -t FILES < <(find "$MIGRATIONS" -maxdepth 1 -name '0[0-9][0-9]_*.sql' | sort)
[[ ${#FILES[@]} -ge 10 ]] || die "expected migrations 001-010, found ${#FILES[@]}"
for f in "${FILES[@]}"; do
  log "Applying $(basename "$f")"
  run_sql "$f" >/dev/null || die "$(basename "$f") failed"
done

M010="$MIGRATIONS/010_org_structure.sql"
log "Re-applying 010_org_structure.sql (idempotency, empty tables)"
run_sql "$M010" >/dev/null || die "re-applying 010 failed"

log "Seeding fixtures"
run_sql "$TESTS/fixtures.sql" >/dev/null || die "fixtures failed"

log "Running assertions"
OUT="$(run_sql "$TESTS/assertions.sql")" && rc=0 || rc=$?
printf '%s\n' "$OUT" | sed -n 's/^.*NOTICE:  \(PASS\|FAIL\)/  \1/p'
if [[ $rc -ne 0 ]]; then
  printf '%s\n' "$OUT" | grep -E 'ERROR|FAIL' >&2 || true
  die "assertions failed"
fi

log "Re-applying 010_org_structure.sql (idempotency, with data)"
run_sql "$M010" >/dev/null || die "re-applying 010 with data failed"
RECON="$("$PSQL" -X -qAt -v ON_ERROR_STOP=1 -c "
  SELECT count(*) FROM (
    SELECT date, sum(total_cost_usd) c FROM cost_records_daily_attributed GROUP BY date
  ) a FULL JOIN (
    SELECT date, sum(total_cost_usd) c FROM cost_records_daily GROUP BY date
  ) d USING (date) WHERE a.c IS DISTINCT FROM d.c")"
[[ "$RECON" == "0" ]] || die "totals do not reconcile after re-applying 010"
echo "  PASS: 010 re-applied over existing data; totals still reconcile"

PASSES="$(printf '%s\n' "$OUT" | grep -c 'NOTICE:  PASS' || true)"
log "OK: 001-010 applied, 010 idempotent, $((PASSES + 1)) assertions passed"
