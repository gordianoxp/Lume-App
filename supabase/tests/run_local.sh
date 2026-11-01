#!/usr/bin/env bash
# Roda migrações + testes de segurança num PostgreSQL LOCAL (com um substituto mínimo do Supabase).
# Uso:  bash supabase/tests/run_local.sh            (precisa de um Postgres 14+ com pgcrypto e acesso de superusuário)
# Variáveis opcionais: PSQL="psql -h localhost -U postgres"  DBNAME=org_test
set -euo pipefail
cd "$(dirname "$0")/.."
PSQL=${PSQL:-"psql"}
DBNAME=${DBNAME:-org_test}

$PSQL -v ON_ERROR_STOP=1 -d postgres -qc "drop database if exists $DBNAME" -c "create database $DBNAME"
run() { echo "→ $1"; $PSQL -v ON_ERROR_STOP=1 -d "$DBNAME" -q -f "$1"; }

run tests/00_supabase_shim.sql
for f in migrations/*.sql; do run "$f"; done
run tests/security_test.sql
[ -f tests/extra_test.sql ] && run tests/extra_test.sql
[ -f tests/avatar_test.sql ] && run tests/avatar_test.sql
echo "FIM: todos os arquivos de teste terminaram sem erro."
