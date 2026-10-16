# Migração do CRM Eurovia para Railway — produção

## Objetivo e limites

Substituir a hospedagem Vercel por dois containers Railway e **reutilizar** a base
PostgreSQL Neon existente (projeto `crm-eurovia` / database `crm_eurovia`).
Nenhum dado deve ser exportado, apagado, reinicializado ou migrado para outro banco
sem necessidade. Os dados do Syonet são exclusivamente consultados: a integração
não está autorizada a criar, editar ou excluir dados de negócio no Syonet.

O Railway é o destino de hospedagem; o repositório GitHub continua como fonte
única de código. Esta ramificação é uma candidata de produção e não implica
liberação até o checklist de homologação ser aprovado.

## Topologia

| Serviço Railway | Dockerfile (contexto = raiz do repositório) | Porta | Público? |
| --- | --- | --- | --- |
| `crm-eurovia-api` | `Dockerfile.railway.api` | 3001 | **Não**: apenas `railway.internal` |
| `crm-eurovia-web` | `Dockerfile.railway.web` | 3000 | **Sim**: domínio Railway e, depois, domínio próprio |

Os dois serviços ficam no **mesmo projeto e ambiente Railway**. O frontend
faz proxy de login e métricas via `CRM_API_INTERNAL_URL`, impedindo
acesso direto do navegador ao endereço privado da API.

O backend já escuta em `0.0.0.0:${PORT}`. O Chromium completo é instalado
no Docker (Debian + Playwright), e não depende do binário Lambda do
`@sparticuz/chromium`.

## Conexão e implantação

1. Conectar o app **Railway** no ChatGPT e autorizar acesso à conta/projeto. Alternativamente, abrir o console Railway e criar um projeto vazio chamado `crm-eurovia-production`.
2. Adicionar dois serviços GitHub apontando para `Okkotsuyke/CRM-EUROVIA`, branch `deploy/railway-neon-production-20261015`. **Deixar Root Directory em `/`** para preservar o contexto do monorepo pnpm.
3. Serviço API: definir `RAILWAY_DOCKERFILE_PATH=Dockerfile.railway.api`, configurar variáveis abaixo, porta 3001 e healthcheck `/health`. **Não gerar domínio público para a API**.
4. Serviço Web: definir `RAILWAY_DOCKERFILE_PATH=Dockerfile.railway.web`, configurar variáveis abaixo, porta 3000 e healthcheck `/avaliador/login`. Gerar domínio público HTTPS para o Web.
5. Conferir logs, chamadas autenticadas, scoping de lojas, extração real do Syonet e contagem de linhas Neon. Só depois associar domínio personalizado e liberar o acesso.
6. Manter implantação anterior desligada **somente após** comprovar a nova URL. O rollback é restaurar a plataforma/commit anterior, sem trocar o banco.

### Variáveis do serviço API

| Variável | Valor / origem |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `3001` |
| `DATABASE_URL` | Connection string **secreta** do Neon **produção**, banco `crm_eurovia`. A identidade deve ser revisada para evitar `BYPASSRLS` antes da liberação |
| `JWT_SECRET` | Segredo forte, gerado no provedor, no mínimo 32 caracteres |
| `CRM_ALLOWED_ORIGINS` | URL HTTPS exata do serviço Web (ex.: `https://<dominio-gerado>`); sem `*` |
| `CRM_NEON_STAGING_MODE` | `false` |
| `SYONET_URL` | `https://viasul.syonet.com` |
| `SYONET_USERNAME` | Variável secreta do ambiente atual, transferida por canal seguro |
| `SYONET_PASSWORD` | Variável secreta do ambiente atual, transferida por canal seguro |
| `SYONET_USE_REAL` | `true` (nunca usar mocks em produção) |
| `SYONET_HEADLESS` | `true` |
| `SYNC_ENABLED` | **`false` inicialmente**. Habilitar após verificar que os números extraídos são reais, não zeros gerados por mapeamento incompleto |

A aplicação inicia o scheduler imediatamente se `SYNC_ENABLED=true`.
Nunca habilitar sincronização automática apenas para preencher o dashboard
sem comprovar que a fonte e os campos de métricas foram interpretados corretamente.
Se o Syonet estiver indisponível, apresentar estado de erro/stale; não dados mock.

### Variáveis do serviço Web

| Variável | Valor / origem |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `CRM_DEPLOY_TARGET` | `railway` |
| `CRM_EUROVIA_PRODUCTION_READONLY` | `true` |
| `CRM_API_INTERNAL_URL` | `http://crm-eurovia-api.railway.internal:3001` (ou URL privada fornecida pelo Railway) |

Não transferir `CRM_EUROVIA_VERCEL_BYPASS_SECRET` para Railway:
a API deve ser acessada exclusivamente via rede privada Railway. Não
colocar URL privada em `NEXT_PUBLIC_API_URL` porque essa variável é
exposta a navegadores e as rotas operacionais antigas não usam o proxy
de avaliação. Se o portal operacional for liberado, homologar suas rotas
e autenticação separadamente.

## Portões obrigatórios para liberação

- [ ] GitHub Actions **Validate Railway Docker images**: API e Web verdes no commit exato.
- [ ] Deploy Railway API `RUNNING` e `GET /health` retorna 200 com `database=connected`.
- [ ] Deploy Railway Web `RUNNING` e login renderiza sem erro.
- [ ] O proxy Web chama a API pelo hostname `railway.internal`, nunca pela Vercel.
- [ ] Usuário avaliador loga com credencial provisionada (não registrar senha em logs).
- [ ] `/api/v1/dashboard/auth/me` autenticado, rotas `/api/v1/analytics/*` respeitam `allowedStores`, tokens inválidos retornam 401.
- [ ] Validar que a identidade Postgres usada em runtime **não** possui acesso indevido a dados de outras lojas nem `BYPASSRLS`.
- [ ] GET autenticado Syonet funciona, com evidência de que **somente** endpoints de consulta e autenticação foram chamados.
- [ ] Números de funil e produtividade reconciliados com o painel Syonet (o endpoint `GET /api/dashboard/189` sozinho devolve metadados de widgets, **não** seus valores). Não considerar 7 linhas zeradas como sincronização homologada.
- [ ] `SYNC_ENABLED=true` somente depois dessa reconciliação.
- [ ] DNS/HTTPS do domínio final e rollback testados.

## Falhas e diagnóstico

A cada falha de build/deploy, inspecionar o **commit**, Dockerfile efetivo,
fase da instalação, logs e variáveis. Não solicitar novamente o deploy antes
de corrigir a causa-raiz. Nunca usar `prisma db push` nem rodar seed de
desenvolvimento em produção.

**Credenciais:** inserir exclusivamente como secrets do Railway; nunca
salvar `DATABASE_URL`, `SYONET_PASSWORD` ou `JWT_SECRET` neste documento,
em arquivos rastreados pelo Git ou em saída de CI.
