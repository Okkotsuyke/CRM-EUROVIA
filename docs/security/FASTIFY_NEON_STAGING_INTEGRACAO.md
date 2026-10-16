# CRM Eurovia — API Fastify conectada ao Neon staging

Data da validação: **15/10/2026**. Escopo: **CRM EUROVIA exclusivamente**.

## Identidades imutáveis para esta homologação

| Serviço | Identificador verificado |
|---|---|
| GitHub | `Okkotsuyke/CRM-EUROVIA` |
| Branch GitHub de segurança | `fix/eurovia-hardening-deploy-20261015` |
| Vercel API | `crm-eurovia-api`, `prj_yqg4rMwLALfSgojS1xV1ZkxrrIEH` |
| Neon CRM | `crm-eurovia`, `noisy-hat-46747617` |
| Neon staging | `staging-security-rls`, `br-bold-sun-b6p0nkhp` |
| Banco e região | `crm_eurovia`, `aws-sa-east-1`, PostgreSQL 17 |
| Neon main (não alterada) | `br-delicate-sound-b6l7thd1`, **zero tabelas** |
| Outros projetos (proibidos) | Neon MVP `nameless-night-94061643` |

## Evidências operacionais verificadas

- **Causa raiz anterior:** Node 24 na Vercel lançava `ERR_MODULE_NOT_FOUND`
  ao importar `/var/task/apps/api/src/app` de `api/index.js`. O projeto
  compilava com sucesso, mas o runtime retornava `FUNCTION_INVOCATION_FAILED`.
- **Correção da causa:** commit `6c043665df4bbc523f7fe95026b489116ec1df64`
  compila a API para **CommonJS** e usa `@vercel/node` explicitamente.
- **CI aprovado:** https://github.com/Okkotsuyke/CRM-EUROVIA/actions/runs/38781885777
  Inclui testes unitários, TypeScript/build, `node --check`, execução real do
  handler compilado e verificação do empacotamento da API.
- **Deploy controlado:** `dpl_7BrfLzbMsaujR73jHK1hvuRFTAzE`, status
  `READY`, ambiente **Preview**, sem promoção à produção.
- **Health:** `GET /health` -> HTTP **200**, corpo
  `status=ok`, `integrations.database=connected`, latência observada
  de 81 ms naquele teste.
- **Bloqueio de negócio:** `GET /api/v1/stores` -> HTTP **503**
  (`staging_security_gate`), intencional.
- **Bloqueio de cron:** `GET /api/cron/health` -> HTTP **503**
  (`staging_security_gate`), intencional.
- **Logs reais da Vercel:** registraram a resposta 200 do Fastify e
  as negações 503, sem o antigo `ERR_MODULE_NOT_FOUND`.
- **Neon Staging:** 14 tabelas com RLS ENABLE+FORCE, 20 policies,
  duas lojas **sintéticas**. A main Neon permanece vazia.

## Credenciais e privilégios

- Vercel armazena `DATABASE_URL` e `JWT_SECRET` como **Secrets**,
  escopados apenas ao **Preview da branch de segurança**. Os valores não
  foram commitados e não podem ser usados em produção por configuração.
- A API usa `crm_eurovia_staging_login`: LOGIN, NOBYPASSRLS,
  NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT.
- Consulta real ao banco como essa role mostrou:
  `SET LOCAL ROLE crm_eurovia_runtime`,
  `current_user=crm_eurovia_runtime` e
  **zero lojas visíveis sem ator**. Isso comprova o deny-by-default.
- A role Neon `crm_eurovia_owner` possui `BYPASSRLS`: **nunca usá-la
  na API**. A role privilegiada temporária `crm_eurovia_api_staging`
  foi removida após a auditoria.
- O Neon Data API público **não foi provisionado**.

## Avisos não bloqueantes identificados

- `DEP0169`: alguma dependência utiliza `url.parse()` no Node 24.
  Identificar o pacote originador e atualizar após teste de regressão.
- `Sentry DSN nao configurado - tracing desabilitado` no Preview.
  Configurar apenas DSN do CRM correto antes de produção.

## Gates pendentes antes de habilitar rotas comerciais

1. Validar autenticação/sessões e criar role apropriada ao fluxo de login,
   sem `BYPASSRLS` e sem expor senhas na role comercial.
2. Adaptar **todas** as consultas Prisma a transações com contexto de
   ator autorizado, pois `SET LOCAL` vale somente na transação.
3. Repetir testes cross-store com Fastify real e dois perfis sintéticos.
4. Regularizar a tabela `_prisma_migrations` no staging via
   `prisma migrate resolve --applied`, nunca reaplicar cegamente o DDL.
5. Backups, rollback, alarmes/monitoramento e validação de custos.
6. Impedir escrita no Syonet sempre, inclusive por scripts avulsos;
   consulta somente após avaliação de autenticação segura.
7. Concluir revisão da PR em draft antes de promover produção.

Sem qualquer alteração em MVP-Creator, Neon main, Supabase legado ou Syonet.
