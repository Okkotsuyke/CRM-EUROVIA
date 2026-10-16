#!/usr/bin/env bash
# CRM EUROVIA / PG17 CI only. No Neon hosted DB, Supabase or Syonet.
set -euo pipefail
if [[ "$CRM_EUROVIA_ACL_CI" != "1" || "$PGHOST" != "127.0.0.1" || "$PGPORT" != "5432" || "$PGDATABASE" != "crm_eurovia" || "$PGUSER" != "postgres" ]]; then
  echo "STOP: not on disposable local Eurovia CI"; exit 1
fi
db() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }
test "$(psql -X -At -v ON_ERROR_STOP=1 -c 'SELECT current_database()')" = "crm_eurovia"

db -c "CREATE ROLE crm_eurovia_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;"
db -f apps/api/prisma/migrations/20261015_neon_rls_scope/migration.sql >/dev/null
baseline="$(psql -X -At -v ON_ERROR_STOP=1 -c "SELECT has_column_privilege('crm_eurovia_runtime','public.leads','raw_payload','SELECT')")"
test "$baseline" = "t"
echo "ACL baseline: unrestricted raw select reproduced in isolated PostgreSQL"
db -f apps/api/prisma/migrations/20261015_neon_sensitive_column_acl/migration.sql >/dev/null

db <<'SQL'
INSERT INTO public.stores
 (id,"shortName","syonetName",plaza,city,state,timezone,updated_at)
VALUES
 ('ci-acl-a','CI A','NOT_SYONET_A','FORTALEZA','Fortaleza','CE','America/Fortaleza',now()),
 ('ci-acl-b','CI B','NOT_SYONET_B','SALVADOR','Salvador','BA','America/Bahia',now());
INSERT INTO public.users
 (id,name,username,password,role,store_id,active,updated_at)
VALUES
 ('ci-acl-user-a','CI User A','CI.USER.A','NOT_REAL_HASH','VL_CONSULTANT','ci-acl-a',true,now()),
 ('ci-acl-user-b','CI User B','CI.USER.B','NOT_REAL_HASH','VL_CONSULTANT','ci-acl-b',true,now());
INSERT INTO public.leads
 (id,syonet_lead_id,store_id,received_at,status,updated_at,raw_payload)
VALUES
 ('ci-acl-lead-a','SYNTHETIC_A','ci-acl-a',now(),'TEST',now(),'{"synthetic":"secret"}'),
 ('ci-acl-lead-b','SYNTHETIC_B','ci-acl-b',now(),'TEST',now(),'{"synthetic":"secret"}');
INSERT INTO public.appointments
 (id,lead_id,store_id,appointment_date,status,created_by_user_id,updated_at,raw_data)
VALUES
 ('ci-acl-appointment-a','ci-acl-lead-a','ci-acl-a',now(),'SCHEDULED','ci-acl-user-a',now(),'{"synthetic":"secret"}'),
 ('ci-acl-appointment-b','ci-acl-lead-b','ci-acl-b',now(),'SCHEDULED','ci-acl-user-b',now(),'{"synthetic":"secret"}');
SQL

db <<'SQL'
BEGIN;
SET LOCAL ROLE crm_eurovia_runtime;
SELECT set_config('crm_eurovia.actor_id','ci-acl-user-a',true);
DO $test$
DECLARE n integer; blocked boolean;
BEGIN
 SELECT count(*) INTO n FROM public.leads;
 IF n<>1 THEN RAISE EXCEPTION 'Authorized leads count wrong'; END IF;
 SELECT count(*) INTO n FROM public.appointments;
 IF n<>1 THEN RAISE EXCEPTION 'Authorized appointments count wrong'; END IF;
 SELECT count(*) INTO n FROM public.leads WHERE id='ci-acl-lead-b';
 IF n<>0 THEN RAISE EXCEPTION 'Other-store lead visible'; END IF;
 SELECT count(*) INTO n FROM public.appointments WHERE id='ci-acl-appointment-b';
 IF n<>0 THEN RAISE EXCEPTION 'Other-store appointment visible'; END IF;

 blocked:=false;
 BEGIN PERFORM raw_payload FROM public.leads; EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'leads.raw_payload leaked'; END IF;
 blocked:=false;
 BEGIN PERFORM raw_data FROM public.appointments; EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'appointments.raw_data leaked'; END IF;
 blocked:=false;
 BEGIN PERFORM raw_data FROM public.flow_events; EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'flow_events.raw_data leaked'; END IF;
 blocked:=false;
 BEGIN PERFORM raw_data FROM public.sales; EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'sales.raw_data leaked'; END IF;
 RAISE NOTICE 'NEON EUROVIA ACL PASS: valid row reads, other store blocked, raw columns denied';
END $test$;
ROLLBACK;
SQL
echo "NEON EUROVIA ACL CI PASS (disposable Postgres only)"
