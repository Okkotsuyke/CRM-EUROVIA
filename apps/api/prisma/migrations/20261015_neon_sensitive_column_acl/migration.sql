-- CRM EUROVIA ONLY — staging first (Neon project noisy-hat-46747617)
-- PostgreSQL defense in depth: column-level SELECT instead of table-wide SELECT.
-- Prevents application runtime from reading raw Syonet payloads even if
-- a code change accidentally selects those properties.
-- Target: crm_eurovia / staging-security-rls / br-bold-sun-b6p0nkhp
-- No INSERT/UPDATE/DELETE on the Syonet system, and no production cutover.

DO $guard$
BEGIN
  IF current_database() <> 'crm_eurovia'
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='crm_eurovia_runtime' AND NOT rolbypassrls)
    OR (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) <> 14
  THEN RAISE EXCEPTION 'CRM Eurovia: wrong database, RLS state or role'; END IF;
END $guard$;

REVOKE SELECT ON TABLE public.leads FROM crm_eurovia_runtime;
REVOKE SELECT ON TABLE public.appointments FROM crm_eurovia_runtime;
REVOKE SELECT ON TABLE public.flow_events FROM crm_eurovia_runtime;
REVOKE SELECT ON TABLE public.sales FROM crm_eurovia_runtime;

GRANT SELECT (id, syonet_lead_id, store_id, media_source_id, media_raw, received_at, integration_date, status, status_normalized, priority_flag, assigned_vl_id, assigned_vs_id, assigned_bdc_id, event_type, department, tipo_venda, origem, created_at, updated_at) ON TABLE public.leads TO crm_eurovia_runtime;
GRANT SELECT (id, lead_id, store_id, appointment_date, confirmed_flag, status, created_by_user_id, syonet_reference, created_at, updated_at) ON TABLE public.appointments TO crm_eurovia_runtime;
GRANT SELECT (id, lead_id, store_id, flow_date, status, syonet_reference, created_at) ON TABLE public.flow_events TO crm_eurovia_runtime;
GRANT SELECT (id, lead_id, store_id, sale_date, tipo_venda, vs_user_id, vl_user_id, bdc_user_id, media_source_id, amount, status, syonet_reference, created_at) ON TABLE public.sales TO crm_eurovia_runtime;

DO $check$
BEGIN
  IF has_column_privilege('crm_eurovia_runtime','public.leads','raw_payload','SELECT')
     OR NOT has_column_privilege('crm_eurovia_runtime','public.leads','id','SELECT')
  THEN RAISE EXCEPTION 'CRM Eurovia sensitive column ACL incorrect: leads'; END IF;
  IF has_column_privilege('crm_eurovia_runtime','public.appointments','raw_data','SELECT')
     OR NOT has_column_privilege('crm_eurovia_runtime','public.appointments','id','SELECT')
  THEN RAISE EXCEPTION 'CRM Eurovia sensitive column ACL incorrect: appointments'; END IF;
  IF has_column_privilege('crm_eurovia_runtime','public.flow_events','raw_data','SELECT')
     OR NOT has_column_privilege('crm_eurovia_runtime','public.flow_events','id','SELECT')
  THEN RAISE EXCEPTION 'CRM Eurovia sensitive column ACL incorrect: flow_events'; END IF;
  IF has_column_privilege('crm_eurovia_runtime','public.sales','raw_data','SELECT')
     OR NOT has_column_privilege('crm_eurovia_runtime','public.sales','id','SELECT')
  THEN RAISE EXCEPTION 'CRM Eurovia sensitive column ACL incorrect: sales'; END IF;
END $check$;
