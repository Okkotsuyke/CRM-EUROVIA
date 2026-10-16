/**
 * Routes: Analytics Dashboard
 *
 * Endpoints para o dashboard analítico
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticateDashboard } from '../middleware/auth.middleware';
import { Prisma } from '@prisma/client';
import { withNeonDashboardPrincipal } from '../services/neon-auth-bridge';

// Railway reads MUST use the exact transaction client that received SET LOCAL
// ROLE and dashboard_actor_id. A standalone Prisma query bypasses that scope.
async function evaluatorRead<T>(
  fastify: FastifyInstance,
  request: FastifyRequest,
  read: (client: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (process.env.CRM_DEPLOY_TARGET !== 'railway') return read(fastify.prisma);
  // request.dashboardUser exists only after successful JWT verification and
  // revalidation against the active database principal in authenticateDashboard.
  return withNeonDashboardPrincipal(
    fastify.prisma,
    { id: request.dashboardUser.id, type: 'dashboard' },
    async (tx) => read(tx),
  );
}

export async function analyticsRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', authenticateDashboard);
  // allowedStores sempre vem do banco no middleware. [] nunca significa
  // acesso global, mesmo para ADMIN do modulo de avaliacao.
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.dashboardUser.allowedStores?.length) {
      return reply.status(403).send({
        success: false,
        error: 'Nenhuma loja autorizada para este avaliador',
      });
    }
    // There are no reconciled Syonet KPI rows in the production Neon DB.
    // Never present fabricated zeroes as real business indicators.
    if (process.env.CRM_DEPLOY_TARGET === 'railway' &&
        process.env.CRM_KPI_RECONCILED !== 'true') {
      return reply.status(503).send({
        success: false,
        error: 'Indicadores reais pendentes de reconciliacao com o Syonet',
      });
    }
  });

  /**
   * GET /api/v1/analytics/overview
   * KPIs estratégicos globais
   */
  fastify.get('/overview', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as any;
      const startDate = query.startDate ? new Date(query.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const endDate = query.endDate ? new Date(query.endDate) : new Date();

      // Query para métricas agregadas usando Prisma raw query
      const metrics = await evaluatorRead(fastify, request, db => db.$queryRaw<any[]>`
        SELECT
          COALESCE(SUM(sm.leads_total), 0) AS total_leads,
          COALESCE(SUM(sm.appointments_total), 0) AS total_appointments,
          COALESCE(SUM(sm.flow_total), 0) AS total_flow,
          COALESCE(SUM(sm.sales_total), 0) AS total_sales,
          COUNT(DISTINCT sm.store_id) AS stores_count
        FROM sync_metrics sm
        WHERE sm.extraction_date >= ${startDate}
          AND sm.extraction_date <= ${endDate}
          AND sm.store_id IN (${Prisma.join(request.dashboardUser.allowedStores)})
          AND sm.vl_user_id IS NULL
          AND sm.media_source_id IS NULL
      `);

      const data = metrics[0] || {};
      const totalLeads = Number(data.total_leads) || 0;
      const totalSales = Number(data.total_sales) || 0;
      const totalFlow = Number(data.total_flow) || 0;
      const totalAppointments = Number(data.total_appointments) || 0;

      return {
        success: true,
        data: {
          totalLeads,
          totalSales,
          totalFlow,
          totalAppointments,
          conversionRate: totalLeads > 0 ? Number(((totalSales / totalLeads) * 100).toFixed(2)) : 0,
          showRate: totalAppointments > 0 ? Number(((totalFlow / totalAppointments) * 100).toFixed(2)) : 0,
          storesCount: Number(data.stores_count) || 0,
        },
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao consultar overview',
      });
    }
  });

  /**
   * GET /api/v1/analytics/by-store
   * Métricas por loja
   */
  fastify.get('/by-store', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as any;
      const startDate = query.startDate ? new Date(query.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const endDate = query.endDate ? new Date(query.endDate) : new Date();

      // Query usando Prisma raw query
      const metrics = await evaluatorRead(fastify, request, db => db.$queryRaw<any[]>`
        SELECT
          s.id AS store_id,
          s."shortName" AS store_name,
          s.plaza,
          COALESCE(SUM(sm.leads_total), 0)::int AS total_leads,
          COALESCE(SUM(sm.appointments_total), 0)::int AS total_appointments,
          COALESCE(SUM(sm.flow_total), 0)::int AS total_flow,
          COALESCE(SUM(sm.sales_total), 0)::int AS total_sales
        FROM sync_metrics sm
        JOIN stores s ON sm.store_id = s.id
        WHERE sm.extraction_date >= ${startDate}
          AND sm.extraction_date <= ${endDate}
          AND sm.store_id IN (${Prisma.join(request.dashboardUser.allowedStores)})
          AND sm.vl_user_id IS NULL
          AND sm.media_source_id IS NULL
        GROUP BY s.id, s."shortName", s.plaza
        ORDER BY s."shortName"
      `);

      const result = metrics.map(m => ({
        storeId: m.store_id,
        storeName: m.store_name,
        plaza: m.plaza,
        leads: Number(m.total_leads),
        appointments: Number(m.total_appointments),
        flow: Number(m.total_flow),
        sales: Number(m.total_sales),
        conversionRate: Number(m.total_leads) > 0
          ? Number(((Number(m.total_sales) / Number(m.total_leads)) * 100).toFixed(2))
          : 0,
        showRate: Number(m.total_appointments) > 0
          ? Number(((Number(m.total_flow) / Number(m.total_appointments)) * 100).toFixed(2))
          : 0,
      }));

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao consultar métricas por loja',
      });
    }
  });

  /**
   * GET /api/v1/analytics/by-vl
   * Performance dos consultores VL
   */
  fastify.get('/by-vl', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as any;
      const startDate = query.startDate ? new Date(query.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const endDate = query.endDate ? new Date(query.endDate) : new Date();

      const metrics = await evaluatorRead(fastify, request, db => db.$queryRaw<any[]>`
        SELECT
          u.id AS vl_id,
          u.name AS vl_name,
          u.username,
          s."shortName" AS store_name,
          COALESCE(SUM(sm.leads_total), 0)::int AS total_leads,
          COALESCE(SUM(sm.leads_to_vs), 0)::int AS leads_to_vs,
          COALESCE(SUM(sm.appointments_total), 0)::int AS total_appointments,
          COALESCE(SUM(sm.flow_total), 0)::int AS total_flow,
          COALESCE(SUM(sm.sales_total), 0)::int AS total_sales
        FROM sync_metrics sm
        JOIN users u ON sm.vl_user_id = u.id
        JOIN stores s ON sm.store_id = s.id
        WHERE sm.extraction_date >= ${startDate}
          AND sm.extraction_date <= ${endDate}
          AND sm.store_id IN (${Prisma.join(request.dashboardUser.allowedStores)})
          AND sm.vl_user_id IS NOT NULL
          AND u.role = 'VL_CONSULTANT'
        GROUP BY u.id, u.name, u.username, s."shortName"
        ORDER BY total_leads DESC
      `);

      const result = metrics.map(m => ({
        vlId: m.vl_id,
        vlName: m.vl_name,
        username: m.username,
        storeName: m.store_name,
        leads: Number(m.total_leads),
        leadsToVs: Number(m.leads_to_vs),
        appointments: Number(m.total_appointments),
        flow: Number(m.total_flow),
        sales: Number(m.total_sales),
        conversionRate: Number(m.total_leads) > 0
          ? Number(((Number(m.total_sales) / Number(m.total_leads)) * 100).toFixed(2))
          : 0,
        appointmentRate: Number(m.total_leads) > 0
          ? Number(((Number(m.total_appointments) / Number(m.total_leads)) * 100).toFixed(2))
          : 0,
      }));

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao consultar métricas por VL',
      });
    }
  });

  /**
   * GET /api/v1/analytics/by-media
   * Métricas por mídia normalizada
   */
  fastify.get('/by-media', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as any;
      const startDate = query.startDate ? new Date(query.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const endDate = query.endDate ? new Date(query.endDate) : new Date();

      const metrics = await evaluatorRead(fastify, request, db => db.$queryRaw<any[]>`
        SELECT
          ms."normalizedName" AS media_name,
          ms.category,
          COALESCE(SUM(sm.leads_total), 0)::int AS total_leads,
          COALESCE(SUM(sm.sales_total), 0)::int AS total_sales
        FROM sync_metrics sm
        JOIN media_sources ms ON sm.media_source_id = ms.id
        WHERE sm.extraction_date >= ${startDate}
          AND sm.extraction_date <= ${endDate}
          AND sm.store_id IN (${Prisma.join(request.dashboardUser.allowedStores)})
          AND sm.media_source_id IS NOT NULL
          AND sm.vl_user_id IS NULL
        GROUP BY ms."normalizedName", ms.category
        ORDER BY total_leads DESC
      `);

      const result = metrics.map(m => ({
        mediaName: m.media_name,
        category: m.category,
        leads: Number(m.total_leads),
        sales: Number(m.total_sales),
        conversionRate: Number(m.total_leads) > 0
          ? Number(((Number(m.total_sales) / Number(m.total_leads)) * 100).toFixed(2))
          : 0,
      }));

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao consultar métricas por mídia',
      });
    }
  });

  /**
   * GET /api/v1/analytics/trend
   * Tendência temporal (últimos 30 dias)
   */
  fastify.get('/trend', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as any;
      const days = parseInt(query.days) || 30;
      const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const metrics = await evaluatorRead(fastify, request, db => db.$queryRaw<any[]>`
        SELECT
          sm.extraction_date AS date,
          COALESCE(SUM(sm.leads_total), 0)::int AS total_leads,
          COALESCE(SUM(sm.appointments_total), 0)::int AS total_appointments,
          COALESCE(SUM(sm.flow_total), 0)::int AS total_flow,
          COALESCE(SUM(sm.sales_total), 0)::int AS total_sales
        FROM sync_metrics sm
        WHERE sm.extraction_date >= ${startDate}
          AND sm.store_id IN (${Prisma.join(request.dashboardUser.allowedStores)})
          AND sm.vl_user_id IS NULL
          AND sm.media_source_id IS NULL
        GROUP BY sm.extraction_date
        ORDER BY sm.extraction_date ASC
      `);

      return {
        success: true,
        data: metrics.map(m => ({
          date: m.date,
          leads: Number(m.total_leads),
          appointments: Number(m.total_appointments),
          flow: Number(m.total_flow),
          sales: Number(m.total_sales),
          conversionRate: Number(m.total_leads) > 0
            ? Number(((Number(m.total_sales) / Number(m.total_leads)) * 100).toFixed(2))
            : 0,
        })),
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao consultar tendência',
      });
    }
  });

  /**
   * GET /api/v1/analytics/productivity
   * Produtividade em tempo real dos VLs
   */
  fastify.get('/productivity', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as any;
      const date = query.date ? new Date(query.date) : new Date();
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);

      const snapshots = await evaluatorRead(fastify, request, db => db.productivitySnapshot.findMany({
        where: {
          storeId: { in: request.dashboardUser.allowedStores },
          periodStart: {
            gte: startOfDay,
            lte: endOfDay,
          },
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              username: true,
              role: true,
              store: {
                select: {
                  id: true,
                  shortName: true,
                  plaza: true,
                },
              },
            },
          },
        },
        orderBy: {
          salesCount: 'desc',
        },
      }));

      // Filtrar apenas VLs
      const vlSnapshots = snapshots.filter(s => s.user.role === 'VL_CONSULTANT');

      const result = vlSnapshots.map(s => ({
        vlId: s.user.id,
        vlName: s.user.name,
        username: s.user.username,
        storeName: s.user.store?.shortName,
        plaza: s.user.store?.plaza,
        // Carteira
        leadsWaiting: s.waitingCount,
        leadsLate: s.lateCount,
        leadsPendingToday: s.pendingTodayCount,
        leadsFuture: s.futureCount,
        leadsTotal: s.leadsXVendedorLoja + s.leadsXOperadorBdc,
        // Performance do dia
        appointmentsToday: s.appointmentsCount,
        confirmedVisits: s.confirmedVisits,
        salesSuccess: s.salesCount,
        // Métricas de qualidade
        averageContactMinutes: s.averageContactMinutes,
        priorityClients: s.priorityClients,
        forwardedToVs: s.leadsXOperadorBdc,
        // Timestamp
        syncedAt: s.syncedAt,
      }));

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao consultar produtividade',
      });
    }
  });
}

export default analyticsRoutes;
