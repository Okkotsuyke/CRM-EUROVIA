-- CRM EUROVIA — CONTENCAO DE DADOS NA DATA API
-- PROPOSTA NA BRANCH, NAO EXECUTADA EM QUALQUER AMBIENTE.
-- A base usa API Fastify + JWT proprio e Prisma; Auth Supabase so esta
-- parcialmente configurado no frontend.
--
-- ALTERAR RLS SEM VALIDAR INTEGRACOES PODERA BLOQUEAR FUNCIONALIDADES.
-- Nenhum acesso direto anon/authenticated aos dados do CRM foi autorizado.
-- Aplicar em staging primeiro, com backup e rollback ensaiados.
--
-- O runtime Prisma pode usar role proprietario e, portanto, BYPASSAR RLS:
-- autorizacao de loja no servidor precisa ser validada separadamente.
BEGIN;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- Evita exposicao automatica de tabelas futuras criadas por postgres.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE USAGE, SELECT, UPDATE ON SEQUENCES FROM anon, authenticated;

ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.productivity_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dashboard_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.validation_reports ENABLE ROW LEVEL SECURITY;

-- Sem policies de acesso direto: deny-by-default, intencional.
-- Ao migrar identidade para Supabase Auth, criar policies com vinculo
-- de usuario e loja conferido no servidor, testadas antes dos grants.
COMMIT;
