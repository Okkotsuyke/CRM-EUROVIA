/**
 * Productivity routes — Página 2
 */
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { productivityService } from '../services/productivity.service';
import { authenticate } from '../middleware/auth.middleware';

const ProductivityFiltersSchema = z.object({
  consultantId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  plaza: z.string().optional(),
  status: z.string().optional(), // csv: "AGUARDANDO,ATRASADO"
  priority: z.string().optional(), // "true"
  date: z.string().optional(), // YYYY-MM-DD
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

export const productivityRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', authenticate);

  // GET /api/v1/productivity/consultants
  fastify.get('/consultants', async (request) => {
    const q = ProductivityFiltersSchema.parse(request.query);
    const filters = {
      consultantId: q.consultantId,
      storeId: q.storeId,
      plaza: q.plaza,
      status: q.status?.split(',').map(s => s.trim() as any),
      priority: q.priority === 'true',
      date: q.date,
    };
    return productivityService.getAllConsultantsPortfolio(fastify.prisma, filters, request.authUser);
  });

  // GET /api/v1/productivity/portfolio
  fastify.get('/portfolio', async (request, reply) => {
    const q = ProductivityFiltersSchema.parse(request.query);
    const userId = request.authUser.role === 'VL_CONSULTANT'
      ? request.authUser.id
      : (q.consultantId ?? request.authUser.id);

    const filters = {
      consultantId: q.consultantId,
      storeId: q.storeId,
      status: q.status?.split(',').map(s => s.trim() as any),
      priority: q.priority === 'true',
    };

    const [summary, leads] = await Promise.all([
      productivityService.getPortfolioSummary(fastify.prisma, userId, filters, request.authUser),
      productivityService.getPortfolioLeads(fastify.prisma, userId, filters, request.authUser),
    ]);

    return { summary, leads };
  });

  // GET /api/v1/productivity/today-agenda
  fastify.get('/today-agenda', async (request) => {
    const q = ProductivityFiltersSchema.parse(request.query);
    const filters = {
      consultantId: q.consultantId,
      storeId: q.storeId,
      date: q.date,
    };
    return productivityService.getTodayAgenda(fastify.prisma, request.authUser.id, filters, request.authUser);
  });
};
