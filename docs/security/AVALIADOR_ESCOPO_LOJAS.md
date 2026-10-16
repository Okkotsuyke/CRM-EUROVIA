# CRM EUROVIA — Isolamento do modulo Avaliador

As rotas do avaliador anteriormente verificavam apenas `type=dashboard`
no JWT e podiam entregar dados de todas as lojas do Syonet.

## Alteracao na branch de seguranca

- Identidade, estado ativo, papel e `allowedStores` passam a ser
  carregados no banco da API em cada requisicao.
- Rota com lista vazia de lojas: HTTP 403, sem chamada externa.
- O mapeamento de lojas permitidas e derivado de
  `Store.syonetName` e da allowlist `STORE_MAPPING`; falha fechada
  quando nao e possivel resolver o identificador externo.
- Toda lista obtida do Syonet nas rotas /leads, /summary, /kpis e /sales
  e filtrada por IDs externos autorizados antes da resposta.
- POST /validate aceita somente STORE da lista autorizada e OVERALL;
  LEAD/SALE/APPOINTMENT/VL/MEDIA retornam HTTP 503 ate haver
  comprovacao de vinculo por loja, para evitar registrar dado de
  outra concessionaria.
- DELETE de validacao preserva restricao existente por dashboardUserId.
- Instanciacao do Prisma e credenciais Syonet nao ocorrem mais ao
  importar o modulo: API sobe sem credenciais de integracao opcionais.

## Limites e cuidado operacional

- A extração atualmente faz leitura ampla antes de filtrar no servidor;
  a proxima evolucao e restringir a extracao na origem por empresa.
- O bloqueio de mutacoes Syonet e feito no Playwright guard;
  scripts avulsos ainda precisam de auditoria antes de execucao.
- Login do Syonet que exige POST permanece bloqueado, por decisao
  explicita: nao contornar autenticacao sem contrato de leitura seguro.
- Nunca executar Syonet durante testes de CI. Todos os testes
  sao locais, sem rede externa.

## Validacao pendente
Executar testes de avaliador autorizado e proibido usando DB de
homologacao com lojas sinteticas. Nao liberar a producao antes de
validar que nenhum endpoint expõe dados cross-store.
