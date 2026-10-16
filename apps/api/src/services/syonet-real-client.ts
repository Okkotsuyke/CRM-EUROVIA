/**
 * Syonet Real Client - Cliente para extração de dados do CRM Syonet (VIA SUL/EUROVIA)
 *
 * ATENÇÃO: Este módulo é apenas para LEITURA de dados do sistema Syonet.
 * Não são feitas alterações, inserções ou exclusões no sistema alvo.
 *
 * Usa Playwright para automação do navegador + API REST para extração de dados.
 *
 * API Endpoints descobertos:
 * - GET  /api/dashboard         - Lista de dashboards disponíveis
 * - GET  /api/dashboard/{id}    - Detalhes de um dashboard
 * - GET  /api/empresa           - Lista de empresas/lojas
 * - GET  /api/usuario           - Lista de usuários
 * - GET  /api/midia             - Lista de mídias
 * - GET  /api/funil             - Dados do funil
 *
 * Empresas disponíveis (exemplo):
 * - 71: VIASUL PIEDADE - PE (FIAT)
 * - 72: VIASUL ARRUDA - PE (FIAT)
 * - 75: VIASUL DUNAS - CE (FIAT)
 * - 91: BYD ARRUDA - PE (BYD)
 * - 92: BYD CAMINHO DAS ARVORES - BA (BYD)
 * - 102: BYD WASHINGTON SOARES - CE (BYD)
 *
 * Dashboards importantes:
 * - 189: Incluidos / Agendados / Comparecidos / Vendas
 * - 162: Produtividade Resultado
 * - 244: Funil de Vendas
 */

import { chromium as playwrightChromium, Browser, Page, BrowserContext } from 'playwright-core';
import { assertSyonetReadOnlyRequest, installSyonetReadOnlyGuard } from './syonet-readonly-guard';
import {
  normalizeMedia,
  normalizeLeadStatus,
  STORE_MAPPING,
  VL_CONSULTANTS,
  FunilMetrics,
  ProductivityMetrics,
  LeadData,
} from './syonet-client';

// Timeout padrão em ms
const DEFAULT_TIMEOUT = 60000;
const LOGIN_TIMEOUT = 30000;
// Tempo para React renderizar completamente (SPAs precisam de tempo)
const REACT_WAIT_TIME = 18000;

export interface SyonetRealConfig {
  baseUrl: string;
  username: string;
  password: string;
  headless?: boolean;
  timeout?: number;
  sessionCacheMinutes?: number;
}

export interface SyonetRealCredentials {
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  isLoggedIn: boolean;
  cookies: string;
  lastLoginTime: number;
}

// Singleton instance com cache de sessão
let browserInstance: Browser | null = null;
let contextInstance: BrowserContext | null = null;
let pageInstance: Page | null = null;
let isLoggedIn = false;
let sessionCookies: string = '';
let lastLoginTime: number = 0;

// Configurações de cache
const SESSION_CACHE_MINUTES = 25; // Cache sessão por 25 minutos

// Escopo produtivo do dashboard aprovado: 7 lojas das praças Fortaleza/Salvador.
// A conta do Syonet pode enxergar outras empresas, mas elas não entram no CRM
// até serem explicitamente adicionadas ao escopo de negócio.
const CRM_PRODUCTION_SYONET_STORE_IDS = new Set([75, 102, 12, 23, 86, 77, 92]);

/**
 * Obtém ou cria uma instância do navegador
 */
async function getBrowser(config: SyonetRealConfig): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    console.log('🔧 Syonet: Iniciando navegador...');
    const isVercel = process.env.VERCEL === '1' || Boolean(process.env.VERCEL_ENV);
    if (isVercel) {
      // @sparticuz/chromium is ESM-only; keep the production API CommonJS build
      // and load the module through Node's native dynamic import.
      const serverlessChromium = await new Function(
        'return import("@sparticuz/chromium")',
      )();
      serverlessChromium.default.setGraphicsMode = false;
      browserInstance = await playwrightChromium.launch({
        headless: true,
        args: [...serverlessChromium.default.args, '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        executablePath: await serverlessChromium.default.executablePath(),
      });
    } else {
      // Railway/Docker installs the browser matching playwright-core
      // under PLAYWRIGHT_BROWSERS_PATH during the image build.
      const executablePath = process.env.SYONET_CHROMIUM_EXECUTABLE_PATH ||
        (process.env.PLAYWRIGHT_BROWSERS_PATH ? playwrightChromium.executablePath() : undefined);
      if (!executablePath) {
        throw new Error('Syonet: defina SYONET_CHROMIUM_EXECUTABLE_PATH no ambiente local');
      }
      browserInstance = await playwrightChromium.launch({
        headless: config.headless ?? true,
        executablePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
    }

    console.log('✅ Syonet: Navegador iniciado em modo ' + (isVercel ? 'serverless' : 'local'));
  }
  return browserInstance;
}

/**
 * Obtém ou cria um contexto do navegador
 */
async function getContext(browser: Browser, baseUrl: string): Promise<BrowserContext> {
  if (!contextInstance || contextInstance.pages().length === 0) {
    contextInstance = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      serviceWorkers: 'block',
    });
    await installSyonetReadOnlyGuard(contextInstance, baseUrl);
  }
  return contextInstance;
}

/**
 * Obtém ou cria uma página
 */
async function getPage(browser: Browser, baseUrl: string): Promise<Page> {
  if (!pageInstance || pageInstance.isClosed()) {
    const context = await getContext(browser, baseUrl);
    pageInstance = await context.newPage();
    pageInstance.setDefaultTimeout(DEFAULT_TIMEOUT);
    pageInstance.setDefaultNavigationTimeout(DEFAULT_TIMEOUT);
  }
  return pageInstance;
}

/**
 * Verifica se a sessão está válida (cache)
 */
function isSessionValid(): boolean {
  if (!isLoggedIn || !pageInstance || pageInstance.isClosed()) {
    return false;
  }
  const sessionAge = Date.now() - lastLoginTime;
  const maxAge = SESSION_CACHE_MINUTES * 60 * 1000;
  return sessionAge < maxAge;
}

/**
 * Extrai cookies da sessão atual
 */
async function getSessionCookies(): Promise<string> {
  if (!pageInstance) return '';

  const cookies = await pageInstance.context().cookies();
  sessionCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  return sessionCookies;
}

/**
 * Faz uma requisição à API do Syonet
 */
async function apiRequest(page: Page, endpoint: string, options: RequestInit = {}): Promise<any> {
  const cookies = await getSessionCookies();
  const url = new URL(endpoint, process.env.SYONET_URL || 'https://viasul.syonet.com').href;
  assertSyonetReadOnlyRequest(url, options.method || 'GET', process.env.SYONET_URL || 'https://viasul.syonet.com');

  const timeoutMs = Math.max(5000, Number(process.env.SYONET_API_TIMEOUT_MS || 15000));

  const response = await page.evaluate(async (args: {
    url: string;
    cookie: string;
    options: RequestInit;
    timeoutMs: number;
  }) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), args.timeoutMs);
    try {
      const res = await fetch(args.url, {
        ...args.options,
        signal: controller.signal,
        headers: {
          'Cookie': args.cookie,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(args.options.headers || {})
        }
      });

      const text = await res.text();
      try {
        return { status: res.status, data: JSON.parse(text) };
      } catch {
        return { status: res.status, data: text };
      }
    } catch (error) {
      return {
        status: 0,
        data: null,
        error: error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : 'request-failed',
      };
    } finally {
      window.clearTimeout(timer);
    }
  }, { url, cookie: cookies, options, timeoutMs }) as { status: number; data: unknown; error?: string };

  if (response.status === 401 || response.status === 403) {
    throw new Error('Não autenticado na API do Syonet');
  }

  return response as { status: number; data: unknown; error?: string };
}

type FunnelMetricField = 'leadsTotal' | 'appointmentsTotal' | 'appointmentsConfirmed' | 'flowTotal' | 'salesTotal';

const METRIC_LABEL_KEYS = new Set([
  'label', 'nome', 'titulo', 'title', 'descricao', 'description',
  'metrica', 'metric', 'chave', 'key', 'nomeKpi', 'kpi',
]);

const METRIC_VALUE_KEYS = new Set([
  'valor', 'value', 'total', 'count', 'quantidade', 'qtd',
  'resultado', 'numero', 'valorTotal', 'totalValue',
]);

function metricFieldFromText(text: string): FunnelMetricField | null {
  const normalized = text.toLowerCase();
  if (/taxa|rate|percent|%/.test(normalized)) return null;
  if (/confirmad/.test(normalized)) return 'appointmentsConfirmed';
  if (/vend|venda|sale/.test(normalized)) return 'salesTotal';
  if (/comparecid|fluxo|visita|showroom/.test(normalized)) return 'flowTotal';
  if (/agend|appointment|marcad/.test(normalized)) return 'appointmentsTotal';
  if (/incluid|incluído|lead|recebid|oportun|entrada/.test(normalized)) return 'leadsTotal';
  return null;
}

function parseMetricNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || /[a-z%]/i.test(raw)) return null;
  const match = raw.match(/-?\d[\d.,]*/);
  if (!match) return null;
  const token = match[0];
  const normalized = token.includes(',') && token.includes('.')
    ? token.replace(/\./g, '').replace(',', '.')
    : token.replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

type MetricCandidate = {
  field: FunnelMetricField;
  value: number;
  score: number;
  path: string;
};

function extractFunnelMetricCandidates(payload: unknown): MetricCandidate[] {
  const candidates: MetricCandidate[] = [];
  const seen = new WeakSet<object>();

  function visit(node: unknown, path: string, inheritedLabel = ''): void {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);

    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, path + '[' + index + ']', inheritedLabel));
      return;
    }

    const obj = node as Record<string, unknown>;
    const localLabels: string[] = [];
    for (const [key, value] of Object.entries(obj)) {
      if (METRIC_LABEL_KEYS.has(key) && typeof value === 'string') {
        if (metricFieldFromText(value)) localLabels.push(value);
      }
    }
    const label = [...localLabels, inheritedLabel].filter(Boolean).join(' | ');

    for (const [key, value] of Object.entries(obj)) {
      const directField = metricFieldFromText(key);
      const numeric = parseMetricNumber(value);
      if (directField && numeric !== null) {
        candidates.push({ field: directField, value: numeric, score: 90, path: path + '.' + key });
      }
      if (METRIC_VALUE_KEYS.has(key) && numeric !== null && label) {
        const labelField = metricFieldFromText(label);
        if (labelField) {
          candidates.push({ field: labelField, value: numeric, score: 100, path: path + '.' + key });
        }
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      visit(value, path + '.' + key, label);
    }
  }

  visit(payload, 'ROOT');
  return candidates;
}

function extractFunnelMetricsRobust(payload: unknown): Partial<Record<FunnelMetricField, number>> {
  const best: Partial<Record<FunnelMetricField, MetricCandidate>> = {};
  for (const candidate of extractFunnelMetricCandidates(payload)) {
    const current = best[candidate.field];
    if (!current || candidate.score > current.score) best[candidate.field] = candidate;
  }
  return Object.fromEntries(Object.entries(best).map(([field, candidate]) => [field, candidate!.value])) as Partial<Record<FunnelMetricField, number>>;
}

function collectSyonetApiPaths(payload: unknown): string[] {
  const found = new Set<string>();
  const seen = new WeakSet<object>();

  function visit(node: unknown): void {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);

    if (Array.isArray(node)) {
      node.slice(0, 50).forEach(visit);
      return;
    }

    for (const value of Object.values(node as Record<string, unknown>)) {
      if (typeof value === 'string' && value.includes('/api/')) {
        try {
          const url = new URL(value, process.env.SYONET_URL || 'https://viasul.syonet.com');
          if (url.origin === (new URL(process.env.SYONET_URL || 'https://viasul.syonet.com')).origin) {
            found.add(url.pathname);
          }
        } catch {
          // Ignore non-URL strings.
        }
      } else {
        visit(value);
      }
    }
  }

  visit(payload);
  return [...found].slice(0, 30);
}

function summarizeDatasetQuery(value: unknown): unknown {
  if (typeof value !== 'string') return value && typeof value === 'object' ? { type: 'object', keys: Object.keys(value as object).slice(0, 80) } : { type: typeof value };
  const raw = value.trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return { type: 'json', structure: summarizeSyonetPayload(parsed) };
    }
  } catch {}
  return {
    type: 'text',
    length: raw.length,
    preview: raw
      .replace(/(['"])(?:\\\\.|(?!\\1).)*\\1/g, '$1<redacted>$1')
      .replace(/\\s+/g, ' ')
      .slice(0, 1800),
  };
}

function summarizeSyonetPayload(payload: unknown): string {
  const signals = extractFunnelMetricCandidates(payload)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(candidate => candidate.field + '=' + candidate.value + '@' + candidate.path);
  const apiPaths = collectSyonetApiPaths(payload);

  const safeKeys = new Set([
    'id', 'idDashboard', 'idAba', 'idComponente', 'idWidget', 'idKpi', 'idDataset',
    'tipo', 'type', 'nome', 'titulo', 'title', 'path', 'url', '_url',
    'endpoint', 'method', 'metodo', 'ordem', 'ativo', 'visivel', 'query', 'dataSource', 'primaryKey',
  ]);

  function safeStructure(node: unknown, depth: number): unknown {
    if (depth > 9 || node === null || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) {
      return { arrayLength: node.length, items: node.slice(0, 8).map(item => safeStructure(item, depth + 1)) };
    }
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = { keys: Object.keys(obj).slice(0, 80) };
    for (const [key, value] of Object.entries(obj)) {
      if (!safeKeys.has(key)) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
        if (key === 'url' || key === '_url' || key === 'path' || key === 'endpoint') {
          try {
            const u = new URL(String(value), process.env.SYONET_URL || 'https://viasul.syonet.com');
            out[key] = u.pathname;
          } catch {
            out[key] = '<non-url>';
          }
        } else {
          out[key] = value;
        }
      }
    }
    for (const key of ['abas', 'filtros', 'componentes', 'widgets', 'dados', 'data', 'configuracao', 'config', 'colunas', 'headers', 'agrupamentos', 'ordenacao', 'opcoes', 'parametros', 'query', 'dataSource']) {
      if (!(key in obj)) continue;
      const raw = obj[key];
      if ((key === 'config' || key === 'data' || key === 'dados' || key === 'colunas' || key === 'headers' || key === 'agrupamentos' || key === 'ordenacao' || key === 'opcoes' || key === 'parametros' || key === 'query' || key === 'dataSource') && typeof raw === 'string') {
        try {
          out[key] = safeStructure(JSON.parse(raw), depth + 1);
        } catch {
          out[key] = '<embedded-string>';
        }
      } else {
        out[key] = safeStructure(raw, depth + 1);
      }
    }
    return out;
  }

  if (payload === null || typeof payload !== 'object') {
    return JSON.stringify({ rootType: typeof payload, signals, apiPaths });
  }
  const root = Array.isArray(payload)
    ? { rootType: 'array', length: payload.length }
    : { rootType: 'object', keys: Object.keys(payload as Record<string, unknown>).slice(0, 60) };
  return JSON.stringify({ ...root, signals, apiPaths, structure: safeStructure(payload, 0) });
}

async function waitForInputs(page: Page, maxAttempts = 60): Promise<number> {
  let inputCount = 0;
  let attempts = 0;

  while (inputCount === 0 && attempts < maxAttempts) {
    await page.waitForTimeout(500);
    inputCount = await page.evaluate(() => document.querySelectorAll('input').length);
    attempts++;
  }

  return inputCount;
}

/**
 * Realiza login no Syonet (CORRIGIDO para React/SPAs)
 *
 * IMPORTANTE: O Syonet usa React com campos controlados.
 * O preenchimento via page.fill() é necessário para funcionar corretamente.
 */
export async function syonetLogin(config: SyonetRealConfig): Promise<boolean> {
  try {
    // Verificar se já temos sessão válida
    if (isSessionValid()) {
      console.log('🔐 Syonet: Usando sessão em cache');
      return true;
    }

    console.log(`🔐 Syonet: Iniciando login como ${config.username}...`);

    // Garantir navegador limpo
    if (pageInstance && !pageInstance.isClosed()) {
      await pageInstance.close();
    }
    if (contextInstance) {
      await contextInstance.close();
      contextInstance = null;
    }
    if (browserInstance && browserInstance.isConnected()) {
      await browserInstance.close();
    }

    const browser = await getBrowser(config);
    const page = await getPage(browser, config.baseUrl);

    const observedApiCalls = new Map<string, Set<number>>();
    const browserDiagnostics: string[] = [];
    const sanitizeDiagnostic = (value: string) => String(value || '')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi, '<email>')
      .replace(/Bearer\\s+[^\\s]+/gi, 'Bearer <redacted>')
      .replace(/Basic\\s+[^\\s]+/gi, 'Basic <redacted>')
      .replace(/\\b(?:senha|password|token|cookie|authorization)\\b[^\\n]{0,180}/gi, '<credential-redacted>')
      .replace(/\\s+/g, ' ')
      .slice(0, 500);
    const recordBrowserDiagnostic = (kind: string, value: string) => {
      const item = kind + ': ' + sanitizeDiagnostic(value);
      if (!browserDiagnostics.includes(item)) browserDiagnostics.push(item);
    };
    const recordApiCall = (url: string, status?: number) => {
      try {
        const parsed = new URL(url);
        if (!parsed.pathname.startsWith('/api/')) return;
        const key = parsed.pathname;
        const statuses = observedApiCalls.get(key) || new Set<number>();
        if (status !== undefined) statuses.add(status);
        observedApiCalls.set(key, statuses);
      } catch {}
    };
    page.on('request', (req) => recordApiCall(req.url()));
    page.on('response', (res) => recordApiCall(res.url(), res.status()));
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') recordBrowserDiagnostic('console-' + msg.type(), msg.text());
    });
    page.on('pageerror', (error) => recordBrowserDiagnostic('pageerror', error.message));
    page.on('requestfailed', (req) => recordBrowserDiagnostic('requestfailed', req.failure()?.errorText || 'unknown'));

    // Ir para página de login
    console.log('📍 Navegando para página de login...');
    await page.goto(`${config.baseUrl}/portal/app.do?modulo=login#/login`, {
      // O portal pode manter requests abertas durante o bootstrap do SPA.
      // O que precisamos aqui é o commit da navegação; os campos são aguardados
      // explicitamente logo depois.
      waitUntil: 'commit',
      timeout: LOGIN_TIMEOUT,
    });
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});

    // CRÍTICO: Aguardar React renderizar completamente
    // O Syonet é um SPA React e precisa de tempo para montar o DOM
    console.log(`⏳ Aguardando React renderizar (${REACT_WAIT_TIME / 1000}s)...`);
    await page.waitForTimeout(REACT_WAIT_TIME);

    // Aguardar inputs aparecerem no DOM
    console.log('⏳ Aguardando inputs aparecerem...');
    const inputCount = await waitForInputs(page);

    if (inputCount === 0) {
      console.error('❌ Syonet: Timeout esperando inputs aparecerem');
      return false;
    }

    console.log(`✅ Inputs encontrados: ${inputCount}`);

    // Obter referências aos inputs
    const inputs = await page.$$('input');
    if (inputs.length < 2) {
      console.error('❌ Syonet: Menos de 2 inputs encontrados');
      return false;
    }

    // Preencher usando page.fill() QUE FUNCIONA COM REACT
    // Primeiro input = usuário, segundo = senha
    console.log('📝 Preenchendo credenciais...');
    await inputs[0].fill(config.username);
    await inputs[1].fill(config.password);
    console.log('✅ Credenciais preenchidas');

    // Clicar no botão "Entrar"
    console.log('🔘 Clicando em Entrar...');
    const enterBtn = await page.$('button:has-text("Entrar")');
    if (enterBtn) {
      await enterBtn.click();
    } else {
      // Fallback: pressionar Enter no campo de senha
      await page.keyboard.press('Enter');
    }

    // Aguardar redirecionamento
    console.log('⏳ Aguardando redirecionamento...');
    await page.waitForTimeout(10000);

    const currentUrl = page.url();
    console.log(`📍 URL atual: ${currentUrl}`);
    try {
      const contextPages = page.context().pages();
      const pageStates = [];
      for (const p of contextPages) {
        pageStates.push({
          url: p.url().split('?')[0],
          title: await p.title().catch(() => ''),
          frames: p.frames().map((frame) => frame.url().split('?')[0]).slice(0, 20),
          dom: await p.evaluate(() => ({
            bodyChildren: document.body?.children.length || 0,
            elementCount: document.querySelectorAll('*').length,
            scriptCount: document.querySelectorAll('script').length,
            linkCount: document.querySelectorAll('link').length,
            textLength: String(document.body?.innerText || '').length,
          })).catch(() => null),
        });
      }
      console.log('🔎 Syonet context pages after login: ' + JSON.stringify(pageStates));
      console.log('🔎 Syonet DOM diagnostics after login: ' + JSON.stringify(await page.evaluate(() => ({
        readyState: document.readyState,
        bodyTextLength: String(document.body?.innerText || '').length,
        bodyChildren: Array.from(document.body?.children || []).map((el: Element) => el.tagName.toLowerCase()),
        scriptSrcs: Array.from(document.scripts).map((s) => s.src).filter(Boolean).slice(0, 20),
        iframeSrcs: Array.from(document.querySelectorAll('iframe')).map((f) => f.src).filter(Boolean).slice(0, 20),
        roots: Array.from(document.querySelectorAll('#root,#app,[id="app"],[id="root"]')).map((el: Element) => ({
          tag: el.tagName.toLowerCase(), id: el.id, childCount: el.children.length,
          textLength: String((el as HTMLElement).innerText || '').length,
        })).slice(0, 10),
      }))));
      console.log('🔎 Syonet browser diagnostics: ' + JSON.stringify(browserDiagnostics.slice(0, 80)));
    } catch {}
    console.log('🔎 Syonet API calls observadas durante login/dashboard: ' + JSON.stringify(
      [...observedApiCalls.entries()].map(([path, statuses]) => ({ path, statuses: [...statuses] })).slice(0, 300)
    ));

    // Verificar se login foi bem-sucedido
    const loginSuccess = !currentUrl.includes('login');

    if (loginSuccess) {
      // Atualizar cookies e marcação de login
      await getSessionCookies();
      isLoggedIn = true;
      lastLoginTime = Date.now();
      if (process.env.SYONET_DISCOVER_UI === 'true') {
        try {
          const dashboardElements = await page.evaluate(() => Array.from(document.querySelectorAll('*'))
            .map((el: any) => ({
              tag: String(el.tagName || ''),
              text: String(el.innerText || el.textContent || '').trim().slice(0, 100),
              role: String(el.getAttribute?.('role') || ''),
              aria: String(el.getAttribute?.('aria-label') || ''),
            }))
            .filter((x) => /^dashboard$/i.test(x.text) || /dashboard/i.test(x.aria))
            .slice(0, 80));
          console.log('🔎 Syonet dashboard elements: ' + JSON.stringify(dashboardElements));

          const dashboardTarget = page.getByText('Dashboard', { exact: true }).first();
          if (await dashboardTarget.count()) {
            await dashboardTarget.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(30000);
            console.log('🔎 Syonet dashboard navigation after click: ' + page.url() + ' hash=' + await page.evaluate(() => window.location.hash));
          } else {
            await page.waitForTimeout(30000);
          }
          console.log('🔎 Syonet dashboard DOM state: ' + JSON.stringify(await page.evaluate(() => ({
            url: location.href,
            hash: location.hash,
            bodyChildren: document.body?.children.length || 0,
            elementCount: document.querySelectorAll('*').length,
            iframeCount: document.querySelectorAll('iframe').length,
            scriptCount: document.querySelectorAll('script').length,
            resourceCount: performance.getEntriesByType('resource').length,
          }))));
        } catch {
          console.warn('⚠️ Falha ao interagir com navegação Dashboard do Syonet');
        }
      }

      if (process.env.SYONET_DISCOVER_BUNDLE === 'true') {
        try {
          const scripts = await page.evaluate((baseUrl) => {
            const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
            return [...new Set(entries.map((e) => e.name)
              .filter((name) => name.startsWith(baseUrl) && /\.js(?:[?#]|$)/i.test(name)))].slice(0, 40);
          }, config.baseUrl);

          const findings: Array<{ path: string; status: number; length: number; terms: Record<string, number>; apiRoutes: string[]; chunkApiRoutes: string[]; snippets: string[] }> = [];
          for (const src of scripts) {
            try {
              const response = await page.request.get(src, { timeout: 30000 });
              const text = await response.text();
              const lower = text.toLowerCase();
              const apiRoutes: string[] = [];
              const routePattern = /["'](\/api\/[^"'\s]{1,180})["']/g;
              for (const match of text.matchAll(routePattern)) {
                if (!apiRoutes.includes(match[1])) apiRoutes.push(match[1]);
                if (apiRoutes.length >= 300) break;
              }
              const chunkApiRoutes: string[] = [];
              const chunkPattern = /["']((?:\.\.?\/|\/)[^"'\s]{1,180}\.js(?:\?[^"'\s]*)?)["']/g;
              const chunkCandidates: string[] = [];
              for (const match of text.matchAll(chunkPattern)) {
                const candidate = match[1];
                if (!candidate.includes('/api/') && !chunkCandidates.includes(candidate)) chunkCandidates.push(candidate);
                if (chunkCandidates.length >= 80) break;
              }
              for (const candidate of chunkCandidates) {
                try {
                  const chunkUrl = new URL(candidate, src).href;
                  if (new URL(chunkUrl).origin !== new URL(src).origin) continue;
                  const chunkResponse = await page.request.get(chunkUrl, { timeout: 15000 });
                  if (!chunkResponse.ok()) continue;
                  const chunkText = await chunkResponse.text();
                  for (const match of chunkText.matchAll(routePattern)) {
                    if (!chunkApiRoutes.includes(match[1])) chunkApiRoutes.push(match[1]);
                    if (chunkApiRoutes.length >= 500) break;
                  }
                } catch {}
                if (chunkApiRoutes.length >= 500) break;
              }
              const terms: Record<string, number> = {};
              for (const term of ['dataset', 'dashboard', 'iddataset', '/api/', 'execute', 'executar', 'consulta', 'query']) {
                terms[term] = lower.split(term.toLowerCase()).length - 1;
              }

              const snippets: string[] = [];
              for (const term of ['dataset', 'dashboard', 'idDataset', '/api/', 'execute', 'executar', 'consulta', 'query']) {
                let from = 0;
                const maxHits = term === '/api/' ? 50 : 6;
                for (let hit = 0; hit < maxHits; hit++) {
                  const index = lower.indexOf(term.toLowerCase(), from);
                  if (index < 0) break;
                  const snippet = text.slice(Math.max(0, index - 180), Math.min(text.length, index + 420))
                    .replace(/\s+/g, ' ')
                    .replace(/(['"])(?:\\.|(?!\\1).)*\\1/g, '$1<redacted>$1');
                  snippets.push(term + ': ' + snippet);
                  from = index + term.length;
                }
              }

              findings.push({
                path: new URL(src).pathname,
                status: response.status(),
                length: text.length,
                terms,
                apiRoutes,
                chunkApiRoutes,
                snippets: snippets.slice(0, 80),
              });
            } catch (error) {
              findings.push({
                path: new URL(src).pathname,
                status: 0,
                length: 0,
                terms: {},
                apiRoutes: [],
                chunkApiRoutes: [],
                snippets: ['fetch-error'],
              });
            }
          }
          console.log('🔎 Syonet JS resources: ' + JSON.stringify(scripts));
          console.log('🔎 Syonet JS API routes: ' + JSON.stringify([...new Set(findings.flatMap((f) => [...f.apiRoutes, ...f.chunkApiRoutes]))]));
          console.log('🔎 Syonet JS bundle diagnostics: ' + JSON.stringify(findings));
        } catch {
          console.warn('⚠️ Falha ao inspecionar bundles JS do Syonet');
        }
      }
      if (process.env.SYONET_DISCOVER_SCREENS === 'true') {
        try {
          await discoverSyonetDashboardSources(config, page);
        } catch (error) {
          console.warn('⚠️ Syonet: descoberta de fontes do dashboard falhou; login continua válido');
        }
        try {
          await discoverSyonetScreens(config, page);
        } catch (error) {
          console.warn('⚠️ Syonet: descoberta de telas falhou; login continua válido');
        }
      }
      console.log('✅ Syonet: Login realizado com sucesso');
      return true;
    } else {
      console.error('❌ Syonet: Login falhou - ainda na página de login');
      return false;
    }
  } catch (error) {
    console.error('❌ Syonet: Erro no login:', error);
    isLoggedIn = false;
    return false;
  }
}

/**
 * Verifica se está autenticado (com verificação de cache)
 */
export function isSyonetAuthenticated(): boolean {
  return isSessionValid();
}


type SyonetScreenTarget = {
  key: string;
  labels: string[];
};

const SYONET_SCREEN_TARGETS: SyonetScreenTarget[] = [
  {
    key: 'FUNIL_KPI_FLUXO_DIARIO',
    labels: [
      '[VENDAS] - KPI - Fluxo de Loja - Diário (NOVO)',
      'KPI - Fluxo de Loja - Diário',
      'Fluxo de Loja - Diário',
    ],
  },
  {
    key: 'DASH_PRODUTIVIDADE_RESULTADO',
    labels: [
      '0001 [BDC] - Dash Produtividade Resultado',
      'Dash Produtividade Resultado',
      'Produtividade Resultado',
    ],
  },
  {
    key: 'TRABALHOS_CARTEIRA',
    labels: ['TRABALHOS CARTEIRA', 'Trabalhos Carteira'],
  },
  {
    key: 'LEAD_X_VENDEDOR_LOJA',
    labels: ['Lead x Vendedor Loja', 'Lead X Vendedor Loja'],
  },
  {
    key: 'LEADS_X_OPERADOR_BDC_ESPELHADO',
    labels: ['Leads X Operador BDC Espelhado', 'Leads x Operador BDC Espelhado'],
  },
  {
    key: 'VISITA_AGENDA',
    labels: ['VISITA AGENDA', 'Visita Agenda'],
  },
];

async function clickUiLabel(page: Page, labels: string[]): Promise<{ clicked: boolean; label?: string; text?: string }> {
  for (const label of labels) {
    try {
      const result = await page.evaluate((targetLabel) => {
        const wanted = targetLabel.replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = (el: Element) => {
          const style = window.getComputedStyle(el as HTMLElement);
          const rect = (el as HTMLElement).getBoundingClientRect();
          return style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0;
        };
        const candidates = Array.from(document.querySelectorAll(
          'button,a,[role="button"],[role="menuitem"],[role="link"],[role="tab"],li'
        )).filter(isVisible) as HTMLElement[];
        const normalized = (el: HTMLElement) =>
          String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const exact = candidates.find((el) => normalized(el) === wanted);
        const partial = candidates.find((el) => normalized(el).includes(wanted));
        const target = exact || partial;
        if (!target) return null;
        target.scrollIntoView({ block: 'center', inline: 'center' });
        target.click();
        return { text: normalized(target).slice(0, 180) };
      }, label);
      if (result) return { clicked: true, label, text: result.text };
    } catch {}
  }
  return { clicked: false };
}

async function captureScreenDom(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const textOf = (el: Element) => String((el as HTMLElement).innerText || el.textContent || '')
      .replace(/\s+/g, ' ').trim().slice(0, 180);
    const visible = (el: Element) => {
      const style = window.getComputedStyle(el as HTMLElement);
      const rect = (el as HTMLElement).getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,[role="heading"]'))
      .filter(visible).map(textOf).filter(Boolean).slice(0, 80);
    const controls = Array.from(document.querySelectorAll(
      'button,[role="button"],[role="tab"],label,input,select'
    )).filter(visible).map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: textOf(el),
      aria: String(el.getAttribute('aria-label') || '').slice(0, 120),
      name: String(el.getAttribute('name') || '').slice(0, 120),
      type: String(el.getAttribute('type') || '').slice(0, 60),
    })).filter((x) => x.text || x.aria || x.name).slice(0, 160);
    const tables = Array.from(document.querySelectorAll('table')).map((table) => ({
      headers: Array.from(table.querySelectorAll('thead th,[role="columnheader"]'))
        .map(textOf).filter(Boolean).slice(0, 80),
      rowCount: table.querySelectorAll('tbody tr,[role="row"]').length,
    })).slice(0, 40);
    const selects = Array.from(document.querySelectorAll('select')).map((select) => ({
      name: String(select.getAttribute('name') || ''),
      aria: String(select.getAttribute('aria-label') || ''),
      options: Array.from(select.options).map((option) => textOf(option)).filter(Boolean).slice(0, 100),
    })).slice(0, 40);
    return {
      title: document.title,
      url: location.href.split('?')[0],
      hash: location.hash,
      headings,
      controls,
      tables,
      selects,
      iframeCount: document.querySelectorAll('iframe').length,
      scriptCount: document.querySelectorAll('script').length,
    };
  });
}


function collectNumericIdsByKey(payload: unknown, keyPattern: RegExp, max = 120): number[] {
  const found = new Set<number>();
  const seen = new WeakSet<object>();

  function visit(node: unknown): void {
    if (found.size >= max || node === null || typeof node !== 'object') return;
    if (seen.has(node as object)) return;
    seen.add(node as object);

    if (Array.isArray(node)) {
      for (const item of node.slice(0, 500)) visit(item);
      return;
    }

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (keyPattern.test(key)) {
        const id = typeof value === 'number' ? value : Number(value);
        if (Number.isInteger(id) && id > 0) found.add(id);
      }
      visit(value);
      if (found.size >= max) break;
    }
  }

  visit(payload);
  return [...found].sort((a, b) => a - b);
}

async function discoverSyonetDashboardSources(config: SyonetRealConfig, page: Page): Promise<void> {
  if (process.env.SYONET_DISCOVER_SCREENS !== 'true') return;

  console.log('🔬 Syonet dashboard source discovery: INICIANDO (GET/HEAD somente)');

  const dashboardEndpoints = [
    '/api/dashboard',
    '/api/dashboard/189',
    '/api/dashboard/162',
    '/api/dashboard/244',
  ];

  const datasetIds = new Set<number>();
  const apiPaths = new Set<string>();

  for (const endpoint of dashboardEndpoints) {
    try {
      const response = await apiRequest(page, endpoint);
      console.log('🔬 Syonet dashboard definition ' + endpoint +
        ' status=' + response.status +
        ' shape=' + summarizeSyonetPayload(response.data));

      for (const id of collectNumericIdsByKey(response.data, /^idDataset$/i)) datasetIds.add(id);
      for (const path of collectSyonetApiPaths(response.data)) apiPaths.add(path);

      if (response.data && typeof response.data === 'object') {
        const data = response.data as any;
        console.log('🔬 Syonet dashboard query hints ' + endpoint + ': ' + JSON.stringify({
          query: summarizeDatasetQuery(data.query),
          dataSource: summarizeDatasetQuery(data.dataSource),
        }));
      }
    } catch (error) {
      console.log('🔬 Syonet dashboard definition ' + endpoint + ' erro=consulta');
    }
  }

  for (const id of datasetIds) {
    try {
      const response = await apiRequest(page, '/api/dataset/' + id);
      console.log('🔬 Syonet dataset definition /api/dataset/' + id +
        ' status=' + response.status +
        ' shape=' + summarizeSyonetPayload(response.data));

      const data = response.data as any;
      if (data && typeof data === 'object') {
        console.log('🔬 Syonet dataset query /api/dataset/' + id + ': ' +
          JSON.stringify(summarizeDatasetQuery(data.query)));
        console.log('🔬 Syonet dataset dataSource /api/dataset/' + id + ': ' +
          JSON.stringify(summarizeDatasetQuery(data.dataSource)));
      }

      for (const path of collectSyonetApiPaths(response.data)) apiPaths.add(path);
    } catch {
      console.log('🔬 Syonet dataset definition /api/dataset/' + id + ' erro=consulta');
    }
  }

  // Consulta apenas as rotas explicitamente reveladas pelas próprias definições.
  // Não inventamos novos endpoints aqui.
  for (const path of [...apiPaths].slice(0, 120)) {
    if (!path.startsWith('/api/')) continue;
    try {
      const response = await apiRequest(page, path);
      console.log('🔬 Syonet discovered API ' + path +
        ' status=' + response.status +
        ' shape=' + summarizeSyonetPayload(response.data));
    } catch {
      console.log('🔬 Syonet discovered API ' + path + ' erro=consulta');
    }
  }

  console.log('🔬 Syonet dashboard source discovery: FIM datasets=' +
    JSON.stringify([...datasetIds].sort((a, b) => a - b)) +
    ' apiPaths=' + JSON.stringify([...apiPaths].slice(0, 120)));
}

async function discoverSyonetScreens(config: SyonetRealConfig, page: Page): Promise<void> {
  if (process.env.SYONET_DISCOVER_SCREENS !== 'true') return;

  console.log('🔬 Syonet screen discovery: INICIANDO (somente leitura)');

  const requests = new Map<string, {
    methods: Set<string>;
    statuses: Set<number>;
    queryKeys: Set<string>;
    contentTypes: Set<string>;
    samples: number;
  }>();

  const recordRequest = (request: any) => {
    try {
      const url = new URL(request.url());
      if (url.origin !== new URL(config.baseUrl).origin || !url.pathname.startsWith('/api/')) return;
      const path = url.pathname;
      const current = requests.get(path) || {
        methods: new Set<string>(),
        statuses: new Set<number>(),
        queryKeys: new Set<string>(),
        contentTypes: new Set<string>(),
        samples: 0,
      };
      current.methods.add(String(request.method() || 'GET').toUpperCase());
      url.searchParams.forEach((_value, key) => current.queryKeys.add(key));
      current.samples++;
      requests.set(path, current);
    } catch {}
  };

  const recordResponse = async (response: any) => {
    try {
      const url = new URL(response.url());
      if (url.origin !== new URL(config.baseUrl).origin || !url.pathname.startsWith('/api/')) return;
      const path = url.pathname;
      const current = requests.get(path) || {
        methods: new Set<string>(),
        statuses: new Set<number>(),
        queryKeys: new Set<string>(),
        contentTypes: new Set<string>(),
        samples: 0,
      };
      current.statuses.add(Number(response.status()));
      const contentType = String(response.headers()['content-type'] || '').split(';')[0];
      if (contentType) current.contentTypes.add(contentType);
      if (contentType.includes('json')) {
        try {
          const bodyText = await response.text();
          if (bodyText.length <= 300000) {
            try {
              const body = JSON.parse(bodyText);
              console.log('🔬 Syonet screen response ' + path + ': ' + summarizeSyonetPayload(body));
            } catch {}
          }
        } catch {}
      }
      requests.set(path, current);
    } catch {}
  };

  page.on('request', recordRequest);
  page.on('response', recordResponse);

  try {
    console.log('🔬 Syonet navigation inventory: ' + JSON.stringify(await captureScreenDom(page)));

    for (const target of SYONET_SCREEN_TARGETS) {
      if (page.isClosed()) break;
      try {
      let clicked = await clickUiLabel(page, target.labels);

      if (!clicked.clicked) {
        await clickUiLabel(page, ['Gestão', 'GESTÃO']);
        await page.waitForTimeout(1500);
        clicked = await clickUiLabel(page, target.labels);
      }

      if (!clicked.clicked) {
        await clickUiLabel(page, ['Dashboard', 'DASHBOARD']);
        await page.waitForTimeout(1000);
        await clickUiLabel(page, ['Gestão', 'GESTÃO']);
        await page.waitForTimeout(1500);
        clicked = await clickUiLabel(page, target.labels);
      }

      if (!clicked.clicked) {
        console.log('🔬 Syonet screen NOT_FOUND ' + target.key + ': ' + JSON.stringify({
          requestedLabels: target.labels,
          current: await captureScreenDom(page),
        }));
        continue;
      }

      await page.waitForTimeout(12000);
      const screen = await captureScreenDom(page);
      const apiSummary = [...requests.entries()].map(([path, item]) => ({
        path,
        methods: [...item.methods],
        statuses: [...item.statuses],
        queryKeys: [...item.queryKeys],
        contentTypes: [...item.contentTypes],
        samples: item.samples,
      }));

      console.log('🔬 Syonet screen FOUND ' + target.key + ': ' + JSON.stringify({
        clickedLabel: clicked.label,
        clickedText: clicked.text,
        screen,
        apiSummary,
      }));

        try {
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(2500);
        } catch {}
      } catch (error) {
        console.log('🔬 Syonet screen ERROR ' + target.key + ': page-state-unavailable');
        if (page.isClosed()) break;
      }
    }
  } catch {
    console.log('🔬 Syonet screen discovery: erro-global-controlado');
  } finally {
    page.off('request', recordRequest);
    page.off('response', recordResponse);
    console.log('🔬 Syonet screen discovery: FIM');
  }
}

/**
 * Extrai dados da tela de Funil/Gestão (Tela 1)
 *
 * Usa a API REST para obter métricas do funil de vendas
 * Dashboard ID 189: Incluidos / Agendados / Comparecidos / Vendas
 */
export async function extractFunilData(config: SyonetRealConfig, filters?: {
  empresaIds?: number[];
  dataInicio?: string;
  dataFim?: string;
}): Promise<FunilMetrics[]> {
  // Usar sessão em cache se disponível
  if (!isSessionValid()) {
    const logged = await syonetLogin(config);
    if (!logged) throw new Error('Falha ao autenticar no Syonet');
  }

  const page = pageInstance!;
  const metrics: FunilMetrics[] = [];

  try {
    if (process.env.SYONET_DISCOVER_UI === 'true') {
      try {
        const observed = new Set<string>();
        const onRequest = (req: any) => {
          try {
            const url = req.url();
            if (url.startsWith(config.baseUrl) && url.includes('/api/')) {
              observed.add(req.method() + ' ' + new URL(url).pathname + new URL(url).search);
            }
          } catch {}
        };
        page.on('request', onRequest);
        for (const route of [
          config.baseUrl + '/portal/acessaSistema.do#/dashboard/189',
          config.baseUrl + '/portal/acessaSistema.do#/dashboard.do?id=189',
        ]) {
          try {
            await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(10000);
          } catch {}
          if ([...observed].some((x) => /dataset|query|execute|dashboard/i.test(x))) break;
        }
        page.off('request', onRequest);
        const uiHints = await page.evaluate(() => {
          const hash = window.location.hash;
          const resources = performance.getEntriesByType('resource')
            .map((entry: any) => ({
              name: String(entry.name),
              initiatorType: String(entry.initiatorType || ''),
              duration: Number(entry.duration || 0),
            }))
            .filter((entry) => entry.name.includes('/api/'))
            .slice(-300);
          const links = Array.from(document.querySelectorAll('a,button,[role="link"]'))
            .map((el: any) => ({
              text: String(el.innerText || el.textContent || '').trim().slice(0, 120),
              href: String(el.getAttribute('href') || '').slice(0, 300),
              route: String(el.getAttribute('data-route') || el.getAttribute('data-path') || '').slice(0, 300),
            }))
            .filter((x) => /dashboard|painel|kpi/i.test(x.text + ' ' + x.href + ' ' + x.route))
            .slice(0, 100);
          return { hash, links, resources };
        });
        console.log('🔎 Syonet UI dashboard hints: ' + JSON.stringify(uiHints));
        console.log('🔎 Syonet UI dashboard requests: ' + JSON.stringify([...observed].slice(0, 200)));
      } catch {
        console.warn('⚠️ Falha ao descobrir chamadas do dashboard pela UI');
      }
    }

    console.log('📊 Syonet: Extraindo métricas do Funil via API...');

    // A lista de empresas deve vir do proprio Syonet. O fallback fixo anterior
    // podia omitir lojas novas ou consultar lojas fora do escopo da conta.
    const empresasMap = new Map<number, { nome: string; apelido: string; ativo: boolean }>();
    let empresasAtivas: number[] = [];

    try {
      const empresasResponse = await apiRequest(page, '/api/empresa');
      if (empresasResponse.status === 200 && empresasResponse.data) {
        const empresasList: any[] = Array.isArray(empresasResponse.data)
          ? empresasResponse.data
          : empresasResponse.data.content || [];

        for (const emp of empresasList) {
          const id = Number(emp.idEmpresa ?? emp.id);
          if (!Number.isInteger(id)) continue;
          empresasMap.set(id, {
            nome: emp.nome || emp.apelido || `Empresa ${id}`,
            apelido: emp.apelido || emp.nome || `Emp ${id}`,
            ativo: emp.ativo !== false,
          });
        }

        const mappedIds = new Set(Object.values(STORE_MAPPING)
          .map(v => v.syonetId)
          .filter((id): id is number => Number.isInteger(id)));

        empresasAtivas = [...empresasMap.entries()]
          .filter(([id, emp]) => emp.ativo && mappedIds.has(id) && CRM_PRODUCTION_SYONET_STORE_IDS.has(id))
          .map(([id]) => id)
          .sort((a, b) => a - b);

        console.log(`✅ Mapeadas ${empresasMap.size} empresas; ${empresasAtivas.length} lojas Eurovia no escopo`);
      }
    } catch (err) {
      console.warn('⚠️ Erro ao obter lista de empresas:', err);
    }

    const targetEmpresaIds = filters?.empresaIds
      ?? (empresasAtivas.length > 0
        ? empresasAtivas
        : Object.values(STORE_MAPPING)
            .map(v => v.syonetId)
            .filter((id): id is number => Number.isInteger(id))
            .filter(id => CRM_PRODUCTION_SYONET_STORE_IDS.has(id)));

    // Para cada empresa de interesse, extrair métricas do dashboard 189
    for (const empresaId of targetEmpresaIds) {
      try {
        console.log(`📍 Processando empresa ID ${empresaId}...`);

        // O endpoint /api/dashboard/189 é uma definição de dashboard. A tentativa
        // anterior adicionava filtros na URL e podia ficar pendurada no Syonet.
        // Primeiro consultamos a fonte direta do funil; só usamos a definição
        // do dashboard como fallback, sempre em GET.
        const funilParams = new URLSearchParams({ empresa: String(empresaId) });
        if (filters?.dataInicio) funilParams.set('dataInicio', filters.dataInicio);
        if (filters?.dataFim) funilParams.set('dataFim', filters.dataFim);

        let dashboardResponse: any = await apiRequest(page, `/api/funil?${funilParams.toString()}`);
        let directFunnelMetrics = dashboardResponse.status === 200 && dashboardResponse.data
          ? extractFunnelMetricsRobust(dashboardResponse.data)
          : {};

        console.log(`🔎 Syonet funil empresa ${empresaId} status=${dashboardResponse.status} shape=${summarizeSyonetPayload(dashboardResponse.data)}`);

        if (Object.keys(directFunnelMetrics).length === 0) {
          dashboardResponse = await apiRequest(page, '/api/dashboard/189');
          console.log(`🔎 Syonet dashboard 189 definição status=${dashboardResponse.status} shape=${summarizeSyonetPayload(dashboardResponse.data)}`);
        }

        if (dashboardResponse.status !== 200 && Object.keys(directFunnelMetrics).length === 0) {
          console.warn(`⚠️ Fontes do Funil indisponíveis para empresa ${empresaId}: status=${dashboardResponse.status}`);
          continue;
        }

        const empresaInfo = empresasMap.get(empresaId) || { apelido: `Empresa ${empresaId}` };
        const metric: FunilMetrics = {
          storeId: `syonet_${empresaId}`,
          storeName: empresaInfo.apelido,
          date: new Date(),
          leadsTotal: 0,
          leadsByMedia: {},
          appointmentsTotal: 0,
          appointmentsConfirmed: 0,
          flowTotal: 0,
          salesTotal: 0,
          leadsByVl: {},
          leadsByVs: {},
        };

        // O endpoint /api/dashboard/{id} retorna a definição do dashboard (datasets/widgets),
        // não o resultado calculado. O resultado é obtido por uma chamada separada do frontend.
        // Descobrimos essa rota por GET somente; nenhum método de escrita é permitido pelo guard.
        let dashboardDataResponse: any = null;
        if (empresaId === targetEmpresaIds[0]) {
          const dateStart = filters?.dataInicio;
          const dateEnd = filters?.dataFim;
          const queryVariants = [
            { key: 'empresa', value: String(empresaId) },
            { key: 'idEmpresa', value: String(empresaId) },
          ];
          const definitionCandidates = ['/api/dataset/664', '/api/dataset/665', '/api/dataset/678'];
          for (const candidate of definitionCandidates) {
            try {
              const definition = await apiRequest(page, candidate);
              const definitionData = definition.data as any;
              console.log('🔎 Syonet dataset definition ' + candidate + ' status=' + definition.status +
                ' shape=' + summarizeSyonetPayload(definition.data));
              console.log('🔎 Syonet dataset query ' + candidate + ': ' + JSON.stringify(summarizeDatasetQuery(definitionData?.query)));
              console.log('🔎 Syonet dataset dataSource ' + candidate + ': ' + JSON.stringify(summarizeDatasetQuery(definitionData?.dataSource)));
            } catch {
              console.log('🔎 Syonet dataset definition ' + candidate + ' erro=consulta');
            }
          }

          const candidates = [
            '/api/dashboard/189/dados',
            '/api/dashboard/189/data',
            '/api/dashboard/189/result',
            '/api/funil',
          ];
          for (const candidate of candidates) {
            for (const variant of queryVariants) {
              const params = new URLSearchParams({ [variant.key]: variant.value });
              if (dateStart) params.set('dataInicio', dateStart);
              if (dateEnd) params.set('dataFim', dateEnd);
              try {
                const probe = await apiRequest(page, candidate + '?' + params.toString());
                const safe = summarizeSyonetPayload(probe.data);
                console.log('🔎 Syonet dashboard-data probe ' + candidate +
                  ' ' + variant.key + ' status=' + probe.status + ' shape=' + safe);
                if (probe.status === 200 && probe.data) {
                  const robustProbe = extractFunnelMetricsRobust(probe.data);
                  if (Object.keys(robustProbe).length > 0) {
                    dashboardDataResponse = probe.data;
                    break;
                  }
                }
              } catch (err) {
                console.log('🔎 Syonet dashboard-data probe ' + candidate +
                  ' ' + variant.key + ' erro=consulta');
              }
            }
            if (dashboardDataResponse) break;
          }
        }

        // Processar dados do dashboard
        if (dashboardResponse.data) {
          const data = dashboardResponse.data;

          // Diagnóstico sanitizado: somente estrutura, nomes de métricas e números.
          // Nunca registra PII, payload bruto, cookies ou credenciais.
          if (empresaId === targetEmpresaIds[0]) {
            console.log('🔎 Syonet dashboard 189 shape: ' + summarizeSyonetPayload(data));
          }

          // Extração robusta para respostas aninhadas/wrappers do Syonet.
          const robust = {
            ...directFunnelMetrics,
            ...extractFunnelMetricsRobust(data),
          };
          if (robust.leadsTotal !== undefined) metric.leadsTotal = robust.leadsTotal;
          if (robust.appointmentsTotal !== undefined) metric.appointmentsTotal = robust.appointmentsTotal;
          if (robust.appointmentsConfirmed !== undefined) metric.appointmentsConfirmed = robust.appointmentsConfirmed;
          if (robust.flowTotal !== undefined) metric.flowTotal = robust.flowTotal;
          if (robust.salesTotal !== undefined) metric.salesTotal = robust.salesTotal;

          if (dashboardDataResponse) {
            const discovered = extractFunnelMetricsRobust(dashboardDataResponse);
            if (discovered.leadsTotal !== undefined) metric.leadsTotal = discovered.leadsTotal;
            if (discovered.appointmentsTotal !== undefined) metric.appointmentsTotal = discovered.appointmentsTotal;
            if (discovered.appointmentsConfirmed !== undefined) metric.appointmentsConfirmed = discovered.appointmentsConfirmed;
            if (discovered.flowTotal !== undefined) metric.flowTotal = discovered.flowTotal;
            if (discovered.salesTotal !== undefined) metric.salesTotal = discovered.salesTotal;
          }

          // Extrair KPIs do dashboard
          // Estrutura típica: { kpis: [...], components: [...] }
          if (data.kpis) {
            for (const kpi of data.kpis) {
              const valor = parseInt(kpi.valor) || 0;
              const nome = (kpi.nome || kpi.label || '').toLowerCase();

              if (nome.includes('incluido') || nome.includes('lead') || nome.includes('recebido')) {
                metric.leadsTotal = valor;
              } else if (nome.includes('agendado')) {
                metric.appointmentsTotal = valor;
              } else if (nome.includes('comparecid') || nome.includes('fluxo') || nome.includes('flow')) {
                metric.flowTotal = valor;
              } else if (nome.includes('venda') || nome.includes('vendido')) {
                metric.salesTotal = valor;
              }
            }
          }

          // Processar componentes do dashboard
          if (data.componentes) {
            for (const comp of data.componentes) {
              if (comp.tipo === 'kpi') {
                const valor = parseInt(comp.valor) || 0;
                const label = (comp.label || comp.titulo || '').toLowerCase();

                if (label.includes('incluido')) metric.leadsTotal = valor;
                else if (label.includes('agendado')) metric.appointmentsTotal = valor;
                else if (label.includes('confirmado')) metric.appointmentsConfirmed = valor;
                else if (label.includes('comparecid') || label.includes('fluxo')) metric.flowTotal = valor;
                else if (label.includes('venda')) metric.salesTotal = valor;
              }

              // Processar tabela de leads por mídia
              if (comp.tipo === 'table' && comp.dados) {
                const dados: any[] = Array.isArray(comp.dados) ? comp.dados : [];
                for (const row of dados) {
                  const midia = row.midia || row.nomeMidia || row.source;
                  const count = parseInt(row.total) || parseInt(row.qtd) || parseInt(row.count) || 0;
                  if (midia && count > 0) {
                    metric.leadsByMedia[midia] = (metric.leadsByMedia[midia] || 0) + count;
                  }
                }
              }
            }
          }

          // Tentar extrair do payload direto
          if (data.totalLeads !== undefined) metric.leadsTotal = parseInt(data.totalLeads) || 0;
          if (data.totalAgendamentos !== undefined) metric.appointmentsTotal = parseInt(data.totalAgendamentos) || 0;
          if (data.totalConfirmados !== undefined) metric.appointmentsConfirmed = parseInt(data.totalConfirmados) || 0;
          if (data.totalFluxo !== undefined) metric.flowTotal = parseInt(data.totalFluxo) || 0;
          if (data.totalVendas !== undefined) metric.salesTotal = parseInt(data.totalVendas) || 0;

          // Processar breakdown por mídia se disponível
          if (data.porMidia) {
            for (const [midia, count] of Object.entries(data.porMidia)) {
              metric.leadsByMedia[midia] = parseInt(count as string) || 0;
            }
          }

          if (data.leadsPorMidia) {
            for (const item of data.leadsPorMidia) {
              const midia = item.midia || item.nome;
              const count = parseInt(item.total) || parseInt(item.qtd) || 0;
              if (midia) {
                metric.leadsByMedia[midia] = (metric.leadsByMedia[midia] || 0) + count;
              }
            }
          }
        }

        // Se não conseguimos dados do dashboard, tentar endpoint de funil direto
        if (metric.leadsTotal === 0 && metric.appointmentsTotal === 0) {
          try {
            const funilParams = new URLSearchParams({ empresa: String(empresaId) });
            if (filters?.dataInicio) funilParams.set('dataInicio', filters.dataInicio);
            if (filters?.dataFim) funilParams.set('dataFim', filters.dataFim);
            const funilResponse = await apiRequest(page, `/api/funil?${funilParams.toString()}`);
            if (funilResponse.status === 200 && funilResponse.data) {
              const funilData = funilResponse.data;

              // Extrair métricas do funil
              metric.leadsTotal = parseInt(funilData.leads) || parseInt(funilData.totalLeads) || 0;
              metric.appointmentsTotal = parseInt(funilData.agendamentos) || parseInt(funilData.totalAgendamentos) || 0;
              metric.appointmentsConfirmed = parseInt(funilData.confirmados) || 0;
              metric.flowTotal = parseInt(funilData.comparecidos) || parseInt(funilData.fluxo) || 0;
              metric.salesTotal = parseInt(funilData.vendas) || parseInt(funilData.totalVendas) || 0;

              // Processar breakdown por mídia
              if (funilData.porMidia) {
                metric.leadsByMedia = { ...funilData.porMidia };
              }
            }
          } catch (err) {
            console.warn(`⚠️ Erro ao buscar funil direto para empresa ${empresaId}:`, err);
          }
        }

        // Se ainda não temos dados, usar o nome da empresa do mapeamento
        if (metric.storeName === `Empresa ${empresaId}`) {
          const mapped = Object.entries(STORE_MAPPING).find(
            ([, v]) => v.syonetId === empresaId
          );
          if (mapped) {
            metric.storeName = mapped[0];
          }
        }

        metrics.push(metric);
        console.log(`✅ Empresa ${empresaId} (${metric.storeName}): leads=${metric.leadsTotal}, ag=${metric.appointmentsTotal}, fluxo=${metric.flowTotal}, vendas=${metric.salesTotal}`);

      } catch (err) {
        console.warn(`⚠️ Erro ao processar empresa ${empresaId}:`, err);
      }
    }

    console.log(`✅ Syonet: ${metrics.length} registros de funil extraídos`);
  } catch (error) {
    console.error('❌ Syonet: Erro ao extrair funil:', error);
    throw error;
  }

  return metrics;
}

/**
 * Extrai dados de produtividade da Tela 2
 * Dashboard ID 162: Produtividade Resultado
 */
export async function extractProductivityData(
  config: SyonetRealConfig,
  vlName?: string
): Promise<ProductivityMetrics[]> {
  // Usar sessão em cache se disponível
  if (!isSessionValid()) {
    const logged = await syonetLogin(config);
    if (!logged) throw new Error('Falha ao autenticar no Syonet');
  }

  const page = pageInstance!;
  const metrics: ProductivityMetrics[] = [];

  try {
    console.log('📊 Syonet: Extraindo métricas de Produtividade via API...');

    // Primeiro, obter lista de usuários VL
    const usuariosMap = new Map<string, { nome: string; idEmpresa: number; tipo: string }>();

    try {
      const usuariosResponse = await apiRequest(page, '/api/usuario');
      if (usuariosResponse.status === 200 && usuariosResponse.data) {
        const usuariosList: any[] = Array.isArray(usuariosResponse.data)
          ? usuariosResponse.data
          : usuariosResponse.data.content || [];

        for (const user of usuariosList) {
          // Filtrar usuários VL (consultores de atendimento)
          const tipo = (user.idTipo || user.tipo || '').toUpperCase();
          const nome = user.nome || user.username || user.login || '';

          if (
            tipo.includes('VL') ||
            tipo.includes('CONSULTOR') ||
            tipo.includes('BDC') ||
            nome.toUpperCase().includes('VL')
          ) {
            usuariosMap.set(user.idUsuario?.toString() || user.id?.toString(), {
              nome,
              idEmpresa: user.idEmpresa || user.empresaId || 0,
              tipo,
            });
          }
        }
        console.log(`✅ Encontrados ${usuariosMap.size} consultores VL`);
      }
    } catch (err) {
      console.warn('⚠️ Erro ao obter lista de usuários:', err);
    }

    // Obter métricas do dashboard 162 (Produtividade BDC)
    let dashboardResponse;
    try {
      dashboardResponse = await apiRequest(page, '/api/dashboard/162');
    } catch {
      // Tentar dashboard alternativo 244 (Funil de Vendas)
      try {
        dashboardResponse = await apiRequest(page, '/api/dashboard/244');
      } catch (err) {
        console.warn('⚠️ Erro ao obter dashboards de produtividade:', err);
      }
    }

    if (dashboardResponse?.status === 200 && dashboardResponse?.data) {
      const data = dashboardResponse.data;

      // Processar componentes do dashboard
      if (data.componentes) {
        for (const comp of data.componentes) {
          if (comp.tipo === 'kpi' && comp.dados) {
            const dados: any[] = Array.isArray(comp.dados) ? comp.dados : [];

            for (const row of dados) {
              const vlUserId = row.idUsuario?.toString() || row.id?.toString();
              const vlUserName = row.nomeUsuario || row.usuario || vlUserId || '';
              const storeId = `syonet_${row.idEmpresa || row.empresaId || 0}`;

              // Se filtrou por VL, pular os outros
              if (vlName && !vlUserName.toLowerCase().includes(vlName.toLowerCase())) {
                continue;
              }

              // Verificar se já existe métrica para este VL
              let existingMetric = metrics.find(m => m.vlUserId === vlUserId);

              if (!existingMetric) {
                existingMetric = {
                  vlUserId,
                  vlUserName,
                  storeId,
                  date: new Date(),
                  leadsWaiting: 0,
                  leadsLate: 0,
                  leadsPendingToday: 0,
                  leadsFuture: 0,
                  leadsTotal: 0,
                  appointmentsToday: 0,
                  appointmentsConfirmed: 0,
                  salesSuccess: 0,
                  priorityClients: 0,
                  forwardedToVs: 0,
                };
                metrics.push(existingMetric);
              }

              // Extrair valores
              const label = (row.label || row.nome || '').toLowerCase();
              const valor = parseInt(row.valor) || parseInt(row.total) || 0;

              if (label.includes('aguardando') || label.includes('waiting')) {
                existingMetric.leadsWaiting = valor;
              } else if (label.includes('atrasad') || label.includes('late')) {
                existingMetric.leadsLate = valor;
              } else if (label.includes('pendente') || label.includes('pending')) {
                existingMetric.leadsPendingToday = valor;
              } else if (label.includes('futuro') || label.includes('future')) {
                existingMetric.leadsFuture = valor;
              } else if (label.includes('lead')) {
                existingMetric.leadsTotal = valor;
              } else if (label.includes('agendado') || label.includes('agenda')) {
                existingMetric.appointmentsToday = valor;
              } else if (label.includes('confirmad')) {
                existingMetric.appointmentsConfirmed = valor;
              } else if (label.includes('venda') || label.includes('vendido')) {
                existingMetric.salesSuccess = valor;
              } else if (label.includes('prioridade') || label.includes('priority')) {
                existingMetric.priorityClients = valor;
              } else if (label.includes('encaminhad') || label.includes('forward')) {
                existingMetric.forwardedToVs = valor;
              }
            }
          }

          // Processar tabela de produtividade
          if (comp.tipo === 'table' && comp.dados) {
            const dados: any[] = Array.isArray(comp.dados) ? comp.dados : [];

            for (const row of dados) {
              const vlUserId = row.idUsuario?.toString() || row.id?.toString();
              const vlUserName = row.nomeUsuario || row.usuario || vlUserId || '';
              const storeId = `syonet_${row.idEmpresa || row.empresaId || 0}`;

              if (vlName && !vlUserName.toLowerCase().includes(vlName.toLowerCase())) {
                continue;
              }

              let existingMetric = metrics.find(m => m.vlUserId === vlUserId);

              if (!existingMetric) {
                existingMetric = {
                  vlUserId,
                  vlUserName,
                  storeId,
                  date: new Date(),
                  leadsWaiting: 0,
                  leadsLate: 0,
                  leadsPendingToday: 0,
                  leadsFuture: 0,
                  leadsTotal: 0,
                  appointmentsToday: 0,
                  appointmentsConfirmed: 0,
                  salesSuccess: 0,
                  priorityClients: 0,
                  forwardedToVs: 0,
                };
                metrics.push(existingMetric);
              }

              // Extrair do payload da linha
              existingMetric.leadsWaiting = parseInt(row.aguardando) || existingMetric.leadsWaiting;
              existingMetric.leadsLate = parseInt(row.atrasados) || parseInt(row.atrasado) || existingMetric.leadsLate;
              existingMetric.leadsPendingToday = parseInt(row.pendentesDia) || parseInt(row.pendente) || existingMetric.leadsPendingToday;
              existingMetric.leadsFuture = parseInt(row.futuros) || existingMetric.leadsFuture;
              existingMetric.leadsTotal = parseInt(row.totalLeads) || parseInt(row.leads) || existingMetric.leadsTotal;
              existingMetric.appointmentsToday = parseInt(row.agendamentos) || existingMetric.appointmentsToday;
              existingMetric.appointmentsConfirmed = parseInt(row.confirmados) || existingMetric.appointmentsConfirmed;
              existingMetric.salesSuccess = parseInt(row.vendas) || parseInt(row.vendido) || existingMetric.salesSuccess;
              existingMetric.priorityClients = parseInt(row.prioridade) || existingMetric.priorityClients;
              existingMetric.forwardedToVs = parseInt(row.encaminhados) || existingMetric.forwardedToVs;
            }
          }
        }
      }

      // Tentar extrair do payload direto
      if (data.usuarios && Array.isArray(data.usuarios)) {
        for (const user of data.usuarios) {
          const vlUserId = user.idUsuario?.toString() || user.id?.toString();
          const vlUserName = user.nome || vlUserId;

          if (vlName && !vlUserName.toLowerCase().includes(vlName.toLowerCase())) {
            continue;
          }

          let existingMetric = metrics.find(m => m.vlUserId === vlUserId);

          if (!existingMetric) {
            existingMetric = {
              vlUserId,
              vlUserName,
              storeId: `syonet_${user.idEmpresa || 0}`,
              date: new Date(),
              leadsWaiting: parseInt(user.aguardando) || 0,
              leadsLate: parseInt(user.atrasados) || 0,
              leadsPendingToday: parseInt(user.pendentesDia) || 0,
              leadsFuture: parseInt(user.futuros) || 0,
              leadsTotal: parseInt(user.totalLeads) || parseInt(user.leads) || 0,
              appointmentsToday: parseInt(user.agendamentos) || 0,
              appointmentsConfirmed: parseInt(user.confirmados) || 0,
              salesSuccess: parseInt(user.vendas) || 0,
              priorityClients: parseInt(user.prioridade) || 0,
              forwardedToVs: parseInt(user.encaminhados) || 0,
            };
            metrics.push(existingMetric);
          }
        }
      }
    }

    // Se não conseguimos dados dos dashboards, tentar endpoint direto
    if (metrics.length === 0) {
      console.log('⚠️ Nenhum dado de produtividade encontrado nos dashboards, tentando fontes alternativas...');

      // Tentar API de produtividade direta
      try {
        const prodResponse = await apiRequest(page, '/api/produtividade');
        if (prodResponse.status === 200 && prodResponse.data) {
          const prodData = prodResponse.data;
          const items: any[] = Array.isArray(prodData) ? prodData : (prodData.usuarios || prodData.dados || []);

          for (const item of items) {
            const vlUserId = item.idUsuario?.toString() || item.id?.toString();
            const vlUserName = item.nomeUsuario || item.usuario || vlUserId;

            if (vlName && !vlUserName.toLowerCase().includes(vlName.toLowerCase())) {
              continue;
            }

            metrics.push({
              vlUserId,
              vlUserName,
              storeId: `syonet_${item.idEmpresa || 0}`,
              date: new Date(),
              leadsWaiting: parseInt(item.aguardando) || 0,
              leadsLate: parseInt(item.atrasados) || 0,
              leadsPendingToday: parseInt(item.pendentesDia) || 0,
              leadsFuture: parseInt(item.futuros) || 0,
              leadsTotal: parseInt(item.totalLeads) || 0,
              appointmentsToday: parseInt(item.agendamentos) || 0,
              appointmentsConfirmed: parseInt(item.confirmados) || 0,
              salesSuccess: parseInt(item.vendas) || 0,
              priorityClients: parseInt(item.prioridade) || 0,
              forwardedToVs: parseInt(item.encaminhados) || 0,
            });
          }
        }
      } catch (err) {
        console.warn('⚠️ Erro ao buscar produtividade direta:', err);
      }
    }

    console.log(`✅ Syonet: ${metrics.length} registros de produtividade extraídos`);
    for (const m of metrics.slice(0, 5)) {
      console.log(`   VL: ${m.vlUserName} - leads=${m.leadsTotal}, ag=${m.appointmentsToday}, vendas=${m.salesSuccess}`);
    }
    if (metrics.length > 5) {
      console.log(`   ... e mais ${metrics.length - 5} registros`);
    }

  } catch (error) {
    console.error('❌ Syonet: Erro ao extrair produtividade:', error);
    throw error;
  }

  return metrics;
}

/**
 * Extrai leads individuais da API
 *
 * ATUALIZADO: O endpoint correto é /api/evento?idEmpresa={id}
 */
export async function extractLeadsData(
  config: SyonetRealConfig,
  dateRange?: { start: Date; end: Date }
): Promise<LeadData[]> {
  // Usar sessão em cache se disponível
  if (!isSessionValid()) {
    const logged = await syonetLogin(config);
    if (!logged) throw new Error('Falha ao autenticar no Syonet');
  }

  const page = pageInstance!;
  const leads: LeadData[] = [];

  try {
    console.log('📊 Syonet: Extraindo leads via API...');


    // Primeiro, obter a lista real de empresas. Nenhum cadastro e alterado.
    let empresaIds: number[] = [];
    const empresaNames = new Map<number, string>();
    try {
      const empresasResponse = await apiRequest(page, '/api/empresa');
      if (empresasResponse.status === 200 && empresasResponse.data) {
        const empresas: any[] = Array.isArray(empresasResponse.data)
          ? empresasResponse.data
          : empresasResponse.data.content || [];

        const mappedIds = new Set(Object.values(STORE_MAPPING)
          .map(v => v.syonetId)
          .filter((id): id is number => Number.isInteger(id)));

        for (const empresa of empresas) {
          const id = Number(empresa.idEmpresa ?? empresa.id);
          if (!Number.isInteger(id) || empresa.ativo === false || !mappedIds.has(id) || !CRM_PRODUCTION_SYONET_STORE_IDS.has(id)) continue;
          empresaIds.push(id);
          empresaNames.set(id, empresa.nome || empresa.apelido || ('Empresa ' + id));
        }
        empresaIds.sort((a, b) => a - b);
        console.log('   Empresas Eurovia ativas no Syonet: ' + empresaIds.length);
      }
    } catch (err) {
      console.warn('Erro ao obter empresas:', err);
    }

    if (empresaIds.length === 0) {
      empresaIds = Object.values(STORE_MAPPING)
        .map(v => v.syonetId)
        .filter((id): id is number => Number.isInteger(id))
        .filter(id => CRM_PRODUCTION_SYONET_STORE_IDS.has(id));
      for (const mapping of Object.values(STORE_MAPPING)) {
        if (mapping.syonetId && !empresaNames.has(mapping.syonetId)) {
          empresaNames.set(mapping.syonetId, mapping.syonetName);
        }
      }
    }

    const storeNameBySyonetId = new Map<number, string>(
      Object.entries(STORE_MAPPING)
        .filter(([, mapping]) => Number.isInteger(mapping.syonetId))
        .map(([storeName, mapping]) => [mapping.syonetId as number, storeName])
    );

    // Buscar eventos de cada empresa com paginacao completa. Todas as chamadas
    // passam pelo guard imutavel e sao exclusivamente GET.
    const PAGE_SIZE = 100;
    const MAX_PAGES_PER_STORE = 100;

    for (const empresaId of empresaIds) {
      try {
        for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_STORE; pageNumber++) {
          const params = new URLSearchParams({
            idEmpresa: String(empresaId),
            page: String(pageNumber),
            size: String(PAGE_SIZE),
            sort: 'idEvento,desc',
          });
          if (dateRange) {
            params.set('dataInicio', dateRange.start.toISOString().slice(0, 10));
            params.set('dataFim', dateRange.end.toISOString().slice(0, 10));
          }

          const response = await apiRequest(page, '/api/evento?' + params.toString());

          if (pageNumber === 0) {
            console.log('🔎 Syonet /api/evento empresa ' + empresaId + ' status=' + response.status +
              ' shape=' + summarizeSyonetPayload(response.data));
          }

          if (response.status !== 200 || !response.data) break;

          const items: any[] = Array.isArray(response.data)
            ? response.data
            : response.data.content || response.data.items || [];

          if (items.length === 0) break;

          let pageOldestTime = Number.POSITIVE_INFINITY;
          let pageValidDates = 0;
          let pageInvalidDates = 0;
          for (const item of items) {
            const parsed = new Date(item.dataInc || item.dtInc || '');
            const time = parsed.getTime();
            if (Number.isFinite(time)) {
              pageValidDates++;
              pageOldestTime = Math.min(pageOldestTime, time);
            } else {
              pageInvalidDates++;
            }
          }

          const validTimes = items
            .map((item) => new Date(item.dataInc || item.dtInc || 0).getTime())
            .filter(Number.isFinite);
          const pageNewestDate = validTimes.length > 0 ? new Date(Math.max(...validTimes)).toISOString() : null;
          const pageOldestDate = Number.isFinite(pageOldestTime) ? new Date(pageOldestTime).toISOString() : null;
          console.log('   Empresa ' + empresaId + ', pagina ' + pageNumber + ': ' + items.length +
            ' eventos (maisNovo=' + pageNewestDate + ', maisAntigo=' + pageOldestDate +
            ', datasValidas=' + pageValidDates + ', datasInvalidas=' + pageInvalidDates + ')');

          for (const item of items) {
            const resolvedStoreName =
              storeNameBySyonetId.get(Number(item.idEmpresa ?? empresaId)) ||
              empresaNames.get(empresaId) ||
              ('Empresa ' + empresaId);

            const lead: LeadData = {
              id: item.idEvento?.toString() || item.id?.toString() || '',
              storeId: item.idEmpresa?.toString() || empresaId.toString(),
              storeName: resolvedStoreName,
              mediaRaw: item.midia?.dsMidia || item.midia?.label || item.midia || item.dsMidia || 'DESCONHECIDO',
              eventType: item.idTipoEvento || item.tipoEvento || item.grupoEvento || 'OPORTUNIDADE',
              receivedAt: new Date(item.dataInc || item.dtInc || Date.now()),
              status: item.idSituacaoEvento || item.situacaoEvento || item.status || 'AGUARDANDO',
              statusNormalized: normalizeLeadStatus(item.idSituacaoEvento || item.situacaoEvento || item.status || ''),
              priorityFlag: item.encaminhamentoAtivo?.encaminhamentoAtivo || false,
              assignedVlId: item.idUsuarioAtual?.toString() || item.idAgente?.toString(),
              assignedVlName: '',
              assignedVsId: item.veiculo?.vendedor ? item.veiculo.vendedor.split('.')[0] : undefined,
              assignedVsName: item.veiculo?.vendedor || '',
              assignedBdcId: undefined,
              department: item.idGrupoEvento || 'OPORTUNIDADE',
              tipoVenda: item.veiculo?.marca ? 'Seminovos ' + item.veiculo.marca : 'Venda Seminovos',
              vehicleModel: item.veiculo?.modelo,
              vehicleYear: item.veiculo?.anoFabricacao,
              vehicleBrand: item.veiculo?.marca,
            };

            if (!lead.id) continue;

            const mediaNormalized = normalizeMedia(lead.mediaRaw);
            lead.mediaRaw = mediaNormalized.normalized;

            if (dateRange) {
              const leadDate = lead.receivedAt.getTime();
              if (leadDate < dateRange.start.getTime() || leadDate > dateRange.end.getTime()) {
                continue;
              }
            }

            leads.push(lead);
          }

          if (items.length < PAGE_SIZE) break;
          if (dateRange && Number.isFinite(pageOldestTime) && pageOldestTime < dateRange.start.getTime()) {
            break;
          }
        }
      } catch (err) {
        console.warn('Erro ao buscar eventos da empresa ' + empresaId + ':', err);
      }
    }
    console.log(`✅ Total de leads extraídos: ${leads.length}`);
  } catch (error) {
    console.error('❌ Syonet: Erro ao extrair leads:', error);
    throw error;
  }

  return leads;
}

/**
    throw error;
  }

  return leads;
}

/**
 * Encerra a sessão do Syonet e limpa recursos
 */
export async function syonetLogout(): Promise<void> {
  console.log('🔓 Syonet: Encerrando sessão...');

  if (pageInstance && !pageInstance.isClosed()) {
    await pageInstance.close();
    pageInstance = null;
  }

  if (contextInstance) {
    await contextInstance.close();
    contextInstance = null;
  }

  if (browserInstance && browserInstance.isConnected()) {
    await browserInstance.close();
    browserInstance = null;
  }

  isLoggedIn = false;
  sessionCookies = '';
  lastLoginTime = 0;

  console.log('🔓 Syonet: Sessão encerrada e recursos limpos');
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente ${name} não definida`);
  }
  return value;
}

/**
 * Factory: cria cliente Syonet com configuração do ambiente
 */
export function getSyonetRealClient(): {
  config: SyonetRealConfig;
  login: () => Promise<boolean>;
  extractFunil: () => Promise<FunilMetrics[]>;
  extractProductivity: (vlName?: string) => Promise<ProductivityMetrics[]>;
  extractLeads: (dateRange?: { start: Date; end: Date }) => Promise<LeadData[]>;
  logout: () => Promise<void>;
  isAuthenticated: () => boolean;
} {
  const config: SyonetRealConfig = {
    baseUrl: process.env.SYONET_URL || 'https://viasul.syonet.com',
    username: requireEnv('SYONET_USERNAME'),
    password: requireEnv('SYONET_PASSWORD'),
    headless: process.env.SYONET_HEADLESS !== 'false',
  };

  return {
    config,
    login: () => syonetLogin(config),
    extractFunil: () => extractFunilData(config),
    extractProductivity: (vlName) => extractProductivityData(config, vlName),
    extractLeads: (dateRange) => extractLeadsData(config, dateRange),
    logout: syonetLogout,
    isAuthenticated: isSyonetAuthenticated,
  };
}
