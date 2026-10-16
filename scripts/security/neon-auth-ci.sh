#!/usr/bin/env bash
# CRM Eurovia auth CI: disposable PostgreSQL 17, no Neon/Supabase/Syonet.
set -euo pipefail
if [[ "$CRM_EUROVIA_AUTH_CI" != "1" || "$PGHOST" != "127.0.0.1" ||
      "$PGPORT" != "5432" || "$PGDATABASE" != "crm_eurovia" ||
      "$PGUSER" != "postgres" ]]; then
  echo "STOP: not in disposable Eurovia auth CI"; exit 1
fi
sql() { psql -X --no-psqlrc -q -v ON_ERROR_STOP=1 "$@"; }
if [[ "$(psql -X -At -v ON_ERROR_STOP=1 -c 'SELECT current_database()')" != "crm_eurovia" ]]; then
  echo "STOP: unexpected DB"; exit 1
fi

sql <<'SQL'
CREATE ROLE crm_eurovia_owner NOLOGIN NOBYPASSRLS;
CREATE ROLE crm_eurovia_runtime NOLOGIN NOBYPASSRLS NOINHERIT;
CREATE SCHEMA crm_security AUTHORIZATION crm_eurovia_owner;
GRANT USAGE ON SCHEMA crm_security TO crm_eurovia_runtime;
GRANT USAGE ON SCHEMA public TO crm_eurovia_runtime;
GRANT crm_eurovia_runtime TO postgres;
SQL
sql -f apps/api/prisma/migrations/20261015_neon_auth_bridge/migration.sql

sql <<'SQL'
INSERT INTO public.stores
  (id,"shortName","syonetName",plaza,city,state,timezone,updated_at)
VALUES
  ('ci-only-a','CI Eurovia','CI_AUTH_TEST','FORTALEZA',
   'Fortaleza','CE','America/Fortaleza',now());
INSERT INTO public.users
  (id,name,username,password,role,store_id,active,updated_at)
VALUES
  ('ci-only-operator','Operador Efemero','ci-only-operator',
   crm_crypto.crypt('ci-only-not-a-real-secret',crm_crypto.gen_salt('bf',6)),
   'VL_CONSULTANT','ci-only-a',true,now());
INSERT INTO public.dashboard_users
  (id,username,password_hash,name,role,active,allowed_stores,updated_at)
VALUES
  ('ci-only-evaluator','ci-only-evaluator',
   crm_crypto.crypt('ci-only-not-a-real-secret',crm_crypto.gen_salt('bf',6)),
   'Avaliador Efemero','VIEWER',true,ARRAY['ci-only-a']::text[],now());
SQL

sql <<'SQL'
BEGIN;
SET LOCAL ROLE crm_eurovia_runtime;
DO $test$
DECLARE
 first_token text;
 next_token text;
 found_user text;
 allowed text[];
 matches integer;
 revoked boolean;
BEGIN
 SELECT count(*) INTO matches FROM crm_security.login_user('ci-only-operator','wrong');
 IF matches<>0 THEN RAISE EXCEPTION 'Invalid password accepted'; END IF;
 SELECT user_id,refresh_token INTO found_user,first_token
 FROM crm_security.login_user('ci-only-operator','ci-only-not-a-real-secret');
 IF found_user IS DISTINCT FROM 'ci-only-operator' OR length(first_token)<>64
 THEN RAISE EXCEPTION 'Valid login failed'; END IF;
 SELECT user_id,refresh_token INTO found_user,next_token
 FROM crm_security.refresh_user(first_token);
 IF found_user IS DISTINCT FROM 'ci-only-operator' OR
    length(next_token)<>64 OR first_token=next_token THEN
   RAISE EXCEPTION 'Refresh rotation failed'; END IF;
 SELECT count(*) INTO matches FROM crm_security.refresh_user(first_token);
 IF matches<>0 THEN RAISE EXCEPTION 'Refresh replay accepted'; END IF;
 SELECT crm_security.logout_user(next_token) INTO revoked;
 IF revoked IS NOT TRUE THEN RAISE EXCEPTION 'Logout failed'; END IF;
 SELECT count(*) INTO matches FROM crm_security.refresh_user(next_token);
 IF matches<>0 THEN RAISE EXCEPTION 'Logged out refresh accepted'; END IF;
 SELECT count(*) INTO matches FROM crm_security.login_dashboard('ci-only-evaluator','wrong');
 IF matches<>0 THEN RAISE EXCEPTION 'Evaluator wrong password accepted'; END IF;
 SELECT allowed_stores INTO allowed FROM crm_security.login_dashboard(
   'ci-only-evaluator','ci-only-not-a-real-secret');
 IF allowed IS DISTINCT FROM ARRAY['ci-only-a']::text[] THEN
   RAISE EXCEPTION 'Evaluator login or permissions failed'; END IF;
 RAISE NOTICE 'EUROVIA AUTH CI: password, refresh rotation, logout and evaluator PASS';
END $test$;
COMMIT;
SQL

if [[ "$(psql -X -At -v ON_ERROR_STOP=1 -c 'SELECT count(*)::int FROM public.refresh_tokens')" != "0" ]]; then
  echo "FAIL: tokens remain"; exit 1
fi

# pgcrypto bf compatibility with bcryptjs $2b$ hashes, in a CI-only DB.
sql <<'SQL'
UPDATE public.users SET password=overlay(password placing '$2b$' from 1 for 4)
WHERE id='ci-only-operator';
BEGIN;
SET LOCAL ROLE crm_eurovia_runtime;
DO $test$
DECLARE token text;
BEGIN
 SELECT refresh_token INTO token FROM crm_security.login_user(
   'ci-only-operator','ci-only-not-a-real-secret');
 IF length(token)<>64 THEN RAISE EXCEPTION 'bcrypt 2b rejected'; END IF;
 PERFORM crm_security.logout_user(token);
END $test$;
COMMIT;
SQL
if [[ "$(psql -X -At -v ON_ERROR_STOP=1 -c 'SELECT count(*)::int FROM public.refresh_tokens')" != "0" ]]; then
  echo "FAIL: opaque token not revoked"; exit 1
fi
echo "CRM EUROVIA AUTH CI PASS: all credentials fictional; no real database modified."
