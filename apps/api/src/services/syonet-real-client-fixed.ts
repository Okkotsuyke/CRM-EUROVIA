/**
 * Syonet Real Client - Cliente corrigido para extração de dados do CRM Syonet
 *
 * Usa Playwright com a abordagem CORRETA para campos React controlados:
 * - page.fill() em vez de page.evaluate() para preenchimento
 * - Aguarda 18 segundos para React renderizar completamente
 *
 * APIs confirmadas funcionando:
 * - GET /api/dashboard - Lista de dashboards
 * - GET /api/dashboard/189 - Dashboard de vendas (Incluidos/Agendados/Comparecidos/Vendas)
 * - GET /api/dashboard/162 - Produtividade
 * - GET /api/dashboard/244 - Funil de vendas
 * - GET /api/empresa - Lista de empresas
 * - GET /api/empresa/{id} - Empresa específica
 * - GET /api/funil - Funil
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

const DEFAULT_TIMEOUT = 90000;
const REACT_WAIT_TIME = 18000;

export interface SyonetRealConfig {
  baseUrl: string;
  username: string;
  password: string;
  headless?: boolean;
  timeout?: number;
}

export interface SyonetSession {
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  isLoggedIn: boolean;
  cookies: string;
  lastLoginTime: number;
}

// Singleton
let browserInstance: Browser | null = null;
let contextInstance: BrowserContext | null = null;
let pageInstance: Page | null = null;
let isLoggedIn = false;
let lastLoginTime = 0;

function log(level: 'info' | 'success' | 'error' | 'warn', message: string, ...args: any[]) {
  const prefix = { info: '🔵', success: '✅', error: '❌', warn: '⚠️' }[level];
  console.log(`${prefix} Syonet: ${message}`, ...args);
}

/**
 * Aguarda inputs aparecerem no DOM (polling)
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
 * Login no Syonet usando abordagem CORRETA para campos React
 */
export async function syonetLogin(config: SyonetRealConfig): Promise<boolean> {
  try {
    if (isLoggedIn && pageInstance && !pageInstance.isClosed()) {
      const age = Date.now() - lastLoginTime;
      if (age < 20 * 60 * 1000) {
        log('info', 'Usando sessão em cache');
        return true;
      }
    }

    log('info', `Login como ${config.username}...`);

    // Fechar sessões anteriores
    await closeSession();

    // Criar navegador
    browserInstance = await chromium.launch({
      headless: config.headless ?? false,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    contextInstance = await browserInstance.newContext({
      viewport: { width: 1366, height: 768 },
      serviceWorkers: 'block',
    });
    await installSyonetReadOnlyGuard(contextInstance, config.baseUrl);

    pageInstance = await contextInstance.newPage();
    pageInstance.setDefaultTimeout(DEFAULT_TIMEOUT);

    // 1. Navegar
    log('info', 'Navegando para login...');
    await pageInstance.goto(config.baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // 2. AGUARDAR REACT RENDERIZAR (CRÍTICO!)
    log('info', `Aguardando React renderizar (${REACT_WAIT_TIME / 1000}s)...`);
    await pageInstance.waitForTimeout(REACT_WAIT_TIME);

    // 3. Aguardar inputs aparecerem
    log('info', 'Aguardando inputs...');
    const inputCount = await waitForInputs(pageInstance);

    if (inputCount === 0) {
      log('error', 'Timeout esperando inputs');
      await closeSession();
      return false;
    }

    log('success', `Inputs encontrados: ${inputCount}`);

    // 4. Preencher usando page.fill() QUE FUNCIONA COM REACT
    const inputs = await pageInstance.$$('input');

    // Primeiro input = usuário, segundo = senha
    await inputs[0].fill(config.username);
    await inputs[1].fill(config.password);

    log('info', 'Credenciais preenchidas');

    // 5. Clicar em Entrar
    const enterBtn = await pageInstance.$('button:has-text("Entrar")');
    if (enterBtn) {
      await enterBtn.click();
      log('info', 'Botão Entrar clicado');
    }

    // 6. Aguardar redirecionamento
    log('info', 'Aguardando redirecionamento...');
    await pageInstance.waitForTimeout(10000);

    const finalUrl = pageInstance.url();
    const success = !finalUrl.includes('login');

    if (success) {
      isLoggedIn = true;
      lastLoginTime = Date.now();
      log('success', 'Login bem-sucedido!');
      log('info', `URL: ${finalUrl}`);
      return true;
    } else {
      log('error', 'Login falhou');
      return false;
    }

  } catch (error: any) {
    log('error', 'Erro no login:', error.message);
    await closeSession();
    return false;
  }
}

/**
 * Fecha sessão
 */
async function closeSession(): Promise<void> {
  try {
    if (pageInstance && !pageInstance.isClosed()) {
      await pageInstance.close();
    }
  } catch {}

  try {
    if (contextInstance) {
      await contextInstance.close();
    }
  } catch {}

  try {
    if (browserInstance && browserInstance.isConnected()) {
      await browserInstance.close();
    }
  } catch {}

  pageInstance = null;
  contextInstance = null;
  browserInstance = null;
  isLoggedIn = false;
}

/**
 * Logout
 */
export async function syonetLogout(): Promise<void> {
  log('info', 'Encerrando sessão...');
  await closeSession();
  log('info', 'Sessão encerrada');
}

/**
 * Verifica se está autenticado
 */
export function isSyonetAuthenticated(): boolean {
  return isLoggedIn && pageInstance !== null && !pageInstance.isClosed();
}

/**
 * Obtém cookies da sessão
 */
async function getSessionCookies(): Promise<string> {
  if (!contextInstance || !pageInstance) return '';
  const cookies = await contextInstance.cookies();
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * Extrai dados do Funil (Dashboard 189)
 */
export async function extractFunilData(
  config: SyonetRealConfig,
  filters?: { empresaIds?: number[]; dataInicio?: string; dataFim?: string }
): Promise<FunilMetrics[]> {
  if (!isSyonetAuthenticated()) {
    const logged = await syonetLogin(config);
    if (!logged) throw new Error('Falha ao autenticar no Syonet');
  }

  const page = pageInstance!;
  const metrics: FunilMetrics[] = [];
  const cookies = await getSessionCookies();

  try {
    log('info', 'Extraindo dados do Funil (Dashboard 189)...');

    // Buscar Dashboard 189
    const dashboardData: { empresas?: Array<{ id?: number; nome?: string; apelido?: string; incluidos?: number; leads?: number; porMidia?: Record<string,number>; agendamentos?: number; confirmados?: number; comparecidos?: number; vendas?: number }> } | null = await page.evaluate(async (args) => {
      const res = await fetch(args.baseUrl + '/api/dashboard/189', {
        headers: {
          'Cookie': args.cookie,
          'Accept': 'application/json',
        },
      });
      return res.ok ? await res.json() : null;
    }, { baseUrl: config.baseUrl, cookie: cookies });

    if (dashboardData) {
      log('success', `Dashboard 189 recebido`);

      // Extrair dados de cada empresa
      if (dashboardData.empresas && Array.isArray(dashboardData.empresas)) {
        for (const empresa of dashboardData.empresas) {
          // Verificar se empresa está nos filtros
          if (filters?.empresaIds && empresa.id !== undefined && !filters.empresaIds.includes(empresa.id)) {
            continue;
          }

          metrics.push({
            storeId: empresa.id?.toString() || 'unknown',
            storeName: empresa.nome || empresa.apelido || 'Loja Desconhecida',
            date: new Date(),
            leadsTotal: empresa.incluidos || empresa.leads || 0,
            leadsByMedia: empresa.porMidia || {},
            appointmentsTotal: empresa.agendamentos || 0,
            appointmentsConfirmed: empresa.confirmados || 0,
            flowTotal: empresa.comparecidos || 0,
            salesTotal: empresa.vendas || 0,
            leadsByVl: {},
            leadsByVs: {},
          });
        }
      }
    }

    // Se não temos dados do dashboard, usar fallback
    if (metrics.length === 0) {
      log('warn', 'Fallback: usando mapeamento de lojas');

      const targetIds = filters?.empresaIds || Object.values(STORE_MAPPING).map(v => v.syonetId);

      for (const empresaId of targetIds) {
        try {
          const empresaData = await page.evaluate(async (args) => {
            const res = await fetch(args.baseUrl + `/api/empresa/${args.id}`, {
              headers: {
                'Cookie': args.cookie,
                'Accept': 'application/json',
              },
            });
            return res.ok ? await res.json() : null;
          }, { baseUrl: config.baseUrl, cookie: cookies, id: empresaId });

          if (empresaData) {
            const mapped = Object.entries(STORE_MAPPING).find(
              ([, v]) => v.syonetId === empresaId
            );

            metrics.push({
              storeId: `syonet_${empresaId}`,
              storeName: mapped?.[0] || empresaData.nome || empresaData.apelido || 'Loja',
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
        } catch {}
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
 * Extrai dados de Produtividade (Dashboard 162)
 */
export async function extractProductivityData(
  config: SyonetRealConfig,
  vlName?: string
): Promise<ProductivityMetrics[]> {
  if (!isSyonetAuthenticated()) {
    const logged = await syonetLogin(config);
    if (!logged) throw new Error('Falha ao autenticar no Syonet');
  }

  const page = pageInstance!;
  const metrics: ProductivityMetrics[] = [];
  const cookies = await getSessionCookies();

  try {
    log('info', 'Extraindo dados de Produtividade (Dashboard 162)...');

    const dashboardData = await page.evaluate(async (args) => {
      const res = await fetch(args.baseUrl + '/api/dashboard/162', {
        headers: {
          'Cookie': args.cookie,
          'Accept': 'application/json',
        },
      });
      return res.ok ? await res.json() : null;
    }, { baseUrl: config.baseUrl, cookie: cookies });

    if (dashboardData?.empresas) {
      for (const empresa of dashboardData.empresas) {
        if (empresa.usuarios && Array.isArray(empresa.usuarios)) {
          for (const usuario of empresa.usuarios) {
            if (vlName && !(usuario.nome || '').toLowerCase().includes(vlName.toLowerCase())) {
              continue;
            }

            metrics.push({
              vlUserId: usuario.id?.toString() || `vl_${Date.now()}`,
              vlUserName: usuario.nome || 'Consultor',
              storeId: empresa.id?.toString() || 'unknown',
              date: new Date(),
              leadsWaiting: usuario.aguardando || 0,
              leadsLate: usuario.atrasados || 0,
              leadsPendingToday: usuario.pendentesDia || 0,
              leadsFuture: usuario.futuros || 0,
              leadsTotal: usuario.totalLeads || 0,
              appointmentsToday: usuario.agendamentos || 0,
              appointmentsConfirmed: usuario.confirmados || 0,
              salesSuccess: usuario.vendas || 0,
              averageContactMinutes: usuario.tempoMedio,
              priorityClients: usuario.prioridade || 0,
              forwardedToVs: usuario.encaminhados || 0,
            });
          }
        }
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
 * Extrai dados de Leads individuais
 */
export async function extractLeadsData(
  config: SyonetRealConfig,
  dateRange?: { start: Date; end: Date }
): Promise<LeadData[]> {
  if (!isSyonetAuthenticated()) {
    const logged = await syonetLogin(config);
    if (!logged) throw new Error('Falha ao autenticar no Syonet');
  }

  const page = pageInstance!;
  const leads: LeadData[] = [];
  const cookies = await getSessionCookies();

  try {
    log('info', 'Extraindo leads...');

    // Buscar empresa(s)
    const empresas = await page.evaluate(async (args) => {
      const res = await fetch(args.baseUrl + '/api/empresa', {
        headers: {
          'Cookie': args.cookie,
          'Accept': 'application/json',
        },
      });
      const data = await res.json();
      return Array.isArray(data) ? data.slice(0, 5) : [];
    }, { baseUrl: config.baseUrl, cookie: cookies });

    for (const empresa of empresas) {
      // Buscar eventos/oportunidades da empresa
      const eventos = await page.evaluate(async (args) => {
        // Tentar diferentes endpoints
        const endpoints = [
          `/api/evento?empresaId=${args.empresaId}&page=0&size=50`,
          `/api/oportunidade?empresaId=${args.empresaId}&page=0&size=50`,
        ];

        for (const ep of endpoints) {
          try {
            const res = await fetch(args.baseUrl + ep, {
              headers: {
                'Cookie': args.cookie,
                'Accept': 'application/json',
              },
            });

            if (res.ok) {
              const data = await res.json();
              return Array.isArray(data) ? data : [];
            }
          } catch {}
        }
        return [];
      }, { baseUrl: config.baseUrl, cookie: cookies, empresaId: empresa.id });

      for (const evento of eventos.slice(0, 100)) {
        leads.push({
          id: evento.id?.toString() || `lead_${Date.now()}`,
          storeId: empresa.id?.toString() || '',
          storeName: empresa.nome || empresa.apelido || '',
          mediaRaw: evento.midia?.nome || evento.midia || 'DESCONHECIDO',
          eventType: evento.tipoEvento?.nome || evento.grupoEvento || 'OPORTUNIDADE',
          receivedAt: new Date(evento.dataInc || evento.dataCriacao || Date.now()),
          status: evento.situacao?.nome || evento.situacao || 'AGUARDANDO',
          statusNormalized: normalizeLeadStatus(evento.situacao?.nome || ''),
          priorityFlag: evento.prioridade || false,
          assignedVlId: evento.idUsuarioResponsavel?.toString(),
          assignedVlName: evento.nomeUsuarioResponsavel,
          department: evento.grupoEvento,
          tipoVenda: evento.tipoVenda || 'Venda Seminovos',
        });
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
 * Factory para criar cliente Syonet
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
