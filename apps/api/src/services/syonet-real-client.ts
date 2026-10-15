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
      const executablePath = process.env.SYONET_CHROMIUM_EXECUTABLE_PATH;
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

/**
 * Aguarda inputs aparecerem no DOM (polling para SPAs)
 */
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

    // Verificar se login foi bem-sucedido
    const loginSuccess = !currentUrl.includes('login');

    if (loginSuccess) {
      // Atualizar cookies e marcação de login
      await getSessionCookies();
      isLoggedIn = true;
      lastLoginTime = Date.now();
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

        // Chamar o dashboard 189 (Incluidos / Agendados / Comparecidos / Vendas)
        const dashboardParams = new URLSearchParams({ empresa: String(empresaId) });
        if (filters?.dataInicio) dashboardParams.set('dataInicio', filters.dataInicio);
        if (filters?.dataFim) dashboardParams.set('dataFim', filters.dataFim);
        const dashboardUrl = `/api/dashboard/189?${dashboardParams.toString()}`;
        const dashboardResponse = await apiRequest(page, dashboardUrl);

        if (dashboardResponse.status !== 200) {
          console.warn(`⚠️ Dashboard 189 retornou status ${dashboardResponse.status} para empresa ${empresaId}`);
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

        // Processar dados do dashboard
        if (dashboardResponse.data) {
          const data = dashboardResponse.data;

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
    const PAGE_SIZE = 200;
    const MAX_PAGES_PER_STORE = 100;

    for (const empresaId of empresaIds) {
      try {
        for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_STORE; pageNumber++) {
          const response = await apiRequest(
            page,
            '/api/evento?idEmpresa=' + empresaId + '&page=' + pageNumber + '&size=' + PAGE_SIZE
          );

          if (response.status !== 200 || !response.data) break;

          const items: any[] = Array.isArray(response.data)
            ? response.data
            : response.data.content || response.data.items || [];

          if (items.length === 0) break;

          console.log('   Empresa ' + empresaId + ', pagina ' + pageNumber + ': ' + items.length + ' eventos');

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
