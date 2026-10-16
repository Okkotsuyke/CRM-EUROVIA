/**
 * Routes: Cron Jobs
 *
 * Endpoints para tarefas agendadas via Vercel Cron
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { runSync, getSyncStatus } from '../services/syonet-sync.service';

/**
 * GET /api/cron/sync
 * Executa sincronização completa (chamado pelo Vercel Cron diariamente)
 * Exige Authorization: Bearer CRON_SECRET em TODOS os ambientes
 */
/**
 * Verifica segredo Vercel com comparacao de tempo constante.
 * Segredos curtos ou ausentes nunca autorizam execucao.
 */
export function isValidCronAuthorization(
  authorization: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || secret.length < 32 || !authorization?.startsWith('Bearer ')) {
    return false;
  }
  const supplied = Buffer.from(authorization.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function cronRoutes(fastify: FastifyInstance) {

  const verifyVercelCron = (request: FastifyRequest): boolean =>
    isValidCronAuthorization(request.headers.authorization, process.env.CRON_SECRET);

  /**
   * GET /api/cron/sync
   * Sincroniza dados do Syonet
   */
  fastify.get('/sync', {
    config: {
      rateLimit: {
        max: 1, // Apenas 1 execução por minuto
        timeWindow: '1 minute',
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const startTime = Date.now();

    // Verificar se é uma request legítima do Vercel Cron
    const isCronRequest = verifyVercelCron(request);

    // Nunca aceitar x-vercel-cron: 1 como autenticacao.
    if (!isCronRequest) {
      fastify.log.warn('Tentativa de acesso ao cron sem autorizacao valida');
      return reply.status(403).send({
        success: false,
        error: 'Forbidden - Cron endpoint',
      });
    }

    fastify.log.info('Iniciando sincronização via Cron Job');

    try {
      const result = await runSync({
        screens: undefined, // Sincroniza todos os funis
        fullLoad: false,   // Apenas dados novos
      });

      const duration = Date.now() - startTime;

      fastify.log.info(
        `Cron sync finalizado - totalRowsProcessed: ${result.totalRowsProcessed}, errors: ${result.totalErrors}, duration: ${duration}ms`
      );

      return {
        success: result.totalErrors === 0,
        executedAt: new Date().toISOString(),
        duration: `${duration}ms`,
        data: {
          batchId: result.batchId,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          screens: result.screens,
          totalRowsProcessed: result.totalRowsProcessed,
          totalErrors: result.totalErrors,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
      fastify.log.error(`Erro no cron sync: ${errorMessage}`);

      return reply.status(500).send({
        success: false,
        executedAt: new Date().toISOString(),
        error: errorMessage,
      });
    }
  });

  /**
   * GET /api/cron/sync/status
   * Retorna status da última sincronização (para monitoramento)
   */
  fastify.get('/sync/status', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const status = await getSyncStatus();

      return {
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
      fastify.log.error(`Erro ao buscar status do sync: ${errorMessage}`);

      return reply.status(500).send({
        success: false,
        error: errorMessage,
      });
    }
  });

  /**
   * GET /api/cron/health
   * Health check simples para monitoramento
   */
  fastify.get('/health', async () => {
    return {
      status: 'ok',
      service: 'cron-jobs',
      timestamp: new Date().toISOString(),
    };
  });
}
