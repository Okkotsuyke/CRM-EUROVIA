-- CRM EUROVIA — Neon PostgreSQL 17, schema canonico Prisma 5.22
-- Project ID allowlist: noisy-hat-46747617 | DB crm_eurovia
-- Teste inicial: staging br-bold-sun-b6p0nkhp. Nao aplicar em outros projetos.
-- RLS fail-closed: nenhuma credencial publica; cliente runtime NOLOGIN sem BYPASSRLS.
-- O owner crm_eurovia_owner tem BYPASSRLS no Neon: JAMAIS usar para conexao da API.
-- Contexto trusted BFF: SET LOCAL crm_eurovia.actor_id ou dashboard_actor_id.
-- Funcoes validam usuario ATIVO e sua loja no banco (nao confiam em role/store do JWT).
-- AVISO: um cliente SQL com credenciais runtime pode forjar custom GUC; proteger segredo
-- e impedir uso direto no navegador. Backend precisa autenticar antes de SET LOCAL.
-- Auth/login, refresh_tokens e sync worker ainda requerem funcao/role especifica futura.
-- Em staging, sem dados reais; nenhuma operacao no Syonet.

DO $role$
BEGIN
 IF current_database() <> 'crm_eurovia' THEN
    RAISE EXCEPTION 'CRM EUROVIA: unexpected database';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='crm_eurovia_runtime') THEN
    CREATE ROLE crm_eurovia_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles
     WHERE rolname='crm_eurovia_runtime'
       AND (rolcanlogin OR rolbypassrls OR rolsuper OR rolinherit)) THEN
   RAISE EXCEPTION 'CRM EUROVIA: runtime role violates least privilege';
 END IF;
END $role$;

GRANT crm_eurovia_runtime TO crm_eurovia_owner;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, crm_eurovia_runtime;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, crm_eurovia_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE crm_eurovia_owner IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE crm_eurovia_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE crm_eurovia_owner IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS crm_security AUTHORIZATION crm_eurovia_owner;

REVOKE ALL ON SCHEMA crm_security FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO crm_eurovia_runtime;

GRANT USAGE ON SCHEMA crm_security TO crm_eurovia_runtime;

CREATE OR REPLACE FUNCTION crm_security.actor_id() RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT NULLIF(current_setting('crm_eurovia.actor_id',true),'')
$fn$;

CREATE OR REPLACE FUNCTION crm_security.dashboard_actor_id() RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT NULLIF(current_setting('crm_eurovia.dashboard_actor_id',true),'')
$fn$;

CREATE OR REPLACE FUNCTION crm_security.actor_active() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT EXISTS (SELECT 1 FROM public.users u
 WHERE u.id = crm_security.actor_id() AND u.active IS TRUE)
$fn$;

CREATE OR REPLACE FUNCTION crm_security.actor_is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT EXISTS (SELECT 1 FROM public.users u
 WHERE u.id = crm_security.actor_id() AND u.active IS TRUE
 AND u.role='ADMIN'::public."UserRole")
$fn$;

CREATE OR REPLACE FUNCTION crm_security.actor_is_manager() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT EXISTS (SELECT 1 FROM public.users u
 WHERE u.id = crm_security.actor_id() AND u.active IS TRUE
 AND u.role='MANAGER'::public."UserRole")
$fn$;

CREATE OR REPLACE FUNCTION crm_security.dashboard_actor_active() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT EXISTS (SELECT 1 FROM public.dashboard_users d
 WHERE d.id=crm_security.dashboard_actor_id() AND d.active IS TRUE
 AND cardinality(d.allowed_stores)>0)
$fn$;

CREATE OR REPLACE FUNCTION crm_security.actor_allowed_store(target_store_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT EXISTS (
   SELECT 1 FROM public.users u
   WHERE u.id=crm_security.actor_id() AND u.active IS TRUE
   AND (u.role='ADMIN'::public."UserRole"
        OR (target_store_id IS NOT NULL AND u.store_id=target_store_id))
 )
$fn$;

CREATE OR REPLACE FUNCTION crm_security.dashboard_allowed_store(target_store_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT target_store_id IS NOT NULL AND EXISTS (
   SELECT 1 FROM public.dashboard_users d
   WHERE d.id=crm_security.dashboard_actor_id() AND d.active IS TRUE
   AND target_store_id=ANY(d.allowed_stores)
 )
$fn$;

CREATE OR REPLACE FUNCTION crm_security.dashboard_validation_allowed(
 target_dashboard_user_id text, target_item_type public."ValidationItemType", target_item_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT EXISTS (
   SELECT 1 FROM public.dashboard_users d
   WHERE d.id=crm_security.dashboard_actor_id()
   AND d.id=target_dashboard_user_id AND d.active IS TRUE
   AND cardinality(d.allowed_stores)>0
   AND (
     target_item_type='OVERALL'::public."ValidationItemType"
     OR (target_item_type='STORE'::public."ValidationItemType"
         AND target_item_id=ANY(d.allowed_stores))
   )
 )
$fn$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA crm_security FROM PUBLIC;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA crm_security TO crm_eurovia_runtime;

ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.stores FORCE ROW LEVEL SECURITY;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.users FORCE ROW LEVEL SECURITY;

ALTER TABLE public.media_sources ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.media_sources FORCE ROW LEVEL SECURITY;

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.leads FORCE ROW LEVEL SECURITY;

ALTER TABLE public.lead_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.lead_events FORCE ROW LEVEL SECURITY;

ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.appointments FORCE ROW LEVEL SECURITY;

ALTER TABLE public.flow_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.flow_events FORCE ROW LEVEL SECURITY;

ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sales FORCE ROW LEVEL SECURITY;

ALTER TABLE public.productivity_snapshots ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.productivity_snapshots FORCE ROW LEVEL SECURITY;

ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sync_runs FORCE ROW LEVEL SECURITY;

ALTER TABLE public.refresh_tokens ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.refresh_tokens FORCE ROW LEVEL SECURITY;

ALTER TABLE public.sync_metrics ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sync_metrics FORCE ROW LEVEL SECURITY;

ALTER TABLE public.dashboard_users ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.dashboard_users FORCE ROW LEVEL SECURITY;

ALTER TABLE public.validation_reports ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.validation_reports FORCE ROW LEVEL SECURITY;

CREATE POLICY crm_eurovia_stores_select ON public.stores FOR SELECT TO crm_eurovia_runtime USING (crm_security.actor_allowed_store(id) OR crm_security.dashboard_allowed_store(id));

CREATE POLICY crm_eurovia_media_sources_select ON public.media_sources FOR SELECT TO crm_eurovia_runtime USING (crm_security.actor_active() OR crm_security.dashboard_actor_active());

CREATE POLICY crm_eurovia_users_select ON public.users FOR SELECT TO crm_eurovia_runtime USING (crm_security.actor_is_admin() OR (id=crm_security.actor_id() AND crm_security.actor_active()) OR (crm_security.actor_is_manager() AND crm_security.actor_allowed_store(store_id)));

CREATE POLICY crm_eurovia_leads_select ON public.leads FOR SELECT TO crm_eurovia_runtime USING (crm_security.actor_allowed_store(store_id));

CREATE POLICY crm_eurovia_leads_update ON public.leads FOR UPDATE TO crm_eurovia_runtime USING (crm_security.actor_allowed_store(store_id)) WITH CHECK (crm_security.actor_allowed_store(store_id));

CREATE POLICY crm_eurovia_lead_events_select ON public.lead_events FOR SELECT TO crm_eurovia_runtime USING (EXISTS (SELECT 1 FROM public.leads l WHERE l.id=lead_id AND crm_security.actor_allowed_store(l.store_id)));

CREATE POLICY crm_eurovia_lead_events_insert ON public.lead_events FOR INSERT TO crm_eurovia_runtime WITH CHECK (EXISTS (SELECT 1 FROM public.leads l WHERE l.id=lead_id AND crm_security.actor_allowed_store(l.store_id)) AND user_id=crm_security.actor_id());

CREATE POLICY crm_eurovia_appointments_select ON public.appointments FOR SELECT TO crm_eurovia_runtime USING (crm_security.actor_allowed_store(store_id) AND EXISTS (SELECT 1 FROM public.leads l WHERE l.id=lead_id AND l.store_id=store_id));

CREATE POLICY crm_eurovia_appointments_insert ON public.appointments FOR INSERT TO crm_eurovia_runtime WITH CHECK (crm_security.actor_allowed_store(store_id) AND EXISTS (SELECT 1 FROM public.leads l WHERE l.id=lead_id AND l.store_id=store_id) AND created_by_user_id=crm_security.actor_id());

CREATE POLICY crm_eurovia_appointments_update ON public.appointments FOR UPDATE TO crm_eurovia_runtime USING (crm_security.actor_allowed_store(store_id) AND EXISTS (SELECT 1 FROM public.leads l WHERE l.id=lead_id AND l.store_id=store_id)) WITH CHECK (crm_security.actor_allowed_store(store_id) AND EXISTS (SELECT 1 FROM public.leads l WHERE l.id=lead_id AND l.store_id=store_id));

CREATE POLICY crm_eurovia_flow_events_select ON public.flow_events FOR SELECT TO crm_eurovia_runtime USING (crm_security.actor_allowed_store(store_id) AND EXISTS (SELECT 1 FROM public.leads l WHERE l.id=lead_id AND l.store_id=store_id));

CREATE POLICY crm_eurovia_sales_select ON public.sales FOR SELECT TO crm_eurovia_runtime USING (crm_security.actor_allowed_store(store_id) AND EXISTS (SELECT 1 FROM public.leads l WHERE l.id=lead_id AND l.store_id=store_id));

CREATE POLICY crm_eurovia_productivity_snapshots_select ON public.productivity_snapshots FOR SELECT TO crm_eurovia_runtime USING (crm_security.actor_allowed_store(store_id) OR crm_security.dashboard_allowed_store(store_id));

CREATE POLICY crm_eurovia_sync_runs_select ON public.sync_runs FOR SELECT TO crm_eurovia_runtime USING (crm_security.actor_is_admin());

CREATE POLICY crm_eurovia_sync_metrics_select ON public.sync_metrics FOR SELECT TO crm_eurovia_runtime USING (crm_security.actor_allowed_store(store_id) OR crm_security.dashboard_allowed_store(store_id));

CREATE POLICY crm_eurovia_dashboard_users_select ON public.dashboard_users FOR SELECT TO crm_eurovia_runtime USING (id=crm_security.dashboard_actor_id() AND crm_security.dashboard_actor_active());

CREATE POLICY crm_eurovia_validation_reports_select ON public.validation_reports FOR SELECT TO crm_eurovia_runtime USING (crm_security.dashboard_validation_allowed(dashboard_user_id,item_type,item_id));

CREATE POLICY crm_eurovia_validation_reports_insert ON public.validation_reports FOR INSERT TO crm_eurovia_runtime WITH CHECK (crm_security.dashboard_validation_allowed(dashboard_user_id,item_type,item_id));

CREATE POLICY crm_eurovia_validation_reports_update ON public.validation_reports FOR UPDATE TO crm_eurovia_runtime USING (crm_security.dashboard_validation_allowed(dashboard_user_id,item_type,item_id)) WITH CHECK (crm_security.dashboard_validation_allowed(dashboard_user_id,item_type,item_id));

CREATE POLICY crm_eurovia_validation_reports_delete ON public.validation_reports FOR DELETE TO crm_eurovia_runtime USING (crm_security.dashboard_validation_allowed(dashboard_user_id,item_type,item_id));

GRANT SELECT ON TABLE public.stores TO crm_eurovia_runtime;

GRANT SELECT ON TABLE public.media_sources TO crm_eurovia_runtime;

GRANT SELECT ON TABLE public.leads TO crm_eurovia_runtime;

GRANT SELECT,INSERT ON TABLE public.lead_events TO crm_eurovia_runtime;

GRANT SELECT,INSERT ON TABLE public.appointments TO crm_eurovia_runtime;

GRANT SELECT ON TABLE public.flow_events TO crm_eurovia_runtime;

GRANT SELECT ON TABLE public.sales TO crm_eurovia_runtime;

GRANT SELECT ON TABLE public.productivity_snapshots TO crm_eurovia_runtime;

GRANT SELECT ON TABLE public.sync_runs TO crm_eurovia_runtime;

GRANT SELECT ON TABLE public.sync_metrics TO crm_eurovia_runtime;

GRANT SELECT,INSERT,DELETE ON TABLE public.validation_reports TO crm_eurovia_runtime;

GRANT SELECT (id,name,username,email,role,store_id,syonet_code,active,created_at,updated_at)
 ON TABLE public.users TO crm_eurovia_runtime;

GRANT SELECT (id,username,name,role,active,allowed_stores,created_at,updated_at)
 ON TABLE public.dashboard_users TO crm_eurovia_runtime;

GRANT UPDATE (status,status_normalized,priority_flag,assigned_vl_id,assigned_vs_id,assigned_bdc_id,updated_at)
 ON TABLE public.leads TO crm_eurovia_runtime;

GRANT UPDATE (status,confirmed_flag,appointment_date,updated_at)
 ON TABLE public.appointments TO crm_eurovia_runtime;

GRANT UPDATE (status,feedback)
 ON TABLE public.validation_reports TO crm_eurovia_runtime;

REVOKE ALL ON public.refresh_tokens FROM crm_eurovia_runtime, PUBLIC;
