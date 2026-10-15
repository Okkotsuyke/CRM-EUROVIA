# CRM Eurovia — Neon Staging: schema canônico + RLS

**Data:** 15/10/2026 · **Status:** instalado e homologado no STAGING
**Escopo:** SOMENTE CRM EUROVIA; Syonet totalmente intocado.

## Destino validado

| Recurso | Identificação |
| --- | --- |
| Neon organization | `org-sparkling-base-81574637` (Free) |
| Project name | `crm-eurovia` |
| Project ID | `noisy-hat-46747617` |
| Database | `crm_eurovia`, PostgreSQL 17.11 |
| Region | `aws-sa-east-1` (São Paulo) |
| Staging branch | `staging-security-rls`: `br-bold-sun-b6p0nkhp` |
| Main branch preservada | `main`: `br-delicate-sound-b6l7thd1` |
| **NÃO UTILIZAR** | Neon `nameless-night-94061643` (MVP-Creator) |

SQL executado em staging pelo Neon MCP com `project_id`, `branch_id`
e `database_name` explícitos; a segurança validou a identidade do branch
antes de executar qualquer DDL.

## Instalação do schema canônico

Gerado com Prisma 5.22.0, sem acessar bancos externos:
https://github.com/Okkotsuyke/CRM-EUROVIA/actions/runs/38768062195

SHA-256 do SQL original: `888d7899f0372c9bfa6180829b0ca43b33045c4f303656b804b6af70c9f76d8c`.

1. `apps/api/prisma/migrations/20261015_neon_canonical_init/migration.sql`
   (SQL gerado da `apps/api/prisma/schema.prisma`).
2. `apps/api/prisma/migrations/20261015_neon_rls_scope/migration.sql`
   (RLS e grants explícitos por role, versionados).
3. `apps/api/prisma/migrations/migration_lock.toml`
   (provider PostgreSQL).

O DDL canônico foi executado em **uma transação** no staging, com
86 comandos CREATE/ALTER e sem DROP. O SQL de RLS foi executado em
transação separada. Ajuste complementar de privilégios padrão de funções
foi aplicado no mesmo staging.

### Inventário verificado

| Verificação | Neon staging | Neon main |
| --- | ---: | ---: |
| Tabelas `public` | **14** | **0** |
| Enums PostgreSQL | **9** | **0** |
| Índices totais (incluindo índices de PK) | **54** | **0** |
| Foreign keys | **23** | **0** |
| Tabelas RLS `ENABLE` | **14** | **0** |
| Tabelas RLS `FORCE` | **14** | **0** |
| Políticas RLS | **20** | **0** |
| Funções privadas de autorização | **9** | **0** |

Nenhum projeto Vercel foi apontado ao staging, nem foi realizada qualquer
alteração no banco Supabase legado.

## Identidades e política RLS

O proprietário `crm_eurovia_owner` é uma role gerenciada pelo Neon com
`BYPASSRLS=true`. **PROIBIDO utilizar esta role na API.**

Criada no staging, por SQL (não pela Console/API Neon), a role
`crm_eurovia_runtime` com os atributos: `NOLOGIN`, `NOBYPASSRLS`,
`NOSUPERUSER`, `NOINHERIT`, sem propriedade de tabelas.
Ela destina-se à homologação e à futura concessão a uma role login de
menor privilégio, quando for criada com credenciais fortes no cofre.

- `public.stores`: SELECT limitado a loja do usuário autenticado e
  lojas explicitamente autorizadas para avaliador.
- `public.users`: SELECT do próprio usuário, gerente na própria loja
  e admin em todas; coluna `password` NÃO é concedida.
- `public.media_sources`: catálogo SELECT de usuários ativos.
- `public.leads`: SELECT e UPDATE somente na loja autorizada e
  em campos operacionais explicitamente permitidos.
- `public.lead_events`: SELECT/INSERT com lead da loja autorizada;
  inserção exige identidade do autor.
- `public.appointments`: SELECT/INSERT/UPDATE dentro da loja,
  com `lead_id` pertencente à mesma loja.
- `public.flow_events`, `sales`: SELECT por loja, com validação
  de correspondência com lead.
- `public.productivity_snapshots`, `sync_metrics`: SELECT por loja
  do usuário ou avaliador.
- `public.sync_runs`: SELECT somente para ADMIN ativo.
- `public.dashboard_users`: SELECT apenas do avaliador ativo com lojas
  permitidas; `password_hash` NÃO é concedida.
- `public.validation_reports`: acesso apenas ao próprio avaliador
  ativo e aos tipos STORE autorizado / OVERALL; demais tipos negados.
- `public.refresh_tokens`: **sem grants nem policies** para a role
  operacional (deny-by-default).

As funções de autorização `crm_security` são privadas, com `search_path`
fixo; quando necessário, funções `SECURITY DEFINER` consultam a role
e a loja de uma conta **ativa**, diretamente do PostgreSQL. Não confiam
em `role` ou `store_id` fornecidos pelo JWT.

O contexto de aplicação previsto usa, numa transação restrita,
`SET LOCAL crm_eurovia.actor_id` ou
`SET LOCAL crm_eurovia.dashboard_actor_id`. Ausência de contexto
produz **zero linhas**. Nenhuma Data API Neon foi provisionada.

### Auditoria de ACL verificada

- Grants públicos (PUBLIC) em 14 tabelas: **0**.
- Execuções de funções `crm_security` concedidas ao PUBLIC: **0**.
- 20 policies RLS vinculadas à role restrita.
- `crm_eurovia_runtime`: login **false**, BYPASSRLS **false**.
- Revogado por padrão o EXECUTE em funções novas do owner no âmbito
  GLOBAL de privilégios PostgreSQL.

## Testes reais com dados sintéticos — 16 de 16 PASS

Fixtures (somente staging): `stg-eurovia-loja-a`,
`stg-eurovia-loja-b`, leads, usuários, avaliadores, agendamentos,
vendas e métricas com IDs fictícios e senhas *não utilizáveis*.
Todos os dados sintéticos permanecem na branch staging.

**Oito cenários de leitura aprovados**, executando comandos com
`SET LOCAL ROLE crm_eurovia_runtime` e contextos de transação isolados:

1. Sem identidade: nenhuma linha visível.
2. Consultor loja A: apenas A.
3. Consultor loja B: apenas B.
4. ADMIN ativo: A e B.
5. Usuário desativado: nenhuma linha.
6. Avaliador autorizado apenas à A: A, nunca B.
7. Avaliador sem lojas: nenhuma linha.
8. MANAGER de A: somente dados de A; pode consultar contas da mesma loja.

**Oito cenários de escrita e privilégio aprovados:**

1. UPDATE do próprio lead autorizado: 1 linha.
2. UPDATE do lead de outra loja: 0 linhas.
3. INSERT de agendamento associado a lead de outra loja: negado pela RLS.
4. INSERT de evento do lead de outra loja: negado pela RLS.
5. SELECT da coluna de senha de usuário: permission denied.
6. SELECT de `refresh_tokens`: permission denied.
7. INSERT de validação referente a loja não autorizada: negado pela RLS.
8. SELECT do `password_hash` de avaliador: permission denied.

Pós-teste, foram conferidos a integridade dos leads e a inexistência
dos registros cuja criação deveria ser negada: **todos íntegros**.

## Ressalvas de segurança e implantação

1. **Contexto GUC ainda depende de uma API confiável:** PostgreSQL
   permite que uma conexão SQL execute `set_config` em atributos
   personalizados. Portanto, a futura conexão de runtime deve continuar
   **restrita ao backend**, nunca ir para navegador ou Data API pública.
   Fastify deve validar o usuário/sessão no servidor e definir o contexto
   **dentro da mesma transação Prisma** antes de qualquer consulta.
   Se for necessário resistir também à execução SQL arbitrária com
   credenciais runtime vazadas, adotar contexto assinado e validado no DB
   antes da publicação.
2. **Migração de auth pendente:** login Fastify legado lê hashes e
   refresh tokens; essas rotas exigem integração com auth segura e/ou
   role de autenticação separada. A role runtime não possui esses
   privilégios deliberadamente.
3. **Sincronização Syonet:** futuro worker deve usar papel separado
   e aprovações específicas. Nenhum método de escrita no Syonet
   poderá ser utilizado.
4. **Controle Prisma Migrate:** as duas migrations estão versionadas,
   mas foram aplicadas ao staging diretamente via Neon SQL, sem
   inicializar `_prisma_migrations`. Antes de `prisma migrate deploy`
   neste staging, realizar `prisma migrate resolve --applied` para
   ambas, com URI staging conferida, e verificar `migrate status`.
   **NÃO** executar `migrate deploy` cegamente para não reaplicar DDL.
5. **Neon main:** segue vazia; não há go-live, dados reais ou corte
   do Supabase. Garantir backup/restore, testes de API e revisão.
6. **Dados sintéticos:** nunca exportar este staging como fonte de
   dados comerciais/produção.
7. **Outros projetos:** Neon do MVP-Creator, Supabase MVP-Creator,
   Supabase Eurovia e Vercel de produção NÃO foram alterados.

Referência: https://neon.com/docs/manage/roles
