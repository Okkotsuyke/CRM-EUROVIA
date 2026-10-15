#!/usr/bin/env bash
# CRM Eurovia — teste real PostgreSQL com banco efemero exclusivamente local.
set -euo pipefail
if [[ "$CRM_EUROVIA_RLS_CI" != "1" || "$PGHOST" != "127.0.0.1" ||
      "$PGPORT" != "5432" || "$PGDATABASE" != "eurovia_rls_ci" ||
      "$PGUSER" != "postgres" ]]; then
  echo "BLOQUEADO: homologacao autorizada somente no CI local eurovia_rls_ci"
  exit 1
fi

db() { psql -X --no-psqlrc -qAt -v ON_ERROR_STOP=1 "$@"; }
if [[ "$(db -c 'select current_database()')" != "eurovia_rls_ci" ]]; then
  echo "BLOQUEADO: DB inesperado"; exit 1
fi

echo "Criando roles artificiais e grants expostos APENAS em localhost..."
db <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
INSERT INTO public.stores
 ("id","shortName","syonetName",plaza,city,state,timezone)
VALUES
 ('ci-loja-1','CI Loja Eurovia','CI_LOJA_SINTETICA','FORTALEZA',
  'Fortaleza','CE','America/Fortaleza');
SQL

baseline="$(db -c 'SET ROLE anon; SELECT count(*) FROM public.stores; RESET ROLE;')"
if [[ "$baseline" != "1" ]]; then
  echo "FALHOU: baseline anon deveria ler loja ficticia"; exit 1
fi
echo "PASSO 1: falha original reproduzida (leitura anon de loja sintetica)"

db -f docs/security/eurovia-rls-firewall.sql >/dev/null

count="$(db -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r';")"
if [[ "$count" != "14" ]]; then
  echo "FALHOU: esperadas 14 tabelas; encontradas $count"; exit 1
fi

for table in stores users media_sources leads lead_events appointments flow_events sales productivity_snapshots sync_runs refresh_tokens sync_metrics dashboard_users validation_reports; do
  for role in anon authenticated; do
    result="$(db -c "SELECT c.relrowsecurity
       AND NOT has_table_privilege('$role', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname='$table' AND c.relkind='r';")"
    if [[ "$result" != "t" ]]; then
      echo "FALHOU: RLS/grants para $role na tabela $table"; exit 1
    fi
  done
done
echo "PASSO 2: 14 tabelas com RLS e sem privilegios para anon/authenticated"

for role in anon authenticated; do
  if db -c "SET ROLE $role; SELECT count(*) FROM public.stores;" >/dev/null 2>&1; then
    echo "FALHOU: SELECT permitido para $role"; exit 1
  fi
  if db -c "SET ROLE $role; UPDATE public.stores SET city='ALTERADA' WHERE id='ci-loja-1';" >/dev/null 2>&1; then
    echo "FALHOU: UPDATE permitido para $role"; exit 1
  fi
done
echo "PASSO 3: SELECT e UPDATE negados em ambas as roles"

visible="$(db -c 'BEGIN; GRANT SELECT ON public.stores TO anon; SET LOCAL ROLE anon; SELECT count(*) FROM public.stores; ROLLBACK;')"
if [[ "$visible" != "0" ]]; then
  echo "FALHOU: GRANT acidental contornou RLS"; exit 1
fi
echo "PASSO 4: RLS sem policies bloqueou leitura mesmo com GRANT temporario"

privileged="$(db -c 'SET ROLE service_role; SELECT count(*) FROM public.stores; RESET ROLE;')"
if [[ "$privileged" != "1" ]]; then
  echo "FALHOU: acesso tecnico service_role de teste"; exit 1
fi
echo "PASSO 5: service_role de teste ainda acessa (nao expor ao browser)"

db -c 'CREATE TABLE public.eurovia_ci_future_table (id integer);' >/dev/null
for role in anon authenticated; do
  permitted="$(db -c "SELECT has_table_privilege('$role','public.eurovia_ci_future_table','SELECT,INSERT,UPDATE,DELETE');")"
  if [[ "$permitted" != "f" ]]; then
    echo "FALHOU: tabela futura exposta para $role"; exit 1
  fi
done
db -c 'DROP TABLE public.eurovia_ci_future_table;' >/dev/null
echo "PASSO 6: tabelas futuras nao herdam grants publicos"
echo "HOMOLOGACAO SQL APROVADA: anon/authenticated bloqueados nas 14 tabelas."
