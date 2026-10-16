/**
 * Contencao read-only para integracoes de consulta ao Syonet.
 *
 * NENHUMA escrita de dados no Syonet e autorizada. Nao existe flag para
 * desativar esse bloqueio. A unica excecao a GET/HEAD e o POST do proprio
 * formulario de login do portal, que somente autentica a sessao e nao
 * cria, edita, exclui ou importa dados de negocio.
 *
 * IMPORTANTE: bloquear verbos mutantes nao basta: endpoints GET com
 * efeitos colaterais tambem precisam ser barrados; por isso URLs de
 * API nao explicitamente permitidas sao negadas.
 */
import type { BrowserContext } from 'playwright-core';

export type ReadOnlyDecision = { allowed: boolean; reason: string };
const READ_METHODS = new Set(['GET', 'HEAD']);
const LOGIN_PATH = '/portal/app.do';
const DATA_API = /^\/api\/(?:parametro\/[^/]+|pagelogincrm|v2\/recaptchaclientkey|dashboard(?:\/\d+)?(?:\/(?:dados|data|execute|result|resultado|query|valores|widgets))?|dataset\/\d+(?:\/(?:dados|data|execute|result|resultado|query|valores|widgets))?|empresa(?:\/\d+)?|usuario(?:\/\d+)?|midia(?:\/\d+)?|funil|produtividade|evento)\/?$/i;
const MUTATION = /(?:^|[^a-z])(salvar|gravar|editar|update|insert|create|delete|remove|excluir|apagar|alterar|incluir|cancelar|aprovar|rejeitar|upload|importar|exportar|reset|clear|truncate)(?:$|[^a-z])/i;

export function checkSyonetReadOnlyRequest(
  requestUrl: string,
  method: string,
  baseUrl: string,
): ReadOnlyDecision {
  let destination: URL;
  let base: URL;
  try {
    destination = new URL(requestUrl);
    base = new URL(baseUrl);
  } catch {
    return { allowed: false, reason: 'invalid-url' };
  }

  if (base.protocol !== 'https:' || !base.hostname || destination.protocol !== 'https:') {
    return { allowed: false, reason: 'https-required' };
  }
  const normalizedMethod = method.toUpperCase();
  // O shell autenticado do Syonet usa POST em endpoints de contexto de sessão
  // que apenas carregam a empresa/relacionamento da sessão. Eles não gravam
  // clientes, leads, eventos ou qualquer dado de negócio; permanecem restritos
  // a duas rotas explícitas para permitir a montagem somente-leitura das telas.
  const isApprovedSessionReadPost =
    normalizedMethod === 'POST' &&
    /^\/api\/sessao\/(?:empresa|usuario\/empresa)\/?$/i.test(destination.pathname);
  // The dashboard UI uses this POST as a report/query transport. Its body is
  // composed of pagination/filter fields (date, status, company, team/user,
  // totalizer id); it returns report data and does not mutate CRM records.
  // Keep the approval exact-path and method-specific so no other POST becomes
  // writable through discovery mode.
  const isApprovedDashboardReadPost =
    normalizedMethod === 'POST' &&
    /^\/api\/relatorio\/resumo-eventos\.json\/?$/i.test(destination.pathname);
  const isApprovedLoginPost =
    normalizedMethod === 'POST' &&
    (
      (
        destination.pathname.toLowerCase() === LOGIN_PATH &&
        destination.searchParams.size === 1 &&
        destination.searchParams.get('modulo')?.toLowerCase() === 'login'
      ) ||
      (
        destination.pathname.toLowerCase() === '/portal/validarlogonusuario.do' &&
        destination.searchParams.has('opcaoAtualizacao')
      ) ||
      (
        /^\/api\/auth\/token\/?$/i.test(destination.pathname) &&
        destination.searchParams.size === 0
      )
    );

  if (!READ_METHODS.has(normalizedMethod) && !isApprovedLoginPost && !isApprovedSessionReadPost) {
    return { allowed: false, reason: 'write-method-denied' };
  }

  // Impede envio de requisicoes para outros hosts de Syonet.
  // A tela de login carrega somente uma imagem institucional de um endpoint
  // separado; ela e GET-only e fica explicitamente limitada a esse recurso.
  const isApprovedLoginImage =
    READ_METHODS.has(normalizedMethod) &&
    destination.origin === 'https://escritorio.syonet.com:8282' &&
    /^\/public\/imagelogincrm\/\d+$/i.test(destination.pathname);
  if (isApprovedLoginImage) {
    return { allowed: true, reason: 'read-only-login-asset' };
  }
  if (
    destination.hostname === base.hostname ||
    destination.hostname.endsWith('.syonet.com')
  ) {
    if (destination.origin !== base.origin) {
      return { allowed: false, reason: 'outside-approved-origin' };
    }
    if (isApprovedLoginPost) {
      return { allowed: true, reason: 'read-only-login' };
    }
    if (isApprovedSessionReadPost) {
      return { allowed: true, reason: 'read-only-session-context' };
    }
    if (isApprovedDashboardReadPost) {
      return { allowed: true, reason: 'read-only-dashboard-query' };
    }
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(destination.pathname);
    } catch {
      return { allowed: false, reason: 'invalid-path' };
    }
    const path = decodedPath.toLowerCase();
    if (MUTATION.test(path) || MUTATION.test(destination.search)) {
      return { allowed: false, reason: 'mutating-action-denied' };
    }
    if (path.startsWith('/api/') && !DATA_API.test(path)) {
      // Modo de descoberta técnica: permite consultar endpoints GET/HEAD ainda
      // não conhecidos para identificar as fontes reais usadas pelas telas.
      // O bloqueio de métodos mutantes e de URLs com verbos de mutação continua
      // ativo, portanto este modo não autoriza escrita no Syonet.
      if (process.env.SYONET_DISCOVER_SCREENS === 'true') {
        return { allowed: true, reason: 'read-only-discovery-api' };
      }
      return { allowed: false, reason: 'api-not-allowlisted' };
    }
    // Somente portal de consulta e recursos estaticos.
    if (!path.startsWith('/api/') && !/^\/$|^\/portal\/(?:app\.do|acessasistema\.do|geraImagemLogon\.do)(?:\/)?$|^\/portal\/app\/.*\.(?:js|css|json|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)$/i.test(path) && !/^\/portal\/react-web-components\/.*\.(?:js|css|json|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)$/i.test(path) && !/^\/(?:portal\/)?(?:assets|static|resources|public|images|img|fonts|css|js|vendor|dist|webjars)\//i.test(path) && !/^\/(?:favicon\.ico|robots\.txt)$/i.test(path)) {
      // Durante a descoberta, a aplicação pode navegar para uma tela .do
      // diferente do shell inicial. Continua sendo somente GET/HEAD e os
      // termos de mutação já foram bloqueados acima.
      if (process.env.SYONET_DISCOVER_SCREENS === 'true' &&
          path.startsWith('/portal/')) {
        return { allowed: true, reason: 'read-only-discovery-navigation' };
      }
      return { allowed: false, reason: 'navigation-not-allowlisted' };
    }
  }
  return { allowed: true, reason: 'read-only' };
}

export function assertSyonetReadOnlyRequest(
  requestUrl: string,
  method: string,
  baseUrl: string,
): void {
  const decision = checkSyonetReadOnlyRequest(requestUrl, method, baseUrl);
  if (!decision.allowed) {
    // Nao registrar URL, query ou credenciais: podem conter dados pessoais.
    throw new Error('Syonet: requisicao impedida pela politica de somente leitura (' + decision.reason + ')');
  }
}

export async function installSyonetReadOnlyGuard(
  context: BrowserContext,
  baseUrl: string,
): Promise<void> {
  if (new URL(baseUrl).protocol !== 'https:') {
    throw new Error('Syonet: URL-base deve usar HTTPS');
  }
  // Context route protege novas paginas/popup; serviceWorkers: 'block'
  // precisa ser definido em browser.newContext pelo cliente.
  await context.route('**/*', async route => {
    const req = route.request();
    const decision = checkSyonetReadOnlyRequest(req.url(), req.method(), baseUrl);
    if (!decision.allowed) {
      if (process.env.SYONET_DISCOVER_SCREENS === 'true') {
        try {
          const blockedUrl = new URL(req.url());
          let postData = '';
          let bodyKeys: string[] = [];
          if (req.method().toUpperCase() === 'POST') {
            try { postData = String(req.postData() || ''); } catch {}
            try {
              const parsed = JSON.parse(postData);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) bodyKeys = Object.keys(parsed).slice(0, 80);
            } catch {
              bodyKeys = postData ? postData.split('&').map((part) => part.split('=')[0]).filter(Boolean).slice(0, 80) : [];
            }
          }
          console.log('🔒 Syonet read-only guard blocked: ' + req.method() + ' ' + blockedUrl.pathname + ' reason=' + decision.reason +
            (req.method().toUpperCase() === 'POST' ? ' meta=' + JSON.stringify({ bodyLength: postData.length, bodyKeys }) : ''));
        } catch {}
      }
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
}