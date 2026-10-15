-- CRM EUROVIA ONLY. NEON STAGING: noisy-hat-46747617 / br-bold-sun-b6p0nkhp / crm_eurovia
-- Auth bridge for legacy bcrypt-compatible password hashes and opaque SHA-256 refresh tokens.
-- Does not grant SELECT(password) or SELECT(password_hash) to the application role.
-- Functions SECURITY DEFINER have fixed search_path, explicit schema qualification,
-- restricted EXECUTE and do not return password hashes.
-- Context creation and route authorization remain server-side responsibilities.
-- Never apply to main, Supabase, Syonet or another project.
-- Prisma migrate history on staging remains to be reconciled before migrate deploy.

-- CRM-EUROVIA-SQL-STEP-01
DO $do$
BEGIN
  IF current_database() <> 'crm_eurovia' OR NOT EXISTS
  (SELECT 1 FROM pg_roles WHERE rolname='crm_eurovia_runtime' AND NOT rolbypassrls AND NOT rolcanlogin)
  THEN RAISE EXCEPTION 'Eurovia auth migration: unsafe database or role'; END IF;
END $do$;

-- CRM-EUROVIA-SQL-STEP-02
CREATE SCHEMA IF NOT EXISTS crm_crypto AUTHORIZATION crm_eurovia_owner;

-- CRM-EUROVIA-SQL-STEP-03
REVOKE ALL ON SCHEMA crm_crypto FROM PUBLIC;

-- CRM-EUROVIA-SQL-STEP-04
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA crm_crypto;

-- CRM-EUROVIA-SQL-STEP-05
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crm_crypto FROM PUBLIC;

-- CRM-EUROVIA-SQL-STEP-06
CREATE OR REPLACE FUNCTION crm_security.login_user(p_username text,p_password text)
RETURNS TABLE (
 user_id text, user_name text, display_name text, email text,
 user_role public."UserRole", store_id text, refresh_token text, expires_at timestamp
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE
 u public.users%ROWTYPE;
 safe_hash text;
 new_token text;
 expire_at timestamp;
BEGIN
 IF p_username IS NULL OR p_password IS NULL OR
    length(p_username) NOT BETWEEN 1 AND 120 OR
    octet_length(p_password) NOT BETWEEN 1 AND 72 THEN RETURN; END IF;
 SELECT * INTO u FROM public.users a
 WHERE a.username=p_username AND a.active IS TRUE LIMIT 1;
 IF u.id IS NULL THEN RETURN; END IF;
 IF u.role <> 'ADMIN'::public."UserRole" AND u.store_id IS NULL THEN RETURN; END IF;
 -- Postgres crypt(bf) uses 2a format. Normalize compatible bcryptjs 2b.
 IF char_length(u.password) <> 60 OR substring(u.password,1,4) NOT IN ('$2a$','$2b$') THEN RETURN; END IF;
 safe_hash := '$2a$' || substring(u.password from 5);
 IF crm_crypto.crypt(p_password, safe_hash) IS DISTINCT FROM safe_hash THEN RETURN; END IF;
 new_token := encode(crm_crypto.gen_random_bytes(32),'hex');
 expire_at := now() + interval '14 days';
 INSERT INTO public.refresh_tokens(id,token,user_id,expires_at)
 VALUES (pg_catalog.gen_random_uuid()::text,
         encode(crm_crypto.digest(new_token,'sha256'),'hex'),u.id,expire_at);
 RETURN QUERY SELECT u.id,u.username,u.name::text,u.email::text,u.role,u.store_id,new_token,expire_at;
END $fn$;

-- CRM-EUROVIA-SQL-STEP-07
CREATE OR REPLACE FUNCTION crm_security.refresh_user(p_token text)
RETURNS TABLE (
 user_id text, user_name text, display_name text, email text,
 user_role public."UserRole", store_id text, refresh_token text, expires_at timestamp
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE
 session_record public.refresh_tokens%ROWTYPE;
 u public.users%ROWTYPE;
 new_token text;
 expire_at timestamp;
BEGIN
 IF p_token IS NULL OR char_length(p_token)<>64 OR p_token !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
 SELECT t.* INTO session_record FROM public.refresh_tokens t
 WHERE t.token=encode(crm_crypto.digest(p_token,'sha256'),'hex')
   AND t.expires_at > now() FOR UPDATE;
 IF session_record.id IS NULL THEN RETURN; END IF;
 SELECT * INTO u FROM public.users a WHERE a.id=session_record.user_id AND a.active IS TRUE;
 -- Delete invalidated sessions (the original token must never be reusable).
 DELETE FROM public.refresh_tokens WHERE id=session_record.id;
 IF u.id IS NULL OR (u.role<>'ADMIN'::public."UserRole" AND u.store_id IS NULL) THEN RETURN; END IF;
 new_token:=encode(crm_crypto.gen_random_bytes(32),'hex');
 expire_at:=now()+interval '14 days';
 INSERT INTO public.refresh_tokens(id,token,user_id,expires_at)
 VALUES (pg_catalog.gen_random_uuid()::text,
    encode(crm_crypto.digest(new_token,'sha256'),'hex'),u.id,expire_at);
 RETURN QUERY SELECT u.id,u.username,u.name::text,u.email::text,u.role,u.store_id,new_token,expire_at;
END $fn$;

-- CRM-EUROVIA-SQL-STEP-08
CREATE OR REPLACE FUNCTION crm_security.logout_user(p_token text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE removed_id text;
BEGIN
 IF p_token IS NULL OR char_length(p_token)<>64 OR p_token !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
 DELETE FROM public.refresh_tokens t
 WHERE t.token=encode(crm_crypto.digest(p_token,'sha256'),'hex')
 RETURNING t.id INTO removed_id;
 RETURN removed_id IS NOT NULL;
END $fn$;

-- CRM-EUROVIA-SQL-STEP-09
CREATE OR REPLACE FUNCTION crm_security.login_dashboard(p_username text,p_password text)
RETURNS TABLE (
 user_id text, user_name text, display_name text, user_role text, allowed_stores text[]
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE
 u public.dashboard_users%ROWTYPE;
 safe_hash text;
BEGIN
 IF p_username IS NULL OR p_password IS NULL OR
   length(p_username) NOT BETWEEN 1 AND 120 OR
   octet_length(p_password) NOT BETWEEN 1 AND 72 THEN RETURN; END IF;
 SELECT * INTO u FROM public.dashboard_users d
 WHERE d.username=p_username AND d.active IS TRUE AND d.role IN ('ADMIN','VIEWER') LIMIT 1;
 IF u.id IS NULL OR cardinality(coalesce(u.allowed_stores,ARRAY[]::text[]))=0 THEN RETURN; END IF;
 IF char_length(u.password_hash)<>60 OR substring(u.password_hash,1,4) NOT IN ('$2a$','$2b$') THEN RETURN; END IF;
 safe_hash:='$2a$'||substring(u.password_hash from 5);
 IF crm_crypto.crypt(p_password,safe_hash) IS DISTINCT FROM safe_hash THEN RETURN; END IF;
 RETURN QUERY SELECT u.id,u.username,u.name,u.role,coalesce(u.allowed_stores,ARRAY[]::text[]);
END $fn$;

-- CRM-EUROVIA-SQL-STEP-10
REVOKE ALL ON FUNCTION crm_security.login_user(text,text) FROM PUBLIC;

-- CRM-EUROVIA-SQL-STEP-11
GRANT EXECUTE ON FUNCTION crm_security.login_user(text,text) TO crm_eurovia_runtime;

-- CRM-EUROVIA-SQL-STEP-12
REVOKE ALL ON FUNCTION crm_security.refresh_user(text) FROM PUBLIC;

-- CRM-EUROVIA-SQL-STEP-13
GRANT EXECUTE ON FUNCTION crm_security.refresh_user(text) TO crm_eurovia_runtime;

-- CRM-EUROVIA-SQL-STEP-14
REVOKE ALL ON FUNCTION crm_security.logout_user(text) FROM PUBLIC;

-- CRM-EUROVIA-SQL-STEP-15
GRANT EXECUTE ON FUNCTION crm_security.logout_user(text) TO crm_eurovia_runtime;

-- CRM-EUROVIA-SQL-STEP-16
REVOKE ALL ON FUNCTION crm_security.login_dashboard(text,text) FROM PUBLIC;

-- CRM-EUROVIA-SQL-STEP-17
GRANT EXECUTE ON FUNCTION crm_security.login_dashboard(text,text) TO crm_eurovia_runtime;
