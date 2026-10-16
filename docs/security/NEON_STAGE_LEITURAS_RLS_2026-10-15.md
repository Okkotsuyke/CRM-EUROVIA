# CRM EUROVIA — Próxima fase: RLS transacional em leads e agendamentos

Data: 15/10/2026. **Somente CRM Eurovia**.
Neon project `noisy-hat-46747617`, branch `br-bold-sun-b6p0nkhp`,
DB `crm_eurovia`. Projeto MVP-Creator PROIBIDO.

## Resultado 1 — autenticação ponta a ponta REAL: APROVADO

No Preview anterior da API `dpl_Dpk2nrYN9GT88NZWgQS1XjX3T1B2`
(commit `9bf4a39`) foram executados **19/19 testes HTTP reais**
usando contas sintéticas temporárias do Neon staging:

- Login operacional correto/incorreto, JWT curto e `/auth/me`
- Listagem de somente uma loja; outra loja por ID retornou 404
- Proteção contra uso de JWT operacional como token de avaliador
- Rotação de refresh opaco, rejeição de replay, logout e revogação
- Login de avaliador, `allowedStores` extraído do banco, não do JWT
- Bloqueio de cron e leads não migrados naquele commit

O teste usou Sandbox isolado em `gru1`, com rede autorizada
**somente** ao URL de Preview. Não efetuou contato com o Syonet.
Concluída a limpeza, senhas fictícias foram restauradas, zero tokens
novos ficaram ativos e a contagem anterior foi preservada.
O sandbox foi parado e seus cookies efêmeros eliminados.

## Resultado 2 — Leads e Agendamentos GET: implementados e CI PASS

Commit da API: `1420764964f411dfd06b5eb25db396dd16643d57`.

Implementadas somente consultas GET de listagem e detalhe para
`/api/v1/leads`, `/api/v1/leads/:id`,
`/api/v1/appointments` e `/api/v1/appointments/:id`.
Cada consulta:

1. Exige um JWT assinado válido e próprio de usuário operacional.
2. Recarrega usuário ativo, papel e loja do banco, nunca de claims JWT.
3. Usa a MESMA transação `Prisma.TransactionClient` de
   `SET LOCAL ROLE crm_eurovia_runtime` e
   `crm_eurovia.actor_id`.
4. Intersecta filtros recebidos com lojas autorizadas;
   nenhuma URL amplia o escopo RLS.
5. Usa `select` explícito; não inclui
   `Lead.rawPayload` nem `Appointment.rawData`.
6. Usa projeções restritas de usuários vinculados, sem senha/hash.
7. Limita paginação e retorna 404 para entidades fora da loja.

Arquivos: `src/routes/lead.routes.ts`,
`src/routes/appointment.routes.ts`,
`src/services/neon-readonly-select.ts` e
`src/services/lead-assignees.ts`.

Os novos **10 testes de leitura** passaram. Uma suíte anterior
esperava `503` para `GET /leads`; como GET agora é protegido por JWT,
a expectativa foi corrigida para `401` anônimo, sem ampliar acesso.

Execuções GitHub Actions para esse commit:

- CI geral e build: https://github.com/Okkotsuyke/CRM-EUROVIA/actions/runs/38795027342 — **SUCCESS**
- Auth SQL: https://github.com/Okkotsuyke/CRM-EUROVIA/actions/runs/38795027550 — **SUCCESS**
- PostgreSQL RLS: https://github.com/Okkotsuyke/CRM-EUROVIA/actions/runs/38795027438 — **SUCCESS**

## Resultado 3 — Preview novo: READY, proteção anônima validada

Deployment `dpl_3TEbg1sNgwhkTM5diqWRKbkE9ziW` (commit `1420764`).
Preview Vercel API: `crm-eurovia-o4hk341kc-maykengld-9931.vercel.app`.

- `/health` → HTTP 200 e `database=connected`.
- `GET /api/v1/leads` sem JWT → HTTP 401.
- `GET /api/v1/appointments` sem JWT → HTTP 401.
- `GET /api/cron/health` → HTTP 503 proposital.
- Runtime logs contêm 200, 401 e 503, **nenhum 500** observado
  no intervalo inspecionado.
- Neon staging: 14 tabelas, 20 políticas RLS.
- Neon **main**: 0 tabelas, intocada.
- Nenhum deploy de produção ou alteração no Sentry.

## Bloqueador novo — limpar credencial sintética no Neon staging

A tentativa seguinte de testar **GET autenticado de leads e agendamentos**
parou por uma restrição de segurança da ferramenta de integração.
O mesmo mecanismo impediu restaurar a senha da conta
**exclusivamente fictícia** `stg-actor-a` no Neon staging.

**Estado verificado na última consulta:**
- `stg-actor-a` permanece ativa com hash bcrypt de senha temporária,
  criada aleatoriamente durante preparação do teste; não deve ser usada.
- **ZERO** tokens de smoke-test ativos; 1 token inicial fictício existente.
- A outra conta sintética `stg-evaluator-a` não foi alterada nesta tentativa.
- A conta `crm_eurovia_staging_login` permanece `NOBYPASSRLS`.
- O banco principal continua inalterado e o teste não executou nenhum
  endpoint do Syonet.

**Ação de contenção necessária, aguardando autorização específica:**
restaurar a senha fictícia original de `stg-actor-a` ou desativar
a conta sintética no Neon staging, e confirmar por SQL somente leitura
que não existem credenciais e tokens ativos de teste. NÃO contornar
bloqueios de segurança da integração.

## Próximos gates

- Resolver primeiro o hash temporário da conta sintética.
- Executar homologação HTTP positiva de leituras entre lojas A/B
  mediante fluxo de teste autorizado.
- Prosseguir com migração das mutações comerciais sob RLS
  (somente banco CRM, jamais Syonet), com auditoria e testes próprios.
- Migrar tokens do navegador para cookie seguro + proteção CSRF.
- Conciliar histórico Prisma Migrate e backup/rollback antes da produção.
- Não ativar rotas cron/sincronização nem promover PR draft.

**Não inserir, modificar nem deletar qualquer recurso do Syonet.**
