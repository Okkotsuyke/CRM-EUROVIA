# CRM Eurovia — RLS + privilégios de colunas + HTTP Fastify/Prisma

**Data:** 15/10/2026  
**Escopo:** somente CRM Eurovia. Sem operações no Syonet e sem atividades no Sentry.

## Identidades validadas

| Item | Ambiente |
|---|---|
| GitHub | `Okkotsuyke/CRM-EUROVIA` |
| Branch GitHub | `fix/eurovia-hardening-deploy-20261015` |
| Projeto Neon | `crm-eurovia` — `noisy-hat-46747617` |
| Neon staging | `br-bold-sun-b6p0nkhp` — `crm_eurovia` — São Paulo |
| Neon main | `br-delicate-sound-b6l7thd1` — continua com zero tabelas |
| Vercel API Preview | `crm-eurovia-api` — `prj_yqg4rMwLALfSgojS1xV1ZkxrrIEH` |
| Projeto excluído do escopo | Neon MVP-Creator `nameless-night-94061643` |

## Resolução da pendência sintética anterior

Restaurada e confirmada a senha fictícia original da conta
`stg-actor-a`. Zero hashes temporários e zero refresh tokens ativos
gerados pelo teste. O estado da conta `stg-evaluator-a` foi preservado.
Esse resultado está registrado na PR #1.

## Teste diretamente no Neon staging com identidade SQL restrita

A role `crm_eurovia_staging_login` (sem `BYPASSRLS`) assumiu
`crm_eurovia_runtime` em transações SQL e consultou dados sintéticos:

- Consultor A: 1 lead e 1 agendamento, apenas da loja A.
- Consultor B: 1 lead e 1 agendamento, apenas da loja B.
- Administrador ativo: 2 leads e 2 agendamentos.
- Sem ator: 0 leads e 0 agendamentos.
- Usuário inativo e gerente de loja A também foram testados em consultas
  anteriores com políticas de acesso restritivo.

**Todas as 6 situações SQL dessa rodada foram aprovadas** (incluindo
os cenários de gerente e inativo).

## Defesa em profundidade: colunas brutas

Antes da alteração, a role operacional podia selecionar diretamente
`leads.raw_payload`, `appointments.raw_data`,
`flow_events.raw_data` e `sales.raw_data`.

Foi versionada e aplicada **somente no staging** a migration:

`apps/api/prisma/migrations/20261015_neon_sensitive_column_acl/migration.sql`

Ela revoga o SELECT em nível da tabela para essas quatro entidades e
concede SELECT apenas às colunas explicitamente permitidas. Mantém
as políticas RLS originais e os demais privilégios existentes.

**Pós-migração comprovado:**

- Todas as quatro colunas brutas negadas pela checagem de ACL
  `has_column_privilege`.
- SELECT de `id` permitido para leads e agendamentos.
- 14 tabelas com RLS ENABLE+FORCE e 20 políticas preservadas.
- Mesmas 2 lojas, 2 leads e 2 agendamentos sintéticos.
- Nenhuma alteração de schema na Neon main.

**Homologação SQL descartável (SUCCESS):**
https://github.com/Okkotsuyke/CRM-EUROVIA/actions/runs/38798377148

Reproduziu o privilégio excessivo antes do patch, aplicou a migration,
comprovou a separação entre lojas e os quatro SELECTs negados.

## HTTP Fastify + Prisma + PostgreSQL 17 REAL (CI descartável)

**Resultado: 7/7 testes aprovados no PostgreSQL 17 descartável**.

Execução GitHub Actions:
https://github.com/Okkotsuyke/CRM-EUROVIA/actions/runs/38799325079

Código:
- `apps/api/src/__tests__/neon-postgres-http.integration.test.ts`
- `scripts/security/neon-column-acl-ci.sh`
- `.github/workflows/neon-column-acl-ci.yml`

O teste não simula Prisma: ele instala o schema da aplicação em um
PostgreSQL 17 temporário, aplica RLS, ACL e auth SQL, cria duas lojas e
usuários sintéticos e usa um cliente `PrismaClient` conectado com uma
role de LOGIN sem `BYPASSRLS`.

Usa `Fastify.inject()` para verificar:
1. Login operacional válido e senha inválida rejeitada.
2. GET anônimo de leads/agendamentos com HTTP 401.
3. Consultas da loja A contendo somente seus próprios dados.
4. Loja B isolada e filtros de loja cruzados retornando vazio.
5. Detalhes autorizados e 404 para IDs de outra loja.
6. `rawPayload` / `rawData` ausentes das respostas; escritas comerciais,
   cron e Syonet continuam sob HTTP 503.
7. Rotação do refresh token, prevenção de replay, logout e
   inexistência de sessões ativas após os testes.

O teste usa apenas credenciais sintéticas do runner, com acesso à base
em `127.0.0.1:5432`. **Não acessa o Neon hospedado nem o Syonet**.

## Runtime hospedado — após ACL

O Preview existente do Fastify
`dpl_3TEbg1sNgwhkTM5diqWRKbkE9ziW` segue READY e
`GET /health` retornou HTTP 200 com `database=connected`
após a alteração da ACL no Neon staging.

**Não foi feito novo deploy de código nesta fase.**
A homologação HTTP autenticada na Vercel apontando para Neon hospedado
ainda não deve ser declarada concluída: uma tentativa anterior de criar
senha sintética temporária nesse staging foi bloqueada pela integração.
O problema foi contido com restauração da conta sintética. A evidência
7/7 desta fase é do CI isolado.

## Pendências antes de produção

- Completar homologação HTTP autenticada no Preview com Neon hospedado,
  por caminho de teste aprovado e que não altere credenciais sensíveis.
- Migrar operações comerciais de escrita do CRM para transações RLS,
  sem jamais realizar ações de escrita no Syonet.
- Migrar sessões do frontend para cookies `HttpOnly; Secure; SameSite`
  e proteção CSRF; impedir tokens de longo prazo em `localStorage`.
- Regularizar `_prisma_migrations` no staging antes de `migrate deploy`.
- Ensaiar backup/restauração, rollback e controles de deploy.
- Manter PR #1 em `draft` e nunca publicar sem testes integrados e
  aprovação específica para produção.

**Nenhum recurso do MVP-Creator, Sentry ou Syonet foi alterado.**
