# CRM EUROVIA — Homologação do bloqueio público (isolada)

A análise detectou 14 tabelas do projeto Supabase `crm-eurovia`
com RLS desativada e GRANTs amplos para `anon` e `authenticated`.
Nenhuma modificação será feita no Supabase de produção por este teste.

## Processo homologado
O GitHub Actions inicia um serviço PostgreSQL 17 temporário, denominado
`eurovia_rls_ci`, em `127.0.0.1`. Recria o schema com Prisma, cria roles
simuladas e uma loja FICTÍCIA, reproduz inicialmente os grants inseguros,
aplica o SQL exato de `docs/security/eurovia-rls-firewall.sql` e comprova:

1. Leitura `anon` era possível antes.
2. Todas as 14 tabelas recebem RLS e negam privilégios diretos de tabela.
3. SELECT e UPDATE falham sob ambas as identidades.
4. RLS sem policy bloqueia a linha mesmo sob GRANT SELECT temporário.
5. `service_role` técnico de teste ainda pode ler, portanto deve ficar
   exclusivamente no servidor.
6. Nova tabela criada após o patch não herda grants para público.

O job falha caso não esteja no DB efêmero exato, em localhost, sob o
marcador `CRM_EUROVIA_RLS_CI=1`. Nenhuma credencial, HTTP ou Playwright
relacionado ao Syonet é utilizado.

## Limitações antes de aplicar ao Supabase
Esta é homologação do **mecanismo PostgreSQL**. Não testa a Data API HTTP
(PostgREST), tokens Auth reais nem a conexão de runtime Fastify. Não há
branch de homologação do Supabase cadastrada. Sua criação pode ter custo
e exige aprovação de organização/cobrança. O SQL não deve ser aplicado
no ambiente real sem confirmar dependências, backup e permissões da API.

Ver: https://supabase.com/docs/guides/api/securing-your-api
