# CRM EUROVIA — Migração Supabase → Neon (staging configurado)
Data: 2026-10-15
Escopo: SOMENTE CRM Eurovia; Syonet estritamente somente leitura.

## Identidades verificadas (NAO trocar por projetos de outras aplicacoes)
- Neon organization: `org-sparkling-base-81574637` (plano Free).
- Projeto Neon EXCLUSIVO: `crm-eurovia`, id `noisy-hat-46747617`.
- Regiao AWS: `aws-sa-east-1`, São Paulo; PostgreSQL 17.
- Database: `crm_eurovia`, owner `crm_eurovia_owner`.
- Neon main branch: `br-delicate-sound-b6l7thd1`.
- Neon staging: `br-bold-sun-b6p0nkhp` (`staging-security-rls`).
- Neon de outro projeto, **PROIBIDO como alvo**: `nameless-night-94061643`, `neuro-ai-sis-mvp-creator`.
- Supabase legado (somente auditoria): `dzyuyddiyatiedtwblcj`, `crm-eurovia`.
- Supabase de OUTRO projeto, **PROIBIDO**: `dfqpirazzyleslhzegkz`.

## Operacoes realizadas
1. Conferidas contas, regioes e projetos Neon existentes.
2. Criado novo projeto Neon de nome distinto, em Sao Paulo.
3. Criada branch de staging a partir do main vazio.
4. Consultados explicitamente (com project_id, branch_id e database_name)
   staging e main: ambos PostgreSQL 17.11, sem tabelas de negocio.
5. Schema Prisma e RLS agora INSTALADOS e TESTADOS exclusivamente no staging; Neon main continua VAZIO.
6. Nenhum ambiente Vercel alterado e nenhum segredo importado.
7. Nenhuma chamada ao Syonet; nenhum recurso de outro projeto modificado.

## Bloqueios antes de conectar aplicação ou fazer deploy
- O schema Prisma do GitHub e divergente do PostgreSQL Supabase atual.
- Guardar exportacao do schema legado em backup seguro, sem segredos.
- Schema canônico Prisma e RLS foram instalados na staging Neon `br-bold-sun-b6p0nkhp`.
- Homologação funcional detalhada: `docs/security/NEON_STAGING_RLS_RESULTADO_2026-10-15.md`.
- Role `crm_eurovia_runtime` já criada sem LOGIN, SUPERUSER ou BYPASSRLS; integrar credenciais runtime separadas antes de conectar API.
- A política Neon específica está versionada em `apps/api/prisma/migrations/20261015_neon_rls_scope/migration.sql`; não executar o SQL legado Supabase contra Neon.
- Separar conta migradora (DDL) da conta API (DML) e usar RLS/escopo de loja
  setado em transacao. Testar falta de contexto como deny-by-default.
- Desativar ou nao provisionar Neon Data API diretamente para browser
  enquanto nao houver policies de autenticacao verificadas.
- Executar testes negativos para cross-store, acesso sem login,
  privilegios por roles e rollback antes de conectar Vercel.
- Autenticacao atual JWT Fastify e Supabase Auth parcial precisam de
  migracao controlada sem transportar credenciais antigas.

## Proximo gate
Somente apos schema/RLS, testes da API e revisao de diff, preparar conexao
`DATABASE_URL` de Vercel exclusivamente para este projeto Neon.
Nunca copiar tokens/connection strings para GitHub, conversas ou logs.
Sem promocao a producao nesta fase.
