# CRM EUROVIA — Relatório de homologação de acesso público

**Data:** 15/10/2026
**Resultado:** APROVADO no PostgreSQL temporário (não equivale a produção).
**Execução auditável:** https://github.com/Okkotsuyke/CRM-EUROVIA/actions/runs/38759614645
**Commit ensaiado:** `a3d05df27ad7a8708898d7e5ff9c11c353854032`
**Projeto único:** CRM EUROVIA.

## Isolamento do ambiente

O GitHub Actions iniciou um serviço PostgreSQL 17 no próprio runner,
banco `eurovia_rls_ci`, acessível pelo script apenas via
`127.0.0.1:5432`. O Prisma criou as 14 tabelas do schema da API.
As roles `anon`, `authenticated` e `service_role` foram simuladas
com grants iniciais equivalentes ao problema detectado no Supabase.
Uma loja fictícia foi inserida somente nesse banco descartável.

A migração `docs/security/eurovia-rls-firewall.sql` foi executada
contra a instância temporária e validada por comandos SQL e SET ROLE,
sem entrar em contato com Syonet ou com o PostgreSQL de produção.

## Evidências executadas — GitHub Actions SUCCESS

| Teste | Expectativa | Resultado |
| --- | --- | --- |
| 1 — Antes do bloqueio | anon consegue SELECT de 1 linha sintética | PASS |
| 2 — RLS e grants | 14/14 tabelas RLS ativo, sem privilégios anon/authenticated | PASS |
| 3 — Operações SQL | SELECT e UPDATE como anon/authenticated rejeitados | PASS |
| 4 — Segunda camada | GRANT SELECT em transação não revela linha, graças à RLS | PASS |
| 5 — Acesso privilegiado | service_role fictício com BYPASSRLS lê linha, comprovando o risco dessa chave | PASS |
| 6 — Novas tabelas | tabela criada após mudança não herda grants públicos | PASS |

**Status da execução:** `completed / success`.
Link: https://github.com/Okkotsuyke/CRM-EUROVIA/actions/runs/38759614645

## Limites importantes

Este é um teste real e automatizado de **PostgreSQL**, não de Supabase
gerenciado ou PostgREST. Não valida, por exemplo: tokens do Supabase Auth,
Storage, políticas de sessão do BFF, acesso da conta runtime Prisma,
isolamento entre usuários por loja na mesma role SQL, restauração de backup
nem a integridade de dados importados.

**O Supabase CRM EUROVIA de produção permanece sem RLS aplicada.**
Inspeção em 15/10/2026 confirmou 14 tabelas `public` sem RLS,
com acesso aberto aos papéis `anon` e `authenticated`.
Nenhuma operação DDL/DML foi executada no banco de produção nesta
homologação. Não concluir que a produção já esteja protegida.

A consulta das branches Supabase mostrou **zero ambientes de desenvolvimento
existentes**. Criar uma branch Supabase real exigirá confirmação de custo,
organização e permissões; testar nela a Data API HTTP e as migrações
antes de promover qualquer alteração.

## Critérios para homologar Supabase staging de fato

1. Criar uma branch ou projeto exclusivo de `crm-eurovia`, com aprovação
   de eventuais cobranças; jamais reutilizar `mvp-creator`.
2. Recriar o schema completo em staging e confirmar que não há dados reais.
3. Testar antes/depois por Data API HTTP usando publishable/anon key
   de staging (sem copiar service_role para cliente web).
4. Validar com API Fastify, credencial de DB runtime e endpoint health.
5. Exercitar negações entre lojas e sessões ativas/revogadas.
6. Executar SQL versionado em staging, repetir Security Advisor
   e registrar resultados de retorno/erro e rastreabilidade.
7. Só com evidências e backup restaurável propor mudança de produção.

## Syonet

Zero conexões ou requisições ao Syonet. Não houve escrita, edição,
inserção ou exclusão em qualquer recurso do sistema de origem.

## Referências

- https://supabase.com/docs/guides/api/securing-your-api
- https://supabase.com/docs/guides/database/postgres/row-level-security
