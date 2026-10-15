# CRM Eurovia — Procedimento obrigatório de deploy na Vercel

**Aplicável exclusivamente à API `crm-eurovia-api` e ao repositório
`Okkotsuyke/CRM-EUROVIA`.**
Objetivo: **nenhum redeploy por tentativa e erro**.

## Identidade obrigatória antes de qualquer operação

- Neon `crm-eurovia` — `noisy-hat-46747617`.
- Somente staging `br-bold-sun-b6p0nkhp`, banco `crm_eurovia`.
- Vercel `prj_yqg4rMwLALfSgojS1xV1ZkxrrIEH`.
- GitHub PR #1 da branch
  `fix/eurovia-hardening-deploy-20261015`.
- Preview exclusivamente; **jamais usar Production nem outro projeto**.
- `SYONET_USE_REAL=false` e `SYNC_ENABLED=false`, com rotas cron
  e de negócio bloqueadas até testes de RLS/Auth completos.

## Gate obrigatório em caso de falha

1. **Congelar tentativas:** não iniciar outro deploy; não promover e
   cancelar auto-deploy inesperado se necessário.
2. **Capturar evidências exatas:** deployment ID, SHA completo, branch,
   projeto/team Vercel, status do build, build logs, runtime logs no
   intervalo imediato e resposta HTTP do endpoint afetado.
3. **Determinar camada de falha:** raiz do monorepo/pnpm,
   empacotamento `@vercel/node`, ESM/CJS, dependências,
   Node runtime, variável de ambiente, Prisma, Neon, Fastify ou rota.
4. **Reproduzir em ambiente isolado**, com dados e chaves fictícios;
   nunca executar acesso real ao Syonet.
5. **Corrigir a causa**, não apenas a mensagem de erro; registrar no
   GitHub o diff e a fundamentação técnica.
6. **Validar antes de deploy:** `pnpm install --frozen-lockfile`,
   `pnpm --filter @crm/api build`, testes da API, verificação
   TypeScript, testes de RLS e smoke do handler compilado no Node.
   Todos os checks CI precisam estar `completed/success`.
7. **Conferir identidades e Secrets:** projeto/branch Neon exatos;
   Vercel API correta, apenas Preview da branch; runtime sem BYPASSRLS,
   nenhuma credencial em repositório, frontend ou logs.
8. **Executar só UM deploy** da revisão exata com CI aprovado, sem
   `target=production`.
9. **Pós-deploy:** verificar status `READY`, depois `GET /health`
   com HTTP 200 e DB conectado, proteção de rotas comerciais/cron
   com 503 enquanto staging gate ativo, e inspecionar logs de função
   para novos erros.
10. Se qualquer gate falhar, **voltar ao item 1**. Não fazer segunda
    tentativa sem nova investigação, correção e evidências.

A branch de segurança contém no `apps/api/vercel.json`:
`git.deploymentEnabled["fix/eurovia-hardening-deploy-20261015"]=false`,
impedindo deploy automático nesse caminho. Mudanças em documentos ou
testes CI não autorizam novo deployment por conta própria.

## Incidente comprovado: 15/10/2026

| Etapa | Evidência |
|---|---|
| Deploy anterior | `dpl_F32YhZBexzTHVPzkJEUH1jxeiTPb` |
| Build anterior | READY, mas runtime HTTP 500 |
| Erro interno | `ERR_MODULE_NOT_FOUND`, import ESM de `/var/task/apps/api/src/app` |
| Correção | `6c043665df4bbc523f7fe95026b489116ec1df64`, CommonJS e `@vercel/node` explícito |
| CI | https://github.com/Okkotsuyke/CRM-EUROVIA/actions/runs/38781885777 — SUCCESS |
| Deploy de confirmação | `dpl_7BrfLzbMsaujR73jHK1hvuRFTAzE`, Preview READY |
| GET /health | 200, `database=connected` |
| Rotas comerciais e cron | 503 proposital (`staging_security_gate`) |
| Neon staging | 14 tabelas RLS ENABLE+FORCE; 20 políticas |
| Neon main | 0 tabelas |
| Risco residual | `url.parse()` deprecado no Node 24; Sentry DSN ausente |

**Nunca concluir "sucesso operacional" somente com READY.**
O critério é: build + health + autorização + observabilidade + isolamento,
e uma aprovação distinta para produção.

**Regra Syonet:** nunca inserir, modificar, excluir ou executar qualquer
operação com efeitos colaterais no sistema. Toda consulta futura deverá
ser comprovadamente somente leitura; durante homologação da API,
a integração fica desabilitada.
