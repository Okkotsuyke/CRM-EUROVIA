/**
 * Scheduler de Sincronização Syonet
 *
 * Executa a sincronização automaticamente a cada 15 minutos
 */

import { runSync, getSyncStatus } from './syonet-sync.service';
import { getSyonetClient } from './syonet-client';

let schedulerInterval: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Verifica se o scheduler está ativo
 */
export function isSchedulerActive(): boolean {
  return schedulerInterval !== null;
}

/**
 * Verifica se uma sincronização está em andamento
 */
export function isSyncRunning(): boolean {
  return isRunning;
}

/**
 * Callback de sincronização
 */
async function syncCallback(): Promise<void> {
  if (isRunning) {
    console.log('⏳ Sync: Sincronização anterior ainda em andamento, pulando...');
    return;
  }

  console.log(`\n⏰ ${new Date().toISOString()} - Iniciando sincronização programada...`);
  isRunning = true;

  try {
    const result = await runSync({
      screens: ['FUNIL', 'PRODUTIVIDADE'],
      incremental: true,
      fullLoad: process.env.SYNC_FULL_LOAD === 'true',
    });

    if (result.totalErrors === 0) {
      console.log(`✅ Sync: Sucesso! ${result.totalRowsProcessed} registros processados`);
    } else {
      console.log(`⚠️  Sync: Concluído com ${result.totalErrors} erros`);
    }
  } catch (error) {
    console.error('❌ Sync: Erro na execução:', error);
  } finally {
    isRunning = false;
  }
}

/**
 * Inicia o scheduler de sincronização
 */
export function startSyncScheduler(): void {
  if (process.env.VERCEL === '1') {
    console.log('ℹ️ Scheduler desabilitado em Vercel — usando Vercel Cron');
    return;
  }
  if (schedulerInterval) {
    console.log('⚠️  Scheduler já está ativo');
    return;
  }

  // Verificar se está habilitado
  if (process.env.SYNC_ENABLED !== 'true') {
    console.log('ℹ️  Scheduler desabilitado (SYNC_ENABLED=false)');
    return;
  }

  const intervalMs = 15 * 60 * 1000; // 15 minutos

  console.log(`🚀 Iniciando scheduler de sincronização (intervalo: ${intervalMs / 60000} minutos)`);

  // Executar imediatamente na inicialização
  syncCallback();

  // Configurar execução periódica
  schedulerInterval = setInterval(syncCallback, intervalMs);
}

/**
 * Para o scheduler de sincronização
 */
export function stopSyncScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('🛑 Scheduler de sincronização parado');
  }
}

/**
 * Executa uma sincronização manual
 */
export async function triggerManualSync(): Promise<any> {
  if (isRunning) {
    return {
      success: false,
      error: 'Uma sincronização já está em andamento',
    };
  }

  return syncCallback();
}

/**
 * Retorna o status do scheduler
 */
export function getSchedulerStatus(): {
  active: boolean;
  running: boolean;
  lastSync: Date | null;
  status: string;
  rowsProcessed: number;
  errors: number;
} {
  return {
    active: isSchedulerActive(),
    running: isSyncRunning(),
    lastSync: null,
    status: 'UNKNOWN',
    rowsProcessed: 0,
    errors: 0,
  };
}

// Cleanup na saída do processo
process.on('SIGTERM', () => {
  console.log('📤 Recebido SIGTERM, parando scheduler...');
  stopSyncScheduler();
});

process.on('SIGINT', () => {
  console.log('📤 Recebido SIGINT, parando scheduler...');
  stopSyncScheduler();
});