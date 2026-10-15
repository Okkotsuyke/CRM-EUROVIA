/**
 * Store routes
 */
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Plaza } from '@prisma/client';
import { authenticate } from '../middleware/auth.middleware';
import { storeIdFilter } from '../services/store-scope';

export const storeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', authenticate);

  // GET /api/v1/stores
  fastify.get('/', async (request) => {
    const { plaza, active } = request.query as { plaza?: Plaza; active?: string };

    const stores = await fastify.prisma.store.findMany({
      where: {
        ...(plaza ? { plaza } : {}),
        ...(active !== undefined ? { active: active === 'true' } : {}),
        id: storeIdFilter(request.authUser),
      },
      orderBy: { plaza: 'asc' },
    });

    return stores.map(s => ({
      id: s.id,
      shortName: s.shortName,
      syonetName: s.syonetName,
      plaza: s.plaza,
      city: s.city,
      state: s.state,
      timezone: s.timezone,
      active: s.active,
    }));
  });

  // GET /api/v1/stores/:id
  fastify.get('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const store = await fastify.prisma.store.findFirst({
      where: { id: request.params.id, id: storeIdFilter(request.authUser) ? { in: storeIdFilter(request.authUser)!.in.filter(id => id === request.params.id) } : request.params.id },
    });
    if (!store) return reply.status(404).send({ statusCode: 404, message: 'Store not found' });
    return store;
  });
};
