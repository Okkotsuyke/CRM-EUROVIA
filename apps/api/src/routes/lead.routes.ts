/**
 * Routes: Leads
 *
 * Endpoints para gerenciamento de leads
 */

import { FastifyInstance } from 'fastify';
import { Prisma, LeadStatusNormalized } from '@prisma/client';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.middleware';
import { storeIdFilter } from '../services/store-scope';
import { attachAssignees } from '../services/lead-assignees';
import { withNeonOperationalPrincipal, NeonAccessDenied } from '../services/neon-auth-bridge';
import { neonLeadSelect, neonLeadDetailSelect } from '../services/neon-readonly-select';

// ── Zod Schemas para validação de input ────────────────────────────────
const querySchema = z.object({
  storeId: z.string().optional(),
  status: z.string().optional(),
  vlUserId: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});

const idParamSchema = z.object({
  id: z.string().uuid('ID inválido'),
});

const updateLeadBodySchema = z.object({
  statusNormalized: z.string().optional(),
  priorityFlag: z.boolean().optional(),
  assignedVlId: z.string().uuid().optional().nullable(),
  assignedVsId: z.string().uuid().optional().nullable(),
  assignedBdcId: z.string().uuid().optional().nullable(),
});

const createEventBodySchema = z.object({
  eventType: z.string().min(1).max(50),
  description: z.string().max(500).optional(),
});

const stagingEntityId = z.string().min(6).max(128).regex(/^[a-zA-Z0-9_-]+$/);

export async function leadRoutes(fastify: FastifyInstance) {

  if (process.env.CRM_NEON_STAGING_MODE === 'true') {
    // No Syonet calls. Every query must run inside the same authenticated
    // Prisma transaction that sets the actor's RLS context.
    fastify.get('/', async (request, reply) => {
      let claims: unknown;
      try { claims = await request.jwtVerify(); }
      catch { return reply.status(401).send({ success: false, error: 'Unauthorized' }); }
      const query = querySchema.parse(request.query);
      const limit = Math.min(Number(query.limit ?? '50'), 100);
      const offset = Math.min(Number(query.offset ?? '0'), 10000);
      if (limit < 1) return reply.status(400).send({ success: false, error: 'Invalid limit' });
      try {
        return await withNeonOperationalPrincipal(fastify.prisma, claims, async (tx, actor) => {
          const where: Prisma.LeadWhereInput = {
            storeId: storeIdFilter(actor, query.storeId ? [query.storeId] : undefined),
            ...(query.vlUserId ? { assignedVlId: query.vlUserId } : {}),
            ...(query.status ? { statusNormalized: query.status as LeadStatusNormalized } : {}),
            ...((query.startDate || query.endDate) ? {
              receivedAt: {
                ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
                ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
              },
            } : {}),
          };
          const rows = await tx.lead.findMany({
            where, select: neonLeadSelect,
            orderBy: { receivedAt: 'desc' },
            take: limit, skip: offset,
          });
          const total = await tx.lead.count({ where });
          const leads = await attachAssignees(tx, rows);
          return {
            success: true,
            data: { leads, total, limit, offset, hasMore: offset + rows.length < total },
          };
        });
      } catch (error) {
        if (error instanceof NeonAccessDenied) {
          return reply.status(401).send({ success: false, error: 'Unauthorized' });
        }
        throw error;
      }
    });

    fastify.get('/:id', async (request, reply) => {
      let claims: unknown;
      try { claims = await request.jwtVerify(); }
      catch { return reply.status(401).send({ success: false, error: 'Unauthorized' }); }
      const id = stagingEntityId.parse((request.params as { id?: string }).id);
      try {
        const found = await withNeonOperationalPrincipal(fastify.prisma, claims, async (tx, actor) => {
          const row = await tx.lead.findFirst({
            where: { id, storeId: storeIdFilter(actor) },
            select: neonLeadDetailSelect,
          });
          if (!row) return null;
          const enriched = await attachAssignees(tx, [row]);
          return enriched[0] ?? null;
        });
        if (!found) return reply.status(404).send({
          success: false, error: 'Lead não encontrado',
        });
        return { success: true, data: found };
      } catch (error) {
        if (error instanceof NeonAccessDenied) {
          return reply.status(401).send({ success: false, error: 'Unauthorized' });
        }
        throw error;
      }
    });
    // No mutations or statistics until every operation has RLS tests.
    return;
  }

  fastify.addHook('onRequest', authenticate);

  /**
   * GET /api/v1/leads
   * Lista leads com filtros
   */
  fastify.get('/', async (request, reply) => {
    try {
      const query = querySchema.parse(request.query);

      const where: any = {
        storeId: storeIdFilter(request.authUser),
      };

      if (query.storeId) {
        where.storeId = storeIdFilter(request.authUser, [query.storeId]);
      }
      if (query.vlUserId) where.assignedVlId = query.vlUserId;
      if (query.status) where.statusNormalized = query.status;

      if (query.startDate || query.endDate) {
        where.receivedAt = {};
        if (query.startDate) where.receivedAt.gte = new Date(query.startDate);
        if (query.endDate) where.receivedAt.lte = new Date(query.endDate);
      }

      const limit = Math.min(parseInt(query.limit || '50'), 200);
      const offset = parseInt(query.offset || '0');

      const [leads, total] = await Promise.all([
        fastify.prisma.lead.findMany({
          where,
          include: {
            store: true,
            mediaSource: true,
          },
          orderBy: { receivedAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        fastify.prisma.lead.count({ where }),
      ]);

      return {
        success: true,
        data: {
          leads: await attachAssignees(fastify.prisma, leads),
          total,
          limit,
          offset,
          hasMore: offset + leads.length < total,
        },
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao listar leads',
      });
    }
  });

  /**
   * GET /api/v1/leads/:id
   * Detalhes de um lead específico
   */
  fastify.get('/:id', async (request, reply) => {
    try {
      const { id } = idParamSchema.parse(request.params);

      const lead = await fastify.prisma.lead.findFirst({
        where: { id, storeId: storeIdFilter(request.authUser) },
        include: {
          store: true,
          mediaSource: true,
          leadEvents: {
            orderBy: { eventDate: 'desc' },
            include: {
              user: { select: { id: true, name: true, username: true } },
            },
          },
          appointments: {
            orderBy: { appointmentDate: 'desc' },
          },
          sale: true,
        },
      });

      if (!lead) {
        return reply.status(404).send({
          success: false,
          error: 'Lead não encontrado',
        });
      }

      const [leadWithAssignees] = await attachAssignees(fastify.prisma, [lead]);

      return {
        success: true,
        data: leadWithAssignees,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao buscar lead',
      });
    }
  });

  /**
   * PUT /api/v1/leads/:id
   * Atualiza um lead (apenas campos permitidos)
   */
  fastify.put('/:id',
    async (request, reply) => {
      try {
        const { id } = idParamSchema.parse(request.params);
        const body = updateLeadBodySchema.parse(request.body);
        const scope = storeIdFilter(request.authUser);
        const visible = await fastify.prisma.lead.findFirst({
          where: { id, storeId: scope },
          select: { id: true },
        });
        if (!visible) return reply.status(404).send({ success: false, error: 'Lead não encontrado' });

        // Campos que podem ser atualizados
        const updateData: any = {};
        if (body.statusNormalized !== undefined) {
          updateData.statusNormalized = body.statusNormalized;
          updateData.status = body.statusNormalized;
        }
        if (body.priorityFlag !== undefined) updateData.priorityFlag = body.priorityFlag;
        if (body.assignedVlId !== undefined) updateData.assignedVlId = body.assignedVlId;
        if (body.assignedVsId !== undefined) updateData.assignedVsId = body.assignedVsId;
        if (body.assignedBdcId !== undefined) updateData.assignedBdcId = body.assignedBdcId;

        const lead = await fastify.prisma.lead.update({
          // Filtro tambem na mutacao evita corrida apos a verificacao.
          where: { id, ...(scope ? { storeId: scope } : {}) },
          data: updateData,
          include: {
            store: true,
            mediaSource: true,
          },
        });

        // Registrar evento de atualização
        await fastify.prisma.leadEvent.create({
          data: {
            leadId: id,
            eventType: 'UPDATED',
            eventDate: new Date(),
            userId: request.authUser.id,
            description: `Lead atualizado por ${request.authUser.username}`,
          },
        });

        const [leadWithAssignees] = await attachAssignees(fastify.prisma, [lead]);

        return {
          success: true,
          data: leadWithAssignees,
        };
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: 'Erro ao atualizar lead',
        });
      }
    }
  );

  /**
   * POST /api/v1/leads/:id/events
   * Adiciona um evento ao histórico do lead
   */
  fastify.post('/:id/events',
    async (request, reply) => {
      try {
        const { id } = idParamSchema.parse(request.params);
        const body = createEventBodySchema.parse(request.body);
        const visible = await fastify.prisma.lead.findFirst({
          where: { id, storeId: storeIdFilter(request.authUser) },
          select: { id: true },
        });
        if (!visible) return reply.status(404).send({ success: false, error: 'Lead não encontrado' });

        const event = await fastify.prisma.leadEvent.create({
          data: {
            leadId: id,
            eventType: body.eventType,
            eventDate: new Date(),
            userId: request.authUser.id,
            description: body.description,
          },
          include: {
            user: { select: { id: true, name: true, username: true } },
          },
        });

        return reply.status(201).send({
          success: true,
          data: event,
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: 'Erro ao criar evento',
        });
      }
    }
  );

  /**
   * GET /api/v1/leads/stats/portfolio
   * Estatísticas de portfolio para VL
   */
  fastify.get('/stats/portfolio', async (request, reply) => {
    try {
      const userId = request.authUser.role === 'VL_CONSULTANT'
        ? request.authUser.id
        : (request.query as any).userId;

      if (!userId) {
        return reply.status(400).send({
          success: false,
          error: 'userId é obrigatório',
        });
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const [total, byStatus, todayAppointments] = await Promise.all([
        fastify.prisma.lead.count({ where: { assignedVlId: userId, storeId: storeIdFilter(request.authUser) } }),
        fastify.prisma.lead.groupBy({
          by: ['statusNormalized'],
          where: { assignedVlId: userId, storeId: storeIdFilter(request.authUser) },
          _count: true,
        }),
        fastify.prisma.appointment.count({
          where: {
            lead: { assignedVlId: userId },
            storeId: storeIdFilter(request.authUser),
            appointmentDate: {
              gte: today,
              lt: tomorrow,
            },
          },
        }),
      ]);

      const stats = {
        total,
        byStatus: byStatus.reduce((acc, item) => {
          acc[item.statusNormalized || 'SEM_STATUS'] = item._count;
          return acc;
        }, {} as Record<string, number>),
        todayAppointments,
        aguardando: byStatus.find(s => s.statusNormalized === 'AGUARDANDO')?._count || 0,
        atrasado: byStatus.find(s => s.statusNormalized === 'ATRASADO')?._count || 0,
        pendenteDia: byStatus.find(s => s.statusNormalized === 'PENDENTE_DIA')?._count || 0,
        futuro: byStatus.find(s => s.statusNormalized === 'FUTURO')?._count || 0,
        vendido: byStatus.find(s => s.statusNormalized === 'VENDIDO')?._count || 0,
      };

      return {
        success: true,
        data: stats,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao buscar estatísticas',
      });
    }
  });
}

export default leadRoutes;
