/**
 * Routes: Appointments
 *
 * Endpoints para gerenciamento de agendamentos
 */

import { FastifyInstance } from 'fastify';
import { Prisma, AppointmentStatus } from '@prisma/client';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.middleware';
import { storeIdFilter } from '../services/store-scope';
import { attachLeadAssignees } from '../services/lead-assignees';
import { withNeonOperationalPrincipal, NeonAccessDenied } from '../services/neon-auth-bridge';
import { neonAppointmentSelect } from '../services/neon-readonly-select';

const stagingEntityId = z.string().min(6).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const appointmentReadQuery = z.object({
  storeId: z.string().max(128).optional(),
  vlUserId: z.string().max(128).optional(),
  status: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});

export async function appointmentRoutes(fastify: FastifyInstance) {

  if (process.env.CRM_NEON_STAGING_MODE === 'true') {
    fastify.get('/', async (request, reply) => {
      let claims: unknown;
      try { claims = await request.jwtVerify(); }
      catch { return reply.status(401).send({ success: false, error: 'Unauthorized' }); }
      const query = appointmentReadQuery.parse(request.query);
      const limit = Math.min(Number(query.limit ?? '50'), 100);
      const offset = Math.min(Number(query.offset ?? '0'), 10000);
      if (limit < 1) return reply.status(400).send({ success: false, error: 'Invalid limit' });
      try {
        return await withNeonOperationalPrincipal(fastify.prisma, claims, async (tx, actor) => {
          const where: Prisma.AppointmentWhereInput = {
            storeId: storeIdFilter(actor, query.storeId ? [query.storeId] : undefined),
            ...(query.vlUserId ? { lead: { assignedVlId: query.vlUserId } } : {}),
            ...(query.status ? { status: query.status as AppointmentStatus } : {}),
            ...((query.startDate || query.endDate) ? {
              appointmentDate: {
                ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
                ...(query.endDate ? { lte: new Date(query.endDate) } : {}),
              },
            } : {}),
          };
          const rows = await tx.appointment.findMany({
            where, select: neonAppointmentSelect,
            orderBy: { appointmentDate: 'asc' },
            take: limit, skip: offset,
          });
          const total = await tx.appointment.count({ where });
          const appointments = await attachLeadAssignees(tx, rows);
          return {
            success: true,
            data: { appointments, total, limit, offset, hasMore: offset + rows.length < total },
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
          const row = await tx.appointment.findFirst({
            where: { id, storeId: storeIdFilter(actor) },
            select: neonAppointmentSelect,
          });
          if (!row) return null;
          const enriched = await attachLeadAssignees(tx, [row]);
          return enriched[0] ?? null;
        });
        if (!found) return reply.status(404).send({
          success: false, error: 'Agendamento não encontrado',
        });
        return { success: true, data: found };
      } catch (error) {
        if (error instanceof NeonAccessDenied) {
          return reply.status(401).send({ success: false, error: 'Unauthorized' });
        }
        throw error;
      }
    });
    // POST, PUT and DELETE are intentionally unavailable in staging.
    return;
  }

  fastify.addHook('onRequest', authenticate);

  /**
   * GET /api/v1/appointments
   * Lista agendamentos com filtros
   */
  fastify.get('/', async (request, reply) => {
    try {
      const query = request.query as {
        storeId?: string;
        vlUserId?: string;
        status?: string;
        startDate?: string;
        endDate?: string;
        limit?: string;
        offset?: string;
      };

      const where: any = {
        storeId: storeIdFilter(request.authUser),
      };
      if (query.storeId) {
        where.storeId = storeIdFilter(request.authUser, [query.storeId]);
      }
      if (query.vlUserId) where.lead = { assignedVlId: query.vlUserId };
      if (query.status) where.status = query.status;

      if (query.startDate || query.endDate) {
        where.appointmentDate = {};
        if (query.startDate) where.appointmentDate.gte = new Date(query.startDate);
        if (query.endDate) where.appointmentDate.lte = new Date(query.endDate);
      }

      const limit = Math.min(parseInt(query.limit || '50'), 200);
      const offset = parseInt(query.offset || '0');

      const [appointments, total] = await Promise.all([
        fastify.prisma.appointment.findMany({
          where,
          include: {
            lead: {
              select: {
                id: true,
                syonetLeadId: true,
                status: true,
                assignedVlId: true,
                assignedVsId: true,
              },
            },
            store: true,
            createdByUser: { select: { id: true, name: true, username: true } },
          },
          orderBy: { appointmentDate: 'asc' },
          take: limit,
          skip: offset,
        }),
        fastify.prisma.appointment.count({ where }),
      ]);

      return {
        success: true,
        data: {
          appointments: await attachLeadAssignees(fastify.prisma, appointments),
          total,
          limit,
          offset,
          hasMore: offset + appointments.length < total,
        },
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao listar agendamentos',
      });
    }
  });

  /**
   * GET /api/v1/appointments/:id
   * Detalhes de um agendamento
   */
  fastify.get('/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const appointment = await fastify.prisma.appointment.findFirst({
        where: { id, storeId: storeIdFilter(request.authUser) },
        include: {
          lead: {
            include: {
              store: true,
              mediaSource: true,
            },
          },
          store: true,
          createdByUser: { select: { id: true, name: true, username: true } },
        },
      });

      if (!appointment) {
        return reply.status(404).send({
          success: false,
          error: 'Agendamento não encontrado',
        });
      }

      const [appointmentWithAssignees] = await attachLeadAssignees(fastify.prisma, [appointment]);

      return {
        success: true,
        data: appointmentWithAssignees,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao buscar agendamento',
      });
    }
  });

  /**
   * POST /api/v1/appointments
   * Cria um novo agendamento
   */
  fastify.post('/',
    async (request, reply) => {
      try {
        const body = request.body as {
          leadId: string;
          appointmentDate: string;
          confirmedFlag?: boolean;
          storeId?: string;
        };

        if (!body.leadId || !body.appointmentDate) {
          return reply.status(400).send({
            success: false,
            error: 'leadId e appointmentDate são obrigatórios',
          });
        }

        // Fonte da loja e sempre o lead autorizado, nao um parametro arbitrario.
        const lead = await fastify.prisma.lead.findFirst({
          where: { id: body.leadId, storeId: storeIdFilter(request.authUser) },
          select: { storeId: true },
        });
        if (!lead) return reply.status(404).send({
          success: false, error: 'Lead não encontrado',
        });
        if (body.storeId && body.storeId !== lead.storeId) {
          return reply.status(400).send({
            success: false, error: 'Loja do agendamento diferente da loja do lead',
          });
        }
        const storeId = lead.storeId;

        const appointment = await fastify.prisma.appointment.create({
          data: {
            leadId: body.leadId,
            storeId,
            appointmentDate: new Date(body.appointmentDate),
            confirmedFlag: body.confirmedFlag ?? false,
            status: 'SCHEDULED',
            createdByUserId: request.authUser.id,
          },
          include: {
            lead: {
              select: {
                id: true,
                syonetLeadId: true,
                assignedVlId: true,
                assignedVsId: true,
              },
            },
            store: true,
          },
        });

        // Registrar evento no lead
        await fastify.prisma.leadEvent.create({
          data: {
            leadId: body.leadId,
            eventType: 'APPOINTMENT',
            eventDate: new Date(),
            userId: request.authUser.id,
            description: `Agendamento criado para ${new Date(body.appointmentDate).toLocaleString('pt-BR')}`,
          },
        });

        const [appointmentWithAssignees] = await attachLeadAssignees(fastify.prisma, [appointment]);

        return reply.status(201).send({
          success: true,
          data: appointmentWithAssignees,
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: 'Erro ao criar agendamento',
        });
      }
    }
  );

  /**
   * PUT /api/v1/appointments/:id
   * Atualiza um agendamento (status, confirmação)
   */
  fastify.put('/:id',
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = request.body as {
          status?: string;
          confirmedFlag?: boolean;
          appointmentDate?: string;
        };

        const scope = storeIdFilter(request.authUser);
        const visible = await fastify.prisma.appointment.findFirst({
          where: { id, storeId: scope },
          select: { id: true, leadId: true },
        });
        if (!visible) return reply.status(404).send({
          success: false, error: 'Agendamento não encontrado',
        });

        const updateData: any = {};

        if (body.status) {
          updateData.status = body.status;

          // Se completado, registrar no lead
          if (body.status === 'COMPLETED') {
            const apt = await fastify.prisma.appointment.findUnique({
              where: { id },
              select: { leadId: true },
            });
            if (apt) {
              await fastify.prisma.leadEvent.create({
                data: {
                  leadId: apt.leadId,
                  eventType: 'FLOW',
                  eventDate: new Date(),
                  userId: request.authUser.id,
                  description: 'Cliente compareceu ao agendamento',
                },
              });
            }
          }

          // Se não compareceu
          if (body.status === 'NO_SHOW') {
            const apt = await fastify.prisma.appointment.findUnique({
              where: { id },
              select: { leadId: true },
            });
            if (apt) {
              await fastify.prisma.leadEvent.create({
                data: {
                  leadId: apt.leadId,
                  eventType: 'NO_SHOW',
                  eventDate: new Date(),
                  userId: request.authUser.id,
                  description: 'Cliente não compareceu ao agendamento',
                },
              });
            }
          }
        }

        if (body.confirmedFlag !== undefined) updateData.confirmedFlag = body.confirmedFlag;
        if (body.appointmentDate) updateData.appointmentDate = new Date(body.appointmentDate);

        const appointment = await fastify.prisma.appointment.update({
          where: { id, ...(scope ? { storeId: scope } : {}) },
          data: updateData,
          include: {
            lead: {
              select: {
                id: true,
                syonetLeadId: true,
                assignedVlId: true,
                assignedVsId: true,
              },
            },
            store: true,
          },
        });

        const [appointmentWithAssignees] = await attachLeadAssignees(fastify.prisma, [appointment]);

        return {
          success: true,
          data: appointmentWithAssignees,
        };
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: 'Erro ao atualizar agendamento',
        });
      }
    }
  );

  /**
   * DELETE /api/v1/appointments/:id
   * Cancela um agendamento
   */
  fastify.delete('/:id',
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };

        // Cancelamento no CRM Eurovia apenas; nunca no Syonet.
        const scope = storeIdFilter(request.authUser);
        const visible = await fastify.prisma.appointment.findFirst({
          where: { id, storeId: scope },
          select: { id: true },
        });
        if (!visible) return reply.status(404).send({
          success: false, error: 'Agendamento não encontrado',
        });
        const appointment = await fastify.prisma.appointment.update({
          where: { id, ...(scope ? { storeId: scope } : {}) },
          data: { status: 'CANCELLED' },
        });

        // Registrar cancelamento no lead
        await fastify.prisma.leadEvent.create({
          data: {
            leadId: appointment.leadId,
            eventType: 'CANCELLED',
            eventDate: new Date(),
            userId: request.authUser.id,
            description: 'Agendamento cancelado',
          },
        });

        return {
          success: true,
          data: appointment,
        };
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: 'Erro ao cancelar agendamento',
        });
      }
    }
  );

  /**
   * GET /api/v1/appointments/today
   * Agendamentos do dia para o VL logado
   */
  fastify.get('/calendar/today', async (request, reply) => {
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

      const appointments = await fastify.prisma.appointment.findMany({
        where: {
          lead: { assignedVlId: userId },
          storeId: storeIdFilter(request.authUser),
          appointmentDate: {
            gte: today,
            lt: tomorrow,
          },
          status: { notIn: ['CANCELLED'] },
        },
        include: {
          lead: {
            select: {
              id: true,
              syonetLeadId: true,
              status: true,
              priorityFlag: true,
              mediaSource: { select: { normalizedName: true } },
              assignedVlId: true,
              assignedVsId: true,
            },
          },
          store: { select: { shortName: true } },
        },
        orderBy: { appointmentDate: 'asc' },
      }).then(rows => attachLeadAssignees(fastify.prisma, rows));

      return {
        success: true,
        data: {
          date: today.toISOString().split('T')[0],
          appointments,
          stats: {
            total: appointments.length,
            confirmed: appointments.filter(a => a.confirmedFlag).length,
            pending: appointments.filter(a => !a.confirmedFlag).length,
            completed: appointments.filter(a => a.status === 'COMPLETED').length,
            noShow: appointments.filter(a => a.status === 'NO_SHOW').length,
          },
        },
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao buscar agendamentos',
      });
    }
  });
}

export default appointmentRoutes;
