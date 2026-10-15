/**
 * Syonet Sync Service - Serviço de sincronização entre Syonet e PostgreSQL
 *
 * Este serviço é responsável por:
 * 1. Extrair dados do Syonet (leitura pura)
 * 2. Transformar/normalizar os dados
 * 3. Escrever no PostgreSQL (apenas no banco local)
 *
 * NUNCA escreve dados no sistema Syonet.
 *
 * Usa SyonetRealClient (Playwright) quando SYONET_USE_REAL=true,
 * caso contrário usa dados mock para desenvolvimento.
 */

import { PrismaClient, Prisma } from '@prisma/client';
import {
  getSyonetClient,
  getSyonetRealClient,
  FunilMetrics,
  ProductivityMetrics,
  LeadData,
  normalizeMedia,
  normalizeLeadStatus,
  STORE_MAPPING,
  SyncResult
} from './syonet-client';

const prisma = new PrismaClient();

// Flag para usar cliente real ou mock
const USE_REAL_CLIENT = process.env.SYONET_USE_REAL === 'true';

export interface SyncOptions {
  fullLoad?: boolean;      // Carga completa (últimos 180 dias)
  incremental?: boolean;   // Carga incremental (desde última sincronização)
  screens?: ('FUNIL' | 'PRODUTIVIDADE' | 'LEADS')[];
}

export interface SyncSummary {
  batchId: string;
  startedAt: Date;
  finishedAt: Date;
  screens: {
    screen: string;
    success: boolean;
    rowsProcessed: number;
    errors: string[];
  }[];
  totalRowsProcessed: number;
  totalErrors: number;
}

/**
 * Gera um ID único para o batch de sincronização
 */
function generateBatchId(): string {
  return `SYNC_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Converte o instante da extração para o dia civil (coluna DATE) no fuso das praças.
 * Fortaleza e Salvador são UTC-3 sem horário de verão, então um único fuso atende as duas.
 */
function toExtractionDay(date: Date): Date {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia' })
    .format(date)
    .split('-')
    .map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Obtém a data da última sincronização bem-sucedida
 */
async function getLastSuccessfulSync(screen: string): Promise<Date | null> {
  const syncRun = await prisma.syncRun.findFirst({
    where: {
      source: 'SYONET_API',
      status: 'SUCCESS',
    },
    orderBy: {
      finishedAt: 'desc',
    },
  });
  return syncRun?.finishedAt || null;
}

/**
 * Registra o início de uma sincronização
 */
async function registerSyncStart(_batchId: string, source: string): Promise<string> {
  const syncRun = await prisma.syncRun.create({
    data: {
      source: 'SYONET_API',
      startedAt: new Date(),
      status: 'RUNNING',
    },
  });
  return syncRun.id;
}

/**
 * Registra o fim de uma sincronização
 */
async function registerSyncEnd(
  syncRunId: string,
  status: 'SUCCESS' | 'FAILED' | 'PARTIAL',
  rowsRead: number,
  rowsInserted: number,
  rowsUpdated: number,
  rowsSkipped: number,
  errorMessage?: string
): Promise<void> {
  await prisma.syncRun.update({
    where: { id: syncRunId },
    data: {
      status,
      finishedAt: new Date(),
      rowsRead,
      rowsInserted,
      rowsUpdated,
      rowsSkipped,
      errorMessage,
    },
  });
}

/**
 * Encontra ou cria o ID da loja pelo nome Syonet
 */
async function getStoreId(syonetName: string): Promise<string | null> {
  const store = await prisma.store.findFirst({
    where: { syonetName },
  });
  return store?.id || null;
}

/**
 * Encontra ou cria o ID da mídia pelo nome raw
 */
async function getMediaId(rawName: string): Promise<string | null> {
  const normalized = normalizeMedia(rawName);

  // Primeiro tenta encontrar pela mídia raw
  let media = await prisma.mediaSource.findFirst({
    where: { rawName },
  });

  // Se não encontrar, cria uma nova
  if (!media) {
    media = await prisma.mediaSource.create({
      data: {
        rawName,
        normalizedName: normalized.normalized,
        category: normalized.category as any,
        active: true,
      },
    });
  }

  return media.id;
}

/**
 * Encontra o ID do usuário VL pelo nome de usuário
 */
async function getVlUserId(username: string): Promise<string | null> {
  const user = await prisma.user.findFirst({
    where: {
      username: username.toUpperCase(),
      role: 'VL_CONSULTANT',
    },
  });
  return user?.id || null;
}

/**
 * Sincroniza métricas de funil (Tela 1)
 */
async function syncFunilMetrics(batchId: string): Promise<{ processed: number; errors: string[] }> {
  const errors: string[] = [];
  let processed = 0;

  try {
    console.log('📊 Sync: Iniciando sincronização de Funil...');

    let metrics: FunilMetrics[];

    if (USE_REAL_CLIENT) {
      // Usar cliente real (Playwright)
      console.log('🔄 Sync: Usando cliente Syonet REAL');
      const realClient = getSyonetRealClient();
      const logged = await realClient.login();
      if (!logged) {
        throw new Error('Falha ao autenticar no Syonet');
      }
      metrics = await realClient.extractFunil();
      await realClient.logout();
    } else {
      // Usar cliente mock (desenvolvimento)
      console.log('🔄 Sync: Usando cliente Syonet MOCK');
      const client = getSyonetClient();
      metrics = await client.extractFunilMetrics();
    }

    for (const metric of metrics) {
      try {
        const syonetId = Number(String(metric.storeId).replace(/^syonet_/, ''));
        const mappedStore = Number.isInteger(syonetId)
          ? Object.values(STORE_MAPPING).find(mapping => mapping.syonetId === syonetId)
          : undefined;
        const canonicalStoreName = mappedStore?.syonetName ?? metric.storeName;
        const storeId = await getStoreId(canonicalStoreName);
        if (!storeId) {
          errors.push(`Loja não encontrada no escopo Eurovia: ${canonicalStoreName}`);
          continue;
        }

        const extractionDate = toExtractionDay(metric.date);

        // Linhas por mídia carregam só leads; agendamentos/fluxo/vendas ficam na linha total da loja
        const mediaRows: Prisma.SyncMetricsCreateManyInput[] = [];
        for (const [mediaName, leadsCount] of Object.entries(metric.leadsByMedia)) {
          if (mediaName.toUpperCase() === 'TOTAL') continue;
          mediaRows.push({
            extractionDate,
            storeId,
            mediaId: await getMediaId(mediaName),
            vlUserId: null,
            leadsTotal: leadsCount,
            syncBatchId: batchId,
          });
        }

        const storeTotalRow: Prisma.SyncMetricsCreateManyInput = {
          extractionDate,
          storeId,
          mediaId: null,
          vlUserId: null,
          leadsTotal: metric.leadsTotal,
          appointmentsTotal: metric.appointmentsTotal,
          appointmentsConfirmed: metric.appointmentsConfirmed,
          flowTotal: metric.flowTotal,
          salesTotal: metric.salesTotal,
          syncBatchId: batchId,
        };

        // Postgres trata NULL como distinto em UNIQUE, então a idempotência é garantida por delete + insert
        await prisma.$transaction([
          prisma.syncMetrics.deleteMany({ where: { extractionDate, storeId, vlUserId: null } }),
          prisma.syncMetrics.createMany({ data: [...mediaRows, storeTotalRow] }),
        ]);

        processed += mediaRows.length + 1;

      } catch (err) {
        const msg = `Erro ao processar métrica para loja ${metric.storeName}: ${err}`;
        errors.push(msg);
        console.error(msg);
      }
    }

    console.log(`✅ Sync Funil: ${processed} registros processados`);
  } catch (err) {
    errors.push(`Erro na extração do Syonet: ${err}`);
    console.error('❌ Sync Funil: Erro na extração:', err);
  }

  return { processed, errors };
}

/**
 * Sincroniza métricas de produtividade (Tela 2)
 */
async function syncProductivityMetrics(batchId: string): Promise<{ processed: number; errors: string[] }> {
  const errors: string[] = [];
  let processed = 0;

  try {
    console.log('📊 Sync: Iniciando sincronização de Produtividade...');

    let metrics: ProductivityMetrics[];

    if (USE_REAL_CLIENT) {
      // Usar cliente real (Playwright)
      console.log('🔄 Sync: Usando cliente Syonet REAL para produtividade');
      const realClient = getSyonetRealClient();
      const logged = await realClient.login();
      if (!logged) {
        throw new Error('Falha ao autenticar no Syonet');
      }
      metrics = await realClient.extractProductivity();
      await realClient.logout();
    } else {
      // Usar cliente mock (desenvolvimento)
      console.log('🔄 Sync: Usando cliente Syonet MOCK');
      const client = getSyonetClient();
      metrics = await client.extractProductivityMetrics();
    }

    for (const metric of metrics) {
      try {
        const vlUserId = await getVlUserId(metric.vlUserName);
        if (!vlUserId) {
          errors.push(`Usuário VL não encontrado: ${metric.vlUserName}`);
          continue;
        }

        // Buscar a loja do VL
        const vlUser = await prisma.user.findUnique({
          where: { id: vlUserId },
          include: { store: true },
        });

        if (!vlUser?.storeId) {
          errors.push(`Loja não encontrada para VL: ${metric.vlUserName}`);
          continue;
        }

        // Criar snapshot de produtividade
        await prisma.productivitySnapshot.upsert({
          where: {
            userId_periodStart: {
              userId: vlUserId,
              periodStart: metric.date,
            },
          },
          create: {
            userId: vlUserId,
            storeId: vlUser.storeId,
            periodStart: metric.date,
            periodEnd: metric.date,
            leadsXVendedorLoja: metric.leadsTotal - metric.forwardedToVs,
            leadsXOperadorBdc: metric.forwardedToVs,
            appointmentsCount: metric.appointmentsToday,
            confirmedVisits: metric.appointmentsConfirmed,
            salesCount: metric.salesSuccess,
            averageContactMinutes: metric.averageContactMinutes,
            priorityClients: metric.priorityClients,
            waitingCount: metric.leadsWaiting,
            lateCount: metric.leadsLate,
            pendingTodayCount: metric.leadsPendingToday,
            futureCount: metric.leadsFuture,
            syncedAt: new Date(),
          },
          update: {
            leadsXVendedorLoja: metric.leadsTotal - metric.forwardedToVs,
            leadsXOperadorBdc: metric.forwardedToVs,
            appointmentsCount: metric.appointmentsToday,
            confirmedVisits: metric.appointmentsConfirmed,
            salesCount: metric.salesSuccess,
            averageContactMinutes: metric.averageContactMinutes,
            priorityClients: metric.priorityClients,
            waitingCount: metric.leadsWaiting,
            lateCount: metric.leadsLate,
            pendingTodayCount: metric.leadsPendingToday,
            futureCount: metric.leadsFuture,
            syncedAt: new Date(),
          },
        });

        // Criar métricas de sincronização por VL
        const extractionDate = toExtractionDay(metric.date);
        await prisma.syncMetrics.upsert({
          where: {
            extractionDate_storeId_vlUserId: {
              extractionDate,
              storeId: vlUser.storeId,
              vlUserId,
            },
          },
          create: {
            extractionDate,
            storeId: vlUser.storeId,
            vlUserId,
            leadsTotal: metric.leadsTotal,
            leadsToVs: metric.forwardedToVs,
            appointmentsTotal: metric.appointmentsToday,
            appointmentsConfirmed: metric.appointmentsConfirmed,
            flowTotal: metric.appointmentsConfirmed, // Visitas confirmadas
            salesTotal: metric.salesSuccess,
            syncBatchId: batchId,
          },
          update: {
            leadsTotal: metric.leadsTotal,
            leadsToVs: metric.forwardedToVs,
            appointmentsTotal: metric.appointmentsToday,
            appointmentsConfirmed: metric.appointmentsConfirmed,
            flowTotal: metric.appointmentsConfirmed,
            salesTotal: metric.salesSuccess,
            syncBatchId: batchId,
          },
        });

        processed++;
      } catch (err) {
        const msg = `Erro ao processar produtividade para VL ${metric.vlUserName}: ${err}`;
        errors.push(msg);
        console.error(msg);
      }
    }

    console.log(`✅ Sync Produtividade: ${processed} registros processados`);
  } catch (err) {
    errors.push(`Erro na extração do Syonet: ${err}`);
    console.error('❌ Sync Produtividade: Erro na extração:', err);
  }

  return { processed, errors };
}

/**
 * Sincroniza leads individuais (carga granular)
 */
async function syncLeads(batchId: string, dateRange?: { start: Date; end: Date }): Promise<{ processed: number; errors: string[] }> {
  const errors: string[] = [];
  let processed = 0;

  try {
    console.log('📊 Sync: Iniciando sincronização de Leads...');
    let leads: LeadData[];

    if (USE_REAL_CLIENT) {
      const realClient = getSyonetRealClient();
      const logged = await realClient.login();
      if (!logged) {
        throw new Error('Falha ao autenticar no Syonet');
      }
      try {
        leads = await realClient.extractLeads(dateRange);
      } finally {
        await realClient.logout();
      }
    } else {
      const client = getSyonetClient();
      leads = await client.extractLeads(dateRange);
    }

    for (const lead of leads) {
      try {
        const storeId = await getStoreId(lead.storeName);
        if (!storeId) {
          errors.push(`Loja não encontrada: ${lead.storeName}`);
          continue;
        }

        const mediaId = lead.mediaRaw ? await getMediaId(lead.mediaRaw) : null;
        const vlUserId = lead.assignedVlName ? await getVlUserId(lead.assignedVlName) : null;

        await prisma.lead.upsert({
          where: {
            syonetLeadId_storeId: {
              syonetLeadId: lead.id,
              storeId,
            },
          },
          create: {
            syonetLeadId: lead.id,
            storeId,
            mediaSourceId: mediaId,
            mediaRaw: lead.mediaRaw,
            receivedAt: lead.receivedAt,
            integrationDate: lead.integrationDate,
            status: lead.status,
            statusNormalized: lead.statusNormalized as any,
            priorityFlag: lead.priorityFlag,
            assignedVlId: vlUserId,
            eventType: lead.eventType,
            department: lead.department,
            tipoVenda: lead.tipoVenda,
          },
          update: {
            mediaSourceId: mediaId,
            mediaRaw: lead.mediaRaw,
            status: lead.status,
            statusNormalized: lead.statusNormalized as any,
            priorityFlag: lead.priorityFlag,
            assignedVlId: vlUserId,
          },
        });

        processed++;
      } catch (err) {
        const msg = `Erro ao processar lead ${lead.id}: ${err}`;
        errors.push(msg);
        console.error(msg);
      }
    }

    console.log(`✅ Sync Leads: ${processed} leads processados`);
  } catch (err) {
    errors.push(`Erro na extração do Syonet: ${err}`);
    console.error('❌ Sync Leads: Erro na extração:', err);
  }

  return { processed, errors };
}

/**
 * Executa a sincronização completa
 */
export async function runSync(options: SyncOptions = {}): Promise<SyncSummary> {
  // Produção nunca pode cair no cliente mock. O Syonet continua protegido
  // pelo guard imutável: toda coleta externa é consulta, enquanto as gravações
  // deste serviço ficam exclusivamente no PostgreSQL do CRM.
  const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
  if (!USE_REAL_CLIENT && isProduction) {
    throw new Error('Syonet: cliente mock proibido em producao');
  }
  const batchId = generateBatchId();
  const startedAt = new Date();
  const screens: SyncSummary['screens'] = [];
  let totalRowsProcessed = 0;
  let totalErrors = 0;
  let syncRunId: string | null = null;

  console.log(`\n🚀 INICIANDO SINCRONIZAÇÃO - Batch: ${batchId}`);
  console.log(`📅 Data: ${startedAt.toISOString()}`);
  console.log(`🎯 Screens: ${options.screens?.join(', ') || 'TODOS'}`);
  console.log('');

  try {
    // Registrar início da sincronização
    syncRunId = await registerSyncStart(batchId, 'SYONET_API');

    // Sincronizar Funil
    if (!options.screens || options.screens.includes('FUNIL')) {
      const result = await syncFunilMetrics(batchId);
      totalRowsProcessed += result.processed;
      totalErrors += result.errors.length;
      screens.push({
        screen: 'FUNIL',
        success: result.errors.length === 0,
        rowsProcessed: result.processed,
        errors: result.errors,
      });
    }

    // Sincronizar Produtividade
    if (!options.screens || options.screens.includes('PRODUTIVIDADE')) {
      const result = await syncProductivityMetrics(batchId);
      totalRowsProcessed += result.processed;
      totalErrors += result.errors.length;
      screens.push({
        screen: 'PRODUTIVIDADE',
        success: result.errors.length === 0,
        rowsProcessed: result.processed,
        errors: result.errors,
      });
    }

    // Sincronizar Leads (se full load)
    if (options.fullLoad) {
      const result = await syncLeads(batchId);
      totalRowsProcessed += result.processed;
      totalErrors += result.errors.length;
      screens.push({
        screen: 'LEADS',
        success: result.errors.length === 0,
        rowsProcessed: result.processed,
        errors: result.errors,
      });
    }

    // Registrar fim da sincronização
    const status = totalErrors === 0 ? 'SUCCESS' : 'PARTIAL';
    await registerSyncEnd(
      syncRunId,
      status,
      totalRowsProcessed,
      totalRowsProcessed,
      0,
      totalErrors,
      totalErrors > 0 ? `${totalErrors} erros ocurridos` : undefined
    );

    console.log(`\n✅ SINCRONIZAÇÃO CONCLUÍDA - Batch: ${batchId}`);
    console.log(`📊 Total processado: ${totalRowsProcessed}`);
    console.log(`❌ Total erros: ${totalErrors}`);

  } catch (err) {
    totalErrors += 1;
    if (syncRunId) {
      try {
        await registerSyncEnd(syncRunId, 'FAILED', totalRowsProcessed, 0, 0, totalErrors, 'Falha de sistema durante sincronizacao');
      } catch {
        console.error('Falha adicional ao registrar finalizacao de sync no banco Eurovia');
      }
    }
    // Nao registrar payloads, URLs ou cookies de integracao em logs.
    console.error('Falha no processo de sincronizacao Eurovia');
    screens.push({
      screen: 'SYSTEM',
      success: false,
      rowsProcessed: 0,
      errors: ['Falha de sistema durante sincronizacao'],
    });
  }

  return {
    batchId,
    startedAt,
    finishedAt: new Date(),
    screens,
    totalRowsProcessed,
    totalErrors,
  };
}

/**
 * Verifica o status da última sincronização
 */
export async function getSyncStatus(): Promise<{
  lastSync: Date | null;
  status: string;
  rowsProcessed: number;
  errors: number;
}> {
  const lastRun = await prisma.syncRun.findFirst({
    where: { source: 'SYONET_API' },
    orderBy: { finishedAt: 'desc' },
  });

  return {
    lastSync: lastRun?.finishedAt || null,
    status: lastRun?.status || 'NEVER_RUN',
    rowsProcessed: lastRun?.rowsRead || 0,
    errors: lastRun?.rowsSkipped || 0,
  };
}
