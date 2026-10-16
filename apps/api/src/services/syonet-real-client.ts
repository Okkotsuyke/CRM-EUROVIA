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

  const response = await page.evaluate(async (args: { url: string; cookie: string; options: RequestInit }) => {
    const res = await fetch(args.url, {
      ...args.options,
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
  }, { url, cookie: cookies, options }) as { status: number; data: unknown };

  if (response.status === 401 || response.status === 403) {
    throw new Error('Não autenticado na API do Syonet');
  }

  return response as { status: number; data: unknown };
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

    // Ir para página de login
    console.log('📍 Navegando para página de login...');
    await page.goto(`${config.baseUrl}/portal/app.do?modulo=login#/login`, {
      waitUntil: 'domcontentloaded',
      timeout: LOGIN_TIMEOUT,
    });

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
            await page.waitForTimeout(15000);
            console.log('🔎 Syonet dashboard navigation after click: ' + page.url() + ' hash=' + await page.evaluate(() => window.location.hash));
          }
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

          const findings: Array<{ path: string; status: number; length: number; terms: Record<string, number>; apiLiterals: string[]; snippets: string[] }> = [];
          for (const src of scripts) {
            try {
              const response = await page.request.get(src, { timeout: 30000 });
              const text = await response.text();
              const lower = text.toLowerCase();
              const apiLiterals: string[] = [];
              let apiIndex = 0;
              while (apiLiterals.length < 300 && (apiIndex = text.indexOf('/api/', apiIndex)) >= 0) {
                apiLiterals.push(text.slice(Math.max(0, apiIndex - 80), Math.min(text.length, apiIndex + 220)).replace(/\s+/g, ' '));
                apiIndex += 5;
              }
              const terms: Record<string, number> = {};
              for (const term of ['dataset', 'dashboard', 'iddataset', '/api/', 'execute', 'executar', 'consulta', 'query']) {
                terms[term] = lower.split(term.toLowerCase()).length - 1;
              }

              const snippets: string[] = [];
              for (const term of ['dataset', 'dashboard', 'idDataset', '/api/', 'execute', 'executar', 'consulta', 'query']) {
                let from = 0;
                for (let hit = 0; hit < 6; hit++) {
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
                apiLiterals,
                snippets: snippets.slice(0, 80),
              });
            } catch (error) {
              findings.push({
                path: new URL(src).pathname,
                status: 0,
                length: 0,
                terms: {},
                snippets: ['fetch-error'],
              });
            }
          }
          console.log('🔎 Syonet JS resources: ' + JSON.stringify(scripts));
          console.log('🔎 Syonet JS bundle diagnostics: ' + JSON.stringify(findings));
        } catch {
          console.warn('⚠️ Falha ao inspecionar bundles JS do Syonet');
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