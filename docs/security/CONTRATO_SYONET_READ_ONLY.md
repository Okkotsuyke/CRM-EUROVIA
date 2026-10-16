# CRM EUROVIA — Contrato de integração Syonet SOMENTE LEITURA

**Regra obrigatória:** jamais criar, atualizar, excluir ou executar qualquer outra
mutação em registros, configurações, clientes, leads ou agenda do Syonet.

## Controles aplicados ao código (sem acessar o Syonet)

- Todos os contextos Playwright dos três clientes existentes recebem
  interceptação de rede antes da primeira página.
- Métodos HTTP diferentes de GET e HEAD são bloqueados em todas as origens.
- A origem Syonet deve ser HTTPS, coincidir exatamente com a configurada
  e utilizar apenas APIs GET explicitamente permitidas.
- GET de APIs fora da allowlist e caminhos/queries com ações potencialmente
  mutantes são negados.
- Service Workers foram desativados para impedir contorno do bloqueio por SW.
- APIs de extração executadas por page.evaluate continuam sujeitas à interceptação.
- TLS inseguro e flags Chromium que desativam proteções foram removidos.
- O login Syonet pode exigir POST: esse método permanece BLOQUEADO.
  Portanto a coleta real pode falhar **intencionalmente** até haver alternativa
  de autenticação de consulta validada. Não abrir exceção genérica ao POST.
- Não usar scripts avulsos / exploratórios do repositório em produção.
  Estes scripts precisam de auditoria individual; a proteção dos três
  clientes principais não representa auditoria de todos os scripts.
- Não contornar CAPTCHA, MFA, bloqueios de conta ou controles administrativos.
- CSV/DB local: transformações e INSERT/UPDATE ficam restritos ao CRM Eurovia.

## Pontos para validar antes de qualquer sync real

1. Credenciais de conta com permissões de leitura autorizadas.
2. API documentada e aprovada que não altere estado, inclusive via GET.
3. Método de autenticação sem risco de mutações de negócio.
4. Homologação com testes negativos e registro de rede sem dados sensíveis.
5. Habilitação explicita do sync somente após prova de leitura segura.
6. Se houver qualquer incerteza, falhar fechado e mostrar integração indisponível.

## Outros bloqueadores de produção

- Sincronização por mocks é proibida em NODE_ENV/VERCEL_ENV=production.
- fullLoad de leads está bloqueado porque o extrator atual é simulado.
- Cron exige CRON_SECRET forte, via Authorization Bearer; cabeçalho
  x-vercel-cron não autoriza.
- O banco Supabase Eurovia precisa de autenticação/permissão por loja e RLS.
- Nenhuma destas mudanças foi aplicada diretamente ao serviço Syonet.
