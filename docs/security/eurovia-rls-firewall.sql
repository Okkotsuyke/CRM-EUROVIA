-- CRM EUROVIA - Plano SQL de contenção da API publica (NAO APLICADO).
-- Projeto-alvo somente: crm-eurovia. Testar primeiro em banco isolado.
-- Obtido pela inspeção do banco em 15/10/2026 (14 tabelas, RLS off).
--
-- ALERTA: nenhuma politica de leitura/escrita para cliente Supabase
-- e criada aqui. Auth Supabase continua separado.
-- Consultas via PostgREST de roles anon/authenticated serão NEGADAS.
-- Se algum módulo depender de supabase-js para acessar tabelas,
-- adaptar primeiro seu acesso para a API autorizada.
-- Prisma com role proprietaria pode ignorar RLS: endurecimento
-- completo exige usuario runtime sem BYPASSRLS, grants por função,
-- e testes de permissões por loja.
--
-- Não executar em produção sem verificar dependências e recuperação.
BEGIN;

REVOKE ALL PRIVILEGES ON TABLE
  public.stores,
  public.users,
  public.media_sources,
  public.leads,
  public.lead_events,
  public.appointments,
  public.flow_events,
  public.sales,
  public.productivity_snapshots,
  public.sync_runs,
  public.refresh_tokens,
  public.sync_metrics,
  public.dashboard_users,
  public.validation_reports
FROM anon, authenticated;

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

COMMIT;

-- Após teste em staging, executar Security Advisor novamente.
-- Referência: https://supabase.com/docs/guides/database/postgres/row-level-security
