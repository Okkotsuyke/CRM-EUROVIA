# Vercel Config Report - Agente 2

## Resumo Executivo

**Status:** Parcialmente concluido - Projeto web configurado, projeto API bloqueado.

## Projetos Vercel

### 1. Web Project (crm-eurovia)

| Campo | Valor |
|-------|-------|
| **ID** | `prj_im7S5ejWUkCAvXIrlYJFPH4IK5sD` |
| **Nome** | `crm-eurovia` |
| **Framework** | `nextjs` (OK) |
| **rootDirectory** | `apps/web` (ATUALIZADO) |
| **Node Version** | `24.x` |
| **Conta** | `team_QFn8ZDw2kGtpbE3UboJv3TAd` |
| **Live** | `false` |
| **Dashboard URL** | https://vercel.com/team_QFn8ZDw2kGtpbE3UboJv3TAd/crm-eurovia |

### 2. API Project (crm-eurovia-api)

| Campo | Valor |
|-------|-------|
| **ID** | **NULL** |
| **Nome** | `crm-eurovia-api` (tentado) |
| **Status** | NAO EXISTE - ERRO 404 |
| **Criacao** | BLOQUEADA - ERRO 403 forbidden |

**Erro:**
```
403: Not authorized: Trying to access resource under scope "maykengld-9931". 
You must re-authenticate to this scope or use a token with access to this scope.
```

**Acao requerida:** Liberar permissao `projects:write` no token MCP ou criar via dashboard Vercel.

## Environment Variables - Web Project

### Ja existentes no projeto `crm-eurovia`:

| Variavel | Tipo | Targets | Status |
|----------|------|---------|--------|
| `NEXT_PUBLIC_SUPABASE_URL` | encrypted | production | OK |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | encrypted | production, preview | OK (criada nesta sessao) |
| `NEXT_PUBLIC_APP_URL` | encrypted | production | OK |
| `NEXT_PUBLIC_API_URL` | plain | production, preview | OK |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | encrypted | production | OK |
| `SUPABASE_SERVICE_ROLE_KEY` | sensitive | production | OK |
| `SYONET_USERNAME` | sensitive | production | OK |
| `SYONET_PASSWORD` | sensitive | production | OK |
| `SENTRY_DSN` | sensitive | production | OK |
| `CLOUDFLARE_API_TOKEN` | sensitive | production | OK |
| `RESEND_API_KEY` | sensitive | production | OK |
| `EMAIL_FROM` | sensitive | production | OK |
| E3_* (Supabase Integration) | sensitive | production, preview | OK |

## Environment Variables - API Project

**NAO CONFIGURADO** - Projeto nao existe.

Variaveis planejadas:
- `DATABASE_URL` (encrypted)
- `JWT_SECRET` (encrypted)
- `NODE_ENV` (plain = production)

## Arquivos de Configuracao

### `apps/api/vercel.json` (existente)
```json
{
  "version": 2,
  "buildCommand": "pnpm turbo build --filter=@crm/api",
  "installCommand": "pnpm install",
  "framework": null,
  "outputDirectory": "apps/api/dist",
  "functions": {
    "api/index.ts": { "maxDuration": 300 }
  },
  "regions": ["gru1"],
  "crons": [{ "path": "/api/cron/sync", "schedule": "0 3 * * *" }]
}
```

### `apps/web/` - vercel.json NAO existe
(Nao ha vercel.json especifico - usa config do projeto)

### `vercel.json` (raiz - monorepo)
Contem buildCommand e headers, mas nao deve ser usado diretamente pelo projeto.

## Acoes Pendentes

### 1. Criar Projeto API (BLOQUEADO)
- **Metodo:** `create_project` via MCP
- **Erro:** 403 forbidden
- **Solucao:** Liberar permissao `projects:write` no token Vercel MCP ou criar manualmente via dashboard

### 2. Configurar Env Vars API (BLOQUEADO)
- **Metodo:** `create_project_env` via MCP
- **Dependencia:** Projeto API precisa existir
- **Variaveis:** DATABASE_URL, JWT_SECRET, NODE_ENV

### 3. Conectar GitHub ao Projeto API
- **Aguardando:** Projeto API criado
- **Repo:** `Okkotsuyke/CRM-EUROVIA`

## Deploy URLs (apos promocao)

| Servico | URL Preview | URL Producao |
|---------|------------|--------------|
| Web | `crm-eurovia-git-*.vercel.app` | `crm-eurovia.vercel.app` |
| API | `crm-eurovia-api-git-*.vercel.app` | `crm-eurovia-api.vercel.app` |

## Recomendações

1. **Urgent:** Liberar permissao `projects:write` no token MCP para criar projeto API
2. **Apos criar API:** Configurar env vars do API (DATABASE_URL, JWT_SECRET)
3. **Apos deploy:** Atualizar `NEXT_PUBLIC_API_URL` para URL real da API
4. **Verificar:** Cron job `/api/cron/sync` configurado corretamente

---

*Gerado em: 2026-10-13*
*Agente: 2/5 - Config Vercel Projects*
