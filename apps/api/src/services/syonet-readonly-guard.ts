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
import type { BrowserContext } from 'playwright';

export type ReadOnlyDecision = { allowed: boolean; reason: string };
const READ_METHODS = new Set(['GET', 'HEAD']);
const LOGIN_PATH = '/portal/app.do';
const DATA_API = /^\/api\/(?:dashboard(?:\/\d+)?|empresa(?:\/\d+)?|usuario(?:\/\d+)?|midia(?:\/\d+)?|funil|produtividade|evento)\/?$/i;
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
  const isApprovedLoginPost =
    normalizedMethod === 'POST' &&
    destination.pathname.toLowerCase() === LOGIN_PATH &&
    destination.searchParams.get('modulo')?.toLowerCase() === 'login';

  if (!READ_METHODS.has(normalizedMethod) && !isApprovedLoginPost) {
    return { allowed: false, reason: 'write-method-denied' };
  }

  // Impede envio de requisicoes para outros hosts de Syonet.
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
      return { allowed: false, reason: 'api-not-allowlisted' };
    }
    // Somente portal de consulta e recursos estaticos.
    if (!path.startsWith('/api/') && !/^\/$|^\/portal\/(?:app\.do|acessasistema\.do)(?:\/)?$|^\/(?:portal\/)?(?:assets|static|resources|public|images|img|fonts|css|js|vendor|dist|webjars)\/|^\/(?:favicon\.ico|robots\.txt)$/i.test(path)) {
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
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
}
