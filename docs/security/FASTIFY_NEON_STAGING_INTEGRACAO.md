# CRM EUROVIA — Fastify no Neon staging (preview somente)

Destinos autorizados:
- Neon project `noisy-hat-46747617` (`crm-eurovia`), AWS São Paulo
- Branch `br-bold-sun-b6p0nkhp` (`staging-security-rls`)
- Database `crm_eurovia`
- Projeto Vercel `crm-eurovia-api` (`prj_yqg4rMwLALfSgojS1xV1ZkxrrIEH`)
- Branch GitHub `fix/eurovia-hardening-deploy-20261015` somente em Preview.

O projeto Neon `nameless-night-94061643` (MVP-Creator) é expressamente
PROIBIDO. A branch principal Neon também está fora de escopo.

## Problemas identificados
1. O projeto Vercel chamado `crm-eurovia-api` construía o FRONTEND Next.js
   antes desta configuração; ajustar Root Directory para `apps/api`.
2. Roles criadas pela Neon API nascem com `neon_superuser` e `BYPASSRLS`!
   A role `crm_eurovia_api_staging` foi criada, mas REJEITADA
   como credencial de API após constatar esses privilégios. O Neon
   recusou a revogação/ALTER ROLE no plano atual. Não configurar
   sua senha em Vercel. Avaliar sua remoção pela Console com autorização.
3. A credencial de app deverá ser uma role criada com SQL no staging,
   LOGIN, NOBYPASSRLS, NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
   NOINHERIT, membro apenas de `crm_eurovia_runtime` para SET ROLE.
4. A role de aplicação não pode acessar tabelas fora de transação
   com `SET LOCAL ROLE crm_eurovia_runtime` e contexto de ator validado.
5. O modo de staging da API mantém SOMENTE /health disponível; toda rota
   de negócio responde 503 de forma intencional até o trabalho de
   integração Auth / RBAC de cada rota.

## Segurança em runtime

- `validateNeonStagingEnv` verifica projeto, branch, região,
  schema, nome da role, SSL obrigatório e `VERCEL_ENV=preview`.
- `checkNeonStagingReadiness` testa o banco como usuário de login
  sem bypass, verifica FORCE RLS nas 14 tabelas e executa uma
  transação que `SET LOCAL ROLE crm_eurovia_runtime`. Sem
  identidade assinada no backend, a consulta a `stores` deve
  retornar **zero linhas**.
- `withNeonStagingActor` define o ator no contexto transacional
  exclusivamente para uso FUTURO depois de validar sessão no Fastify.
  NÃO expor dados SQL nem aceitar actor_id de parâmetros da URL.
- Todos os endpoints de Syonet estão bloqueados nesse preview; nenhum
  job cron/Syonet deve ser agendado.
- DATABASE_URL/JWT_SECRET são variáveis Secret da Vercel apenas
  Preview da branch de segurança, nunca arquivos Git ou frontend.

## Gates para abrir demais rotas da API
1. Integração de autenticação com role própria de auth, sem BYPASSRLS.
2. Converter todas as consultas de negócios para transações com
   RLS contexto validado, incluindo serviços/singletons Prisma.
3. Testes com 2 lojas sintéticas cobrindo leitura e escrita,
   sessões inativas, admin e avaliações.
4. Regularizar a tabela `_prisma_migrations` do staging via
   `prisma migrate resolve --applied` (não reaplicar DDL).
5. Verificar preview, runtime, Sentry e rollback.
6. Nunca promover Neon staging ou alterar Supabase sem homologação.
