# CRM EUROVIA — Neon Auth + Prisma transacional (staging)

**Data:** 15/10/2026

**Resultado:** aplicação implementada e CI aprovada, Preview Vercel **READY**,
conexão Neon `HTTP 200`, acesso anônimo negado nas rotas migradas.
**Não representa autorização para publicação em produção.**

## Escopo rigidamente isolado

| Sistema | Identificador |
| --- | --- |
| GitHub | `Okkotsuyke/CRM-EUROVIA` |
| Branch de segurança | `fix/eurovia-hardening-deploy-20261015` |
| Neon CRM | `noisy-hat-46747617` (`crm-eurovia`) |
| Neon staging | `br-bold-sun-b6p0nkhp` |
| Banco | `crm_eurovia` em `aws-sa-east-1` |
| Neon main preservada | `br-delicate-sound-b6l7thd1`, **zero tabelas** |
| Vercel API | `prj_yqg4rMwLALfSgojS1xV1ZkxrrIEH` (`crm-eurovia-api`) |
| Neon OUTRO projeto proibido | `nameless-night-94061643` (MVP-Creator) |

Nunca executar qualquer mutação no Syonet. O staging usa
`SYONET_USE_REAL=false` e `SYNC_ENABLED=false`; nenhum serviço
Syonet foi contatado nesta implementação.

Sentry não foi configurado nem alterado, por solicitação explícita.

## Migração SQL de autenticação

Arquivo versionado:
`apps/api/prisma/migrations/20261015_neon_auth_bridge/migration.sql`.

**Aplicada apenas no staging Neon.** Provada a presença de 4 funções
de autenticação, 14 tabelas e 20 políticas RLS.

A migração instala `pgcrypto` em schema privado `crm_crypto`,
com `EXECUTE` público revogado, e cria funções
`SECURITY DEFINER` em schema `crm_security` com
`search_path` fixo:

- `crm_security.login_user`: autentica bcrypt compatível com
  `$2a$`/`$2b$`, valida usuário ativo/loja, emite refresh opaco
  criptograficamente aleatório e persiste **somente SHA-256**.
- `crm_security.refresh_user`: verifica token e validade,
  revoga o token anterior e rotaciona a sessão na mesma transação.
  O token antigo não é reutilizável.
- `crm_security.logout_user`: invalida refresh opaco por hash.
- `crm_security.login_dashboard`: valida senha e permissionamento do
  avaliador, sem devolver `password_hash`.

A role `crm_eurovia_runtime` recebe somente `EXECUTE` nessas
funções. Não ganhou `SELECT(password)`, `SELECT(password_hash)`
nem acesso direto à tabela `refresh_tokens`.

## Código Fastify / Prisma

- `src/services/neon-auth-bridge.ts`: login/refresh/logout SQL
  e leitura de usuários em transações Prisma.
- `withNeonAuthSql()`: `SET LOCAL ROLE crm_eurovia_runtime`
  antes de chamar as funções privadas.
- `withNeonOperationalPrincipal()`: valida somente o `id`
  proveniente de `request.jwtVerify()`, busca novamente o usuário
  ativo e suas permissões **dentro da mesma transação RLS**.
- `withNeonDashboardPrincipal()`: lê permissões `allowedStores`
  atuais no banco, sem confiar em claims de loja no JWT.
- Endpoints migrados: login, refresh, logout, perfil operacional,
  login/perfil do avaliador, listagem e detalhes de lojas.
- O JWT operacional dura **15 minutos** e não carrega privilégios
  autoritativos de loja. O refresh opaco vence em **14 dias**.
- A API nunca instancia Prisma com o role proprietário
  `crm_eurovia_owner` (que possui `BYPASSRLS`).

## Evidências CI

- Auth SQL com PostgreSQL 17 descartável:
  https://github.com/Okkotsuyke/CRM-EUROVIA/actions/runs/38787403606
  — **SUCCESS**, incluindo login válido/inválido, refresh rotativo,
  replay negado, logout e autenticação de avaliador com bcrypt `$2b$`.
  Todos os dados são fictícios, nenhum banco hospedado recebe senhas
  de teste persistentes.
- CI geral (testes de API, TypeScript e build):
  https://github.com/Okkotsuyke/CRM-EUROVIA/actions/runs/38787403800
  — **SUCCESS**.
- Testes PostgreSQL RLS:
  https://github.com/Okkotsuyke/CRM-EUROVIA/actions/runs/38787403668
  — **SUCCESS**.

## Evidências Vercel Preview

Commit validado: `9bf4a391fa5042b5e9b43b4ec6c650d197027691`.

Deployment de teste: `dpl_Dpk2nrYN9GT88NZWgQS1XjX3T1B2`,
URL:
https://crm-eurovia-l1ghmmlpb-maykengld-9931.vercel.app/health

- Build/deployment: `READY`.
- `GET /health` -> **200**, `database=connected`.
- `GET /api/v1/stores` sem JWT -> **401**, registrado nos logs
  da Function. O fetch protegido da Vercel representa HTTP 401 como
  `deployment_authentication_required`; os **logs Fastify** foram usados
  para diferenciar 401 da aplicação da autenticação da plataforma.
- `GET /api/v1/stores/:id` sem JWT -> **401** nos logs Fastify.
- `GET /api/v1/leads` -> **503** intencional.
- `GET /api/cron/health` -> **503** intencional.
- Nenhuma promoção a produção, alteração DNS ou acesso Syonet.

## Gatilhos de segurança ainda obrigatórios

**NÃO liberar o CRM ao público ou produção antes de:**

1. Homologar um login real ponta a ponta no Neon staging com conta
   sintética transitória, senha forte efêmera e limpeza garantida;
   por ora, testes positivos foram realizados em PostgreSQL
   descartável, não via login HTTP publicado.
2. Migrar todas as rotas restantes — leads, appointments, analytics,
   relatórios, cadastros e serviços — para
   `Prisma.TransactionClient` com contexto autorizado por requisição.
   Permanecem no gate HTTP 503, sem acesso de negócio.
3. Migrar armazenamento de tokens do navegador para sessão
   `HttpOnly`, `Secure`, `SameSite`, com CSRF e renovação segura.
   O contrato JSON atual é de compatibilidade para staging.
4. Implementar rate limit distribuído, proteção a brute force,
   política de senhas, gerenciamento de sessões, MFA quando exigido.
5. Testar revogação de JWT após desativação de conta, troca de papel,
   vazamento de credenciais, concorrência e idempotência.
6. Endurecer contexto RLS contra adulteração de GUC caso uma
   credencial SQL da aplicação seja comprometida: contexto assinado
   ou mecanismo equivalente, sem ampliar privilégios.
7. Regularizar `_prisma_migrations` no staging com
   `prisma migrate resolve --applied` antes de `migrate deploy`;
   as migrações foram aplicadas por SQL direto e não devem
   ser reaplicadas cegamente.
8. Validar backup/restauração e rollback, custos e observabilidade
   **sem realizar trabalho em Sentry nesta fase**.
9. Manter o PR #1 como **draft** até os gates de produção.

## Regra de deploy

`docs/security/VERCEL_DEPLOY_GATES_EVIDENCIAS_2026-10-15.md`
é o procedimento obrigatório: se qualquer deployment falhar,
investigar logs e causa raiz, corrigir, obter CI SUCCESS e só então
iniciar **uma única** nova tentativa de Preview.
