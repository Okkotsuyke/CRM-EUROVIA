/**
 * Syonet Real Client v2 - Cliente melhorado para extração de dados do CRM Syonet
 *
 * ATENÇÃO: Este módulo é apenas para LEITURA de dados do sistema Syonet.
 *
 * Usa Playwright para automação do navegador com configurações otimizadas para SPAs.
 *
 * URLs importantes:
 * - Login: https://viasul.syonet.com/portal/app.do?modulo=login#/login
 * - Home:  https://viasul.syonet.com/portal/acessaSistema.do#/cic.do
 */

import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { installSyonetReadOnlyGuard } from './syonet-readonly-guard';
import {
  normalizeMedia,
  normalizeLeadStatus,
  STORE_MAPPING,
  FunilMetrics,
  ProductivityMetrics,
  LeadData,
} from './syonet-client';

// Timeouts
const DEFAULT_TIMEOUT = 90000;  // 90 segundos para operações de rede
const LOGIN_TIMEOUT = 60000;   // 60 segundos para login

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

// Singleton instance
let browserInstance: Browser | null = null;
let contextInstance: BrowserContext | null = null;
let pageInstance: Page | null = null;
let isLoggedIn = false;
let sessionCookies: string = '';
let lastLoginTime: number = 0;

const SESSION_CACHE_MINUTES = 20;

/**
 * Log colorido para console
 */
function log(level: 'info' | 'success' | 'error' | 'warn', message: string, ...args: any[]) {
  const prefix = {
    info: '🔵',
    success: '✅',
    error: '❌',
    warn: '⚠️',
  }[level];
  console.log(`${prefix} Syonet: ${message}`, ...args);
}

/**
 * Obtém ou cria navegador
 */
async function getBrowser(config: SyonetRealConfig): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    log('info', 'Iniciando navegador Chromium...');

    browserInstance = await chromium.launch({
      headless: config.headless ?? false, // Usar headed por padrão para SPAs
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    log('success', 'Navegador iniciado');
  }
  return browserInstance;
}

/**
 * Cria contexto do navegador
 */
async function getContext(browser: Browser, baseUrl: string): Promise<BrowserContext> {
  if (!contextInstance) {
    contextInstance = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      serviceWorkers: 'block',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    await installSyonetReadOnlyGuard(contextInstance, baseUrl);
  }
  return contextInstance;
}

/**
 * Obtém página
 */
async function getPage(browser: Browser, baseUrl: string): Promise<Page> {
  if (!pageInstance || pageInstance.isClosed()) {
    const context = await getContext(browser, baseUrl);
    pageInstance = await context.newPage();
    pageInstance.setDefaultTimeout(DEFAULT_TIMEOUT);
    pageInstance.setDefaultNavigationTimeout(DEFAULT_TIMEOUT);

    // Interceptar requisições para debug
    pageInstance.on('response', response => {
      if (response.url().includes('/api/')) {
        console.log(`   📡 API: ${response.status()} ${response.url().substring(0, 80)}`);
      }
    });
  }
  return pageInstance;
}

/**
 * Verifica se sessão é válida
 */
function isSessionValid(): boolean {
  if (!isLoggedIn || !pageInstance || pageInstance.isClosed()) {
    return false;
  }
  const sessionAge = Date.now() - lastLoginTime;
  return sessionAge < (SESSION_CACHE_MINUTES * 60 * 1000);
}

/**
 * Extrai cookies da sessão
 */
async function getSessionCookies(): Promise<string> {
  if (!pageInstance) return '';
  const cookies = await pageInstance.context().cookies();
  sessionCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  return sessionCookies;
}

/**
 * FAZ LOGIN NO SYONET
 */
export async function syonetLogin(config: SyonetRealConfig): Promise<boolean> {
  let browser: Browser | null = null;

  try {
    // Verificar cache
    if (isSessionValid()) {
      log('info', 'Usando sessão em cache');
      return true;
    }

    log('info', `Iniciando login como ${config.username}...`);

    // Fechar sessões anteriores
    if (pageInstance && !pageInstance.isClosed()) {
      await pageInstance.close();
    }
    if (contextInstance) {
      await contextInstance.close();
      contextInstance = null;
    }
    if (browserInstance && browserInstance.isConnected()) {
      await browserInstance.close();
      browserInstance = null;
    }

    browser = await getBrowser(config);
    const page = await getPage(browser, config.baseUrl);

    // 1. IR PARA PÁGINA DE LOGIN
    log('info', 'Navegando para página de login...');
    const loginUrl = `${config.baseUrl}/portal/app.do?modulo=login`;

    await page.goto(loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: LOGIN_TIMEOUT,
    });

    // Aguardar SPA carregar
    log('info', 'Aguardando SPA carregar...');
    await page.waitForTimeout(3000);

    // 2. PROCURAR CAMPO DE LOGIN - múltiplas estratégias
    log('info', 'Procurando campo de login...');

    let loginField: any = null;
    let passwordField: any = null;

    // Estratégia 1: seletores diretos
    const selectors = {
      login: ['#login', 'input[name="login"]', 'input[id="login"]', 'input[type="text"]', 'input[placeholder*="login" i]', 'input[placeholder*="usuário" i]', 'input[placeholder*="email" i]'],
      password: ['#password', 'input[name="password"]', 'input[id="password"]', 'input[type="password"]', 'input[placeholder*="senha" i]', 'input[placeholder*="password" i]'],
    };

    for (const sel of selectors.login) {
      try {
        const field = await page.waitForSelector(sel, { timeout: 5000 });
        if (field) {
          loginField = field;
          log('info', `Campo login encontrado: ${sel}`);
          break;
        }
      } catch {}
    }

    for (const sel of selectors.password) {
      try {
        const field = await page.waitForSelector(sel, { timeout: 5000 });
        if (field) {
          passwordField = field;
          log('info', `Campo senha encontrado: ${sel}`);
          break;
        }
      } catch {}
    }

    // Estratégia 2: buscar todos inputs e identificar por posição
    if (!loginField || !passwordField) {
      log('info', 'Usando estratégia alternativa para encontrar campos...');
      const inputs = await page.$$('input');
      log('info', `Encontrados ${inputs.length} campos input na página`);

      for (const input of inputs) {
        const type = await input.getAttribute('type');
        const name = await input.getAttribute('name');
        const placeholder = await input.getAttribute('placeholder') || '';
        const id = await input.getAttribute('id');

        console.log(`   Input: type=${type}, name=${name}, id=${id}, placeholder=${placeholder}`);

        if (!loginField && (type === 'text' || !type) && (name?.toLowerCase().includes('login') || placeholder.toLowerCase().includes('login') || placeholder.toLowerCase().includes('usuário'))) {
          loginField = input;
        }
        if (!passwordField && (type === 'password' || name?.toLowerCase().includes('password') || placeholder.toLowerCase().includes('senha'))) {
          passwordField = input;
        }
      }
    }

    if (!loginField || !passwordField) {
      // Tentar fazer screenshot para debug
      await page.screenshot({ path: './debug-login-page.png' });
      log('error', 'Campos de login não encontrados. Screenshot salvo em debug-login-page.png');

      // Dump do HTML para debug
      const html = await page.content();
      console.log('HTML da página (primeiros 3000 chars):');
      console.log(html.substring(0, 3000));

      return false;
    }

    // 3. PREENCHER CREDENCIAIS
    log('info', 'Preenchendo credenciais...');
    await loginField.fill(config.username);
    await passwordField.fill(config.password);
    await page.waitForTimeout(500);

    // 4. CLICAR EM ENTRAR
    log('info', 'Clicando em Entrar...');

    // Primeiro tentar botão com texto "Entrar"
    let enterButton: any = null;
    const buttonSelectors = [
      'button[type="submit"]',
      'button:has-text("Entrar")',
      'button:has-text("Login")',
      'button:has-text("Acessar")',
      'input[type="submit"]',
    ];

    for (const sel of buttonSelectors) {
      try {
        const btn = await page.waitForSelector(sel, { timeout: 2000 });
        if (btn) {
          enterButton = btn;
          break;
        }
      } catch {}
    }

    if (enterButton) {
      await enterButton.click();
    } else {
      // Pressionar Enter no campo de senha
      await passwordField.press('Enter');
    }

    // 5. AGUARDAR REDIRECIONAMENTO
    log('info', 'Aguardando redirecionamento pós-login...');
    await page.waitForTimeout(5000); // Aguardar processamento

    // Verificar se houve redirecionamento
    const currentUrl = page.url();
    log('info', `URL atual: ${currentUrl}`);

    if (currentUrl.includes('login') && !currentUrl.includes('acessaSistema')) {
      log('warn', 'Ainda na página de login, tentando aguardando mais...');
      await page.waitForTimeout(3000);
    }

    // 6. VERIFICAR SUCESSO
    const finalUrl = page.url();
    const loginSuccess = !finalUrl.includes('login') || finalUrl.includes('acessaSistema');

    if (loginSuccess) {
      isLoggedIn = true;
      lastLoginTime = Date.now();
      await getSessionCookies();
      log('success', 'Login realizado com sucesso!');
      log('info', `URL final: ${finalUrl}`);
      return true;
    } else {
      log('error', 'Login pode ter falhado - verificando...');
      await page.screenshot({ path: './debug-login-result.png' });
      return false;
    }

  } catch (error: any) {
    log('error', 'Erro no login:', error.message);
    isLoggedIn = false;
    return false;
  }
}

/**
 * Verifica se está autenticado
 */
export function isSyonetAuthenticated(): boolean {
  return isSessionValid();
}

/**
 * Faz logout
 */
export async function syonetLogout(): Promise<void> {
  log('info', 'Encerrando sessão...');

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

  log('info', 'Sessão encerrada');
}

/**
 * Extrai dados do FUNIL (Tela 1)
 */
export async function extractFunilData(
  config: SyonetRealConfig,
  filters?: { empresaIds?: number[]; dataInicio?: string; dataFim?: string }
): Promise<FunilMetrics[]> {
  if (!isSessionValid()) {
    const logged = await syonetLogin(config);
    if (!logged) throw new Error('Falha ao autenticar no Syonet');
  }

  const page = pageInstance!;
  const metrics: FunilMetrics[] = [];

  try {
    log('info', 'Extraindo dados do Funil...');

    // IDs das empresas de interesse
    const targetEmpresaIds = filters?.empresaIds || [
      71, 72, 75, // VIASUL
      91, 92, 102, // BYD
    ];

    // TENTATIVA 1: Usar APIs internas do Syonet
    log('info', 'Tentando APIs internas do Syonet...');

    const cookies = await getSessionCookies();

    // Testar diferentes endpoints de API
    const apiEndpoints = [
      '/api/v1/dashboard/189',
      '/api/dashboard/189',
      '/api/v1/funil',
      '/api/funil',
      '/api/v1/kpis',
      '/api/kpis',
      '/portal/api/v1/dashboard',
      '/portal/api/dashboard',
    ];

    let apiSuccess = false;
    let dashboardData: any = null;

    for (const endpoint of apiEndpoints) {
      try {
        const url = `${config.baseUrl}${endpoint}`;
        log('info', `Testando: ${endpoint}`);

        const response = await page.evaluate(async (args: { url: string; cookie: string }) => {
          const res = await fetch(args.url, {
            headers: {
              'Cookie': args.cookie,
              'Accept': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
            },
          });

          const text = await res.text();
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }

          return {
            status: res.status,
            statusText: res.statusText,
            data: data,
            contentType: res.headers.get('content-type'),
          };
        }, { url, cookie: cookies });

        console.log(`   Status: ${response.status}, Content-Type: ${response.contentType}`);

        if (response.status === 200 && typeof response.data === 'object') {
          log('success', `API funciona: ${endpoint}`);
          dashboardData = response.data;
          apiSuccess = true;
          break;
        }
      } catch (err: any) {
        console.log(`   Erro: ${err.message}`);
      }
    }

    // TENTATIVA 2: Se APIs não funcionam, navegar na página e extrair dados
    if (!apiSuccess) {
      log('warn', 'APIs não funcionam, tentando extração via scraping...');

      // Navegar para tela de funil
      const funilUrls = [
        `${config.baseUrl}/portal/acessaSistema.do#/funil`,
        `${config.baseUrl}/portal/app.do?modulo=funil`,
        `${config.baseUrl}/portal/acessaSistema.do#/relatorios/funil`,
        `${config.baseUrl}/portal/app.do?modulo=relatorios&pagina=funil`,
      ];

      for (const url of funilUrls) {
        try {
          log('info', `Tentando: ${url}`);
          await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(3000);

          // Verificar se a página carregou corretamente
          const bodyText = await page.textContent('body');
          if (bodyText && bodyText.length > 100) {
            log('success', `Página carregou: ${url}`);
            break;
          }
        } catch (err) {
          log('warn', `Erro ao carregar: ${err}`);
        }
      }
    }

    // Processar dados do dashboard
    if (dashboardData) {
      log('info', 'Processando dados do dashboard...');

      // Estrutura típica do Syonet
      if (Array.isArray(dashboardData)) {
        for (const item of dashboardData) {
          metrics.push(processFunilItem(item, config.baseUrl));
        }
      } else if (dashboardData.data) {
        const dataArray = Array.isArray(dashboardData.data)
          ? dashboardData.data
          : [dashboardData.data];
        for (const item of dataArray) {
          metrics.push(processFunilItem(item, config.baseUrl));
        }
      }
    }

    // Se ainda não temos dados, usar fallback com métricas vazias baseadas no mapeamento
    if (metrics.length === 0) {
      log('warn', 'Usando dados simulados baseados no mapeamento de lojas...');

      for (const empresaId of targetEmpresaIds) {
        const mapped = Object.entries(STORE_MAPPING).find(
          ([, v]) => v.syonetId === empresaId
        );

        if (mapped) {
          metrics.push({
            storeId: `syonet_${empresaId}`,
            storeName: mapped[0],
            date: new Date(),
            leadsTotal: 0,
            leadsByMedia: {},
            appointmentsTotal: 0,
            appointmentsConfirmed: 0,
            flowTotal: 0,
            salesTotal: 0,
            leadsByVl: {},
            leadsByVs: {},
          });
        }
      }
    }

    log('success', `Extraídos ${metrics.length} registros de funil`);
  } catch (error: any) {
    log('error', 'Erro ao extrair funil:', error.message);
    throw error;
  }

  return metrics;
}

/**
 * Processa um item de dados do funil
 */
function processFunilItem(item: any, baseUrl: string): FunilMetrics {
  return {
    storeId: item.idEmpresa?.toString() || item.storeId || 'unknown',
    storeName: item.nomeEmpresa || item.empresa || item.loja || 'Loja Desconhecida',
    date: new Date(item.data || item.date || Date.now()),
    leadsTotal: parseInt(item.leads) || parseInt(item.totalLeads) || parseInt(item.incluidos) || 0,
    leadsByMedia: item.porMidia || item.leadsPorMidia || {},
    appointmentsTotal: parseInt(item.agendamentos) || parseInt(item.totalAgendamentos) || 0,
    appointmentsConfirmed: parseInt(item.confirmados) || parseInt(item.confirmadosTotal) || 0,
    flowTotal: parseInt(item.comparecidos) || parseInt(item.fluxo) || 0,
    salesTotal: parseInt(item.vendas) || parseInt(item.totalVendas) || 0,
    leadsByVl: item.leadsPorVl || {},
    leadsByVs: item.leadsPorVs || {},
  };
}

/**
 * Extrai dados de PRODUTIVIDADE (Tela 2)
 */
export async function extractProductivityData(
  config: SyonetRealConfig,
  vlName?: string
): Promise<ProductivityMetrics[]> {
  if (!isSessionValid()) {
    const logged = await syonetLogin(config);
    if (!logged) throw new Error('Falha ao autenticar no Syonet');
  }

  const page = pageInstance!;
  const metrics: ProductivityMetrics[] = [];

  try {
    log('info', 'Extraindo dados de Produtividade...');

    // Tentar APIs internas primeiro
    const cookies = await getSessionCookies();
    const apiEndpoints = [
      '/api/v1/productividade',
      '/api/productividade',
      '/api/v1/dashboard/162',
      '/api/dashboard/162',
      '/api/v1/usuarios/produtividade',
    ];

    let apiSuccess = false;
    let productivityData: any = null;

    for (const endpoint of apiEndpoints) {
      try {
        const url = `${config.baseUrl}${endpoint}`;
        log('info', `Testando: ${endpoint}`);

        const response = await page.evaluate(async (args: { url: string; cookie: string }) => {
          const res = await fetch(args.url, {
            headers: {
              'Cookie': args.cookie,
              'Accept': 'application/json',
            },
          });

          const text = await res.text();
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }

          return { status: res.status, data };
        }, { url, cookie: cookies });

        if (response.status === 200 && typeof response.data === 'object') {
          log('success', `API funciona: ${endpoint}`);
          productivityData = response.data;
          apiSuccess = true;
          break;
        }
      } catch (err: any) {
        console.log(`   Erro: ${err.message}`);
      }
    }

    // Processar dados de produtividade
    if (productivityData) {
      log('info', 'Processando dados de produtividade...');

      const users = Array.isArray(productivityData)
        ? productivityData
        : (productivityData.usuarios || productivityData.data || []);

      for (const user of users) {
        if (vlName && !(user.nome || user.username || '').toLowerCase().includes(vlName.toLowerCase())) {
          continue;
        }

        metrics.push({
          vlUserId: user.idUsuario?.toString() || user.id?.toString() || `vl_${Date.now()}`,
          vlUserName: user.nome || user.username || 'Consultor',
          storeId: user.idEmpresa?.toString() || user.empresaId?.toString() || 'unknown',
          date: new Date(),
          leadsWaiting: parseInt(user.aguardando) || 0,
          leadsLate: parseInt(user.atrasados) || 0,
          leadsPendingToday: parseInt(user.pendentesDia) || parseInt(user.pendente) || 0,
          leadsFuture: parseInt(user.futuros) || 0,
          leadsTotal: parseInt(user.totalLeads) || parseInt(user.leads) || 0,
          appointmentsToday: parseInt(user.agendamentos) || 0,
          appointmentsConfirmed: parseInt(user.confirmados) || 0,
          salesSuccess: parseInt(user.vendas) || 0,
          averageContactMinutes: parseInt(user.tempoMedio) || undefined,
          priorityClients: parseInt(user.prioridade) || 0,
          forwardedToVs: parseInt(user.encaminhados) || 0,
        });
      }
    }

    log('success', `Extraídos ${metrics.length} registros de produtividade`);
  } catch (error: any) {
    log('error', 'Erro ao extrair produtividade:', error.message);
    throw error;
  }

  return metrics;
}

/**
 * Extrai LEADS individuais
 */
export async function extractLeadsData(
  config: SyonetRealConfig,
  dateRange?: { start: Date; end: Date }
): Promise<LeadData[]> {
  if (!isSessionValid()) {
    const logged = await syonetLogin(config);
    if (!logged) throw new Error('Falha ao autenticar no Syonet');
  }

  const page = pageInstance!;
  const leads: LeadData[] = [];

  try {
    log('info', 'Extraindo leads...');

    const cookies = await getSessionCookies();

    // Tentar API de eventos/leads
    const endpoints = [
      '/api/v1/evento',
      '/api/evento',
      '/api/v1/oportunidade',
      '/api/oportunidade',
      '/api/v1/lead',
      '/api/lead',
    ];

    for (const endpoint of endpoints) {
      try {
        const url = `${config.baseUrl}${endpoint}?page=0&size=100`;
        log('info', `Testando: ${endpoint}`);

        const response = await page.evaluate(async (args: { url: string; cookie: string }) => {
          const res = await fetch(args.url, {
            headers: {
              'Cookie': args.cookie,
              'Accept': 'application/json',
            },
          });

          const text = await res.text();
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }

          return { status: res.status, data };
        }, { url, cookie: cookies });

        if (response.status === 200 && response.data && Array.isArray(response.data)) {
          log('success', `API funciona: ${endpoint}, retornou ${response.data.length} itens`);

          for (const item of response.data.slice(0, 100)) {
            leads.push({
              id: item.idEvento?.toString() || item.id?.toString() || `lead_${Date.now()}`,
              storeId: item.idEmpresa?.toString() || '',
              storeName: item.nomeEmpresa || '',
              mediaRaw: item.midia?.nome || item.midia || 'DESCONHECIDO',
              eventType: item.tipoEvento?.nome || item.grupoEvento || 'OPORTUNIDADE',
              receivedAt: new Date(item.dataInc || item.dataCriacao || Date.now()),
              status: item.situacao?.nome || item.situacao || 'AGUARDANDO',
              statusNormalized: normalizeLeadStatus(item.situacao?.nome || ''),
              priorityFlag: item.prioridade || false,
              assignedVlId: item.idUsuarioResponsavel?.toString(),
              assignedVlName: item.nomeUsuarioResponsavel,
              department: item.grupoEvento,
              tipoVenda: item.tipoVenda || 'Venda Seminovos',
            });
          }

          break;
        }
      } catch (err) {
        console.log(`   Erro: ${err}`);
      }
    }

    log('success', `Extraídos ${leads.length} leads`);
  } catch (error: any) {
    log('error', 'Erro ao extrair leads:', error.message);
    throw error;
  }

  return leads;
}

/**
 * Factory: cria cliente Syonet configurado
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
    username: process.env.SYONET_USERNAME || '',
    password: process.env.SYONET_PASSWORD || '',
    headless: process.env.SYONET_HEADLESS === 'true',
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
