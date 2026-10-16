# CRM EUROVIA - Estado verificado em 15/10/2026

## Escopo e fontes

Apenas CRM EUROVIA. Conferidos repositório `Okkotsuyke/CRM-EUROVIA`,
Vercel `crm-eurovia` e Supabase `crm-eurovia`. Esta branch contém
correções de contenção e preparação; **não comprova deploy funcional**.

## Divergência entre arquivo local, repositório e Vercel (P0)

- O relatório SESSAO_15-10-2026.md informa alterações locais sem commit em
  `apps/web/src/lib/prisma/index.ts` e um endpoint em
  `apps/web/src/app/api/health/route.ts`.
- A branch remota `main` no commit `cfe8c1b3b46841796d5aefe6171fdd1043180b77` NÃO possui
  `apps/web/src/`; ela possui `apps/web/app/` e `apps/web/lib/`.
- O log do último deployment `dpl_5og9LWZk5dHiDPxPxLdeQYhTMztH`
  mostra build de `./src/app/api/health/route.ts` falhando ao importar
  `@/lib/prisma`.
- Portanto, o erro pertence à fonte enviada ao último deployment pela
  Vercel CLI e NÃO pode ser corrigido com segurança inventando uma árvore
  `src/` na versão remota.
- Verificar o `git status`, `tsconfig.json`, root efetivo do deploy e os
  conteúdos locais. Um arquivo `prisma.ts` normalmente resolve como
  `@/lib/prisma` quando o alias aponta para seu diretório correto;
  movê-lo para `prisma/index.ts` por si só não corrige aliases inválidos.
- Branch padrão do GitHub: `develop`. A `main` está seis commits à frente.
  Projetos/ambientes da Vercel apontam para `main` nas últimas tentativas.
  Não misturar os históricos sem comparar alterações.

## Segurança (P0)

- Repositório é público. Foram encontradas 5 trilhas de cookies/sessões
  versionadas; esta branch propõe removê-las e ignorá-las em commits futuros.
  A remoção NÃO apaga o histórico: rotacionar/revogar sessões e credenciais
  afetadas, examinar backups, forks, artefatos e traces.
- Supabase `crm-eurovia` ativo em `sa-east-1`, 14 tabelas no schema public
  com RLS DESABILITADA. Advisor reporta ERROR `rls_disabled_in_public`.
  A listagem das tabelas indicou zero linhas em todas nesta inspeção.
- `docs/security/eurovia-rls-firewall.sql` é uma proposta de contenção,
  NÃO uma migração executada. Adaptar permissões por loja antes de dados reais.
- Exemplo de ambiente frontend fazia referência ao ref de OUTRO projeto
  (MVP-Creator). Foi substituído por placeholders sem referência cruzada.

## CI e deploy (P0/P1)

- Workflow existente tentava publicar PRs via token Vercel em linha de comando,
  baixava artefato não gerado e publicava em main automaticamente, sem
  sequência comprovada de migrações/testes. Removemos temporariamente as
  etapas de publicação; validações CI são mantidas.
- Vercel `crm-eurovia` tem último deploy em ERROR; domínio customizado
  `crm-eurovia.com` consta como verificado, mas não está comprovado READY.
- Usar preview de uma revisão exata da branch remota e validar logs. NÃO
  promover a produção apenas porque um build ou health passou.
- `turbo.json`: apenas variáveis NEXT_PUBLIC aprovadas entram no build.
  Variáveis E3_/service_role/postgres/sessões NÃO devem ser repassadas ao
  bundle web para silenciar warnings. Separar variáveis por projeto e ambiente.
- O endpoint /api/health do frontend passou a ser liveness sem divulgar
  presença/ausência de tokens nem depender de integrações opcionais.
  Readiness da API/banco deve ser implementada e verificada separadamente.

## Critérios mínimos para avançar

1. Importar a versão local atual em branch nova sem sobrescrever main; comparar
   cuidadosamente `src/` vs `app/` e corrigir alias Prisma na fonte efetiva.
2. Validar build Next e API com CI e preview Git, provando o commit implantado.
3. Rotacionar credenciais/sessões possivelmente expostas.
4. Ensaiar SQL de RLS + grants/policies de loja com testes reais em staging.
5. Separar projetos Vercel para web e API ou comprovar arquitetura de proxy.
6. Verificar autenticação/autorização, sincronização Syonet e integridade dos
   indicadores sem mocks em produção.
7. Criar pipeline de produção aprovado, com migração e plano de rollback.
8. Conectar Resend, Sentry e Cloudflare com dados/contas corretos e testar.
9. Somente então fazer deploy de produção, smoketests e monitoramento.

Estados nesta revisão: GitHub/infra inspecionados = CONCLUÍDO;
RLS aplicada, segredos rotacionados, API implantada, build e produção =
NÃO EXECUTADOS. Não alterar o projeto mvp-creator.
