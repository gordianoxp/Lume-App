#!/usr/bin/env bash
# Teste de integração no navegador: monta um PostgreSQL local com as migrações REAIS, sobe o servidor simulado
# (fake_backend.py) e roda os cenários com o Playwright. Veja o cabeçalho de fake_backend.py para o que é simulado.
# Uso (como root, com Postgres instalado):  bash tests/integration/run_it.sh [arquivo_de_teste.py]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DBNAME=${DBNAME:-org_it}; PORT=${PORT:-8790}; TLS_PORT=${TLS_PORT:-8443}
export DBNAME PORT TLS_PORT
chmod -R a+rX "$ROOT"
pg_ctlcluster 16 main start 2>/dev/null || true; sleep 1

pg() { su postgres -c "psql -X -q -v ON_ERROR_STOP=1 -d $1 ${2:--f $3}"; }
su postgres -c "psql -X -q -d postgres -c 'drop database if exists $DBNAME' -c 'create database $DBNAME'"
for f in "$ROOT/supabase/tests/00_supabase_shim.sql" "$ROOT"/supabase/migrations/*.sql "$ROOT/tests/integration/00_fakeauth.sql"; do
  su postgres -c "psql -X -q -v ON_ERROR_STOP=1 -d $DBNAME -f $f" 2>&1 | grep -v -E "wal_level|HINT" || true
done

pkill -f fake_backend.py 2>/dev/null || true
su postgres -c "cd $ROOT && DBNAME=$DBNAME PORT=$PORT TLS_PORT=$TLS_PORT nohup python3 tests/integration/fake_backend.py > /tmp/fake_backend.log 2>&1 &"
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/_api/changes" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$PORT/_api/changes" >/dev/null || { echo "servidor de teste não subiu"; cat /tmp/fake_backend.log; exit 1; }

cd "$ROOT/tests/integration"
python3 "${1:-it_test.py}"
