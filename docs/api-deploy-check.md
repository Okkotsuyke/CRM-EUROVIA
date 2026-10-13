# API Serverless Deploy Checklist

**Data:** 2026-10-13  
**Commit:** `093a8db`  
**Status:** PRONTO PARA DEPLOY

---

## Validacoes

| Item | Status | Observacao |
|------|--------|------------|
| Handler `api/index.ts` sem `app.listen()` | PASS | Usa `fastify.inject()` para serverless |
| Handler converte VercelRequest -> Fastify.inject | PASS | req.method/url/headers/body mapeados corretamente |
| Handler converte resposta para VercelResponse | PASS | `res.status(json).setHeader(k,v).send(body)` |
| Singleton cold-start (getFastify) | PASS | Evita reconstrucao do app em cada invocao |
| `src/server.ts` sem `app.listen()` no caminho serverless | PASS | `app.listen()` restrito a dev local (`npx tsx watch src/server.ts`) |
| `src/server.ts` tem guard `!process.env.VERCEL` | PASS | `startSyncScheduler()` soh chamado se nao Vercel |
| `sync-scheduler.ts` desabilita em Vercel | PASS | `if (process.env.VERCEL === '1') return` na primeira linha |
| `sync-scheduler.ts` desabilita se SYNC_ENABLED != 'true' | PASS | Check existente |
| `dist/api/index.js` existe | PASS | Arquivo presente apos build |
| `dist/src/app.js` existe | PASS | App compilado |
| `build` via turbo (`pnpm turbo build --filter=@crm/api`) | PASS | `prisma generate && tsc` executados |
| Smoke tests | PASS | 5/5 testes passaram |

---

## Log de Build

```
> @crm/api@1.0.0 build
> prisma generate && tsc

Environment variables loaded from .env
Prisma schema loaded from prisma\schema.prisma
✔ Generated Prisma Client (v5.22.0)
```

---

## Log de Smoke Tests

```
vitest run v1.6.1

✓ src/__tests__/smoke.test.ts (5 tests)

Test Files  1 passed (1)
Tests       5 passed (5)
Duration    17.37s

Cenarios testados:
  GET  /health                      -> 200 (status: degraded, DB indisponivel em test)
  GET  /api/cron/health             -> 200
  POST /api/v1/auth/login (body vazio) -> 400 (Zod validation)
  POST /api/v1/auth/login (credenciais invalidas) -> 400
  GET  /api/cron/sync (sem x-vercel-cron) -> 403 (bloqueado)
```

---

## Arquivos Gerados pelo Build

```
dist/
  api/index.js          <-- handler serverless (entry point Vercel)
  src/app.js            <-- buildApp()
  src/server.js         <-- bootstrap local
  prisma/               <-- seed.js, test.js
  src/routes/           <-- todas as rotas compiladas
  src/services/         <-- todos os servicos compilados
```

---

## Vercel.json Corrigido

```json
{
  "version": 2,
  "buildCommand": "pnpm turbo build --filter=@crm/api",
  "installCommand": "pnpm install",
  "framework": null,
  "outputDirectory": "dist",
  "functions": {
    "api/index.ts": { "maxDuration": 300 }
  },
  "regions": ["gru1"],
  "crons": [
    { "path": "/api/cron/sync",   "schedule": "*/15 * * * *" },
    { "path": "/api/cron/health", "schedule": "*/15 * * * *" }
  ]
}
```

**Correcoes aplicadas:**
- `outputDirectory`: `apps/api/dist` -> `dist` (relativo ao projeto `apps/api/`)
- `/api/cron/sync`: schedule de `0 3 * * *` (diario 03h) -> `*/15 * * * *` (a cada 15min)
- Adicionado `/api/cron/health` no scheduler

---

## Commit

```
SHA: 093a8db8f3bfc21a771dc1a809ce1764ca943432
Branch: main
Mensagem: fix(api): corrigir outputDirectory do vercel.json para deploy serverless
```

---

## Prontido

A API esta **pronta para deploy serverless na Vercel**. O handler em `apps/api/dist/api/index.js` recebera as requests HTTP via `fastify.inject()` e o scheduler interno esta desabilitado em ambiente Vercel.

**Nao executar deploy manualmente.** O deploy automatico ocorre via push para `main` na Vercel (ja configurado).
