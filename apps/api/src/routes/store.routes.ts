/**
 * Store routes
 */
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { Plaza } from '@prisma/client';
import { authenticate } from '../middleware/auth.middleware';
import { storeIdFilter, canAccessStore } from '../services/store-scope';
import { NeonAccessDenied, withNeonOperationalPrincipal } from '../services/neon-auth-bridge';

export const storeRoutes: FastifyPluginAsync = async (fastify) => {
  if (process.env.CRM_NEON_STAGING_MODE === 'true') {
    fastify.get('/', async (request, reply) => {
      let claims: unknown;
      try { claims = await request.jwtVerify(); }
      catch { return reply.status(401).send({ statusCode: 401, error: 'Unauthorized' }); }
      const { plaza, active } = request.query as { plaza?: Plaza; active?: string };
      try {
        return await withNeonOperationalPrincipal(fastify.prisma, claims, async (tx, user) => {
          const rows = await tx.store.findMany({
            where: {
              ...(plaza ? { plaza } : {}),
              ...(active !== undefined ? { active: active === 'true' } : {}),
              id: storeIdFilter(user),
            },
            select: {
              id: true, shortName: true, syonetName: true, plaza: true,
              city: true, state: true, timezone: true, active: true,
            },
            orderBy: { plaza: 'asc' },
          });
          return rows;
        });
      } catch (error) {
        if (error instanceof NeonAccessDenied) return reply.status(401).send({
          statusCode: 401, error: 'Unauthorized',
        });
        throw error;
      }
    });

    fastify.get('/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      let claims: unknown;
      try { claims = await request.jwtVerify(); }
      catch { return reply.status(401).send({ statusCode: 401, error: 'Unauthorized' }); }
      try {
        const row = await withNeonOperationalPrincipal(fastify.prisma, claims, async (tx, user) => {
          if (!canAccessStore(user, request.params.id)) return null;
          return tx.store.findFirst({
            where: { id: request.params.id, id: storeIdFilter(user) },
            select: {
              id: true, shortName: true, syonetName: true, plaza: true,
              city: true, state: true, timezone: true, active: true,
            },
          });
        });
        if (!row) return reply.status(404).send({
          statusCode: 404, message: 'Store not found',
        });
        return row;
      } catch (error) {
        if (error instanceof NeonAccessDenied) return reply.status(401).send({
          statusCode: 401, error: 'Unauthorized',
        });
        throw error;
      }
    });
    return;
  }


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
    // Verifica escopo antes da consulta por ID; lojas nao autorizadas
    // sao indistinguiveis de lojas inexistentes.
    if (!canAccessStore(request.authUser, request.params.id)) {
      return reply.status(404).send({ statusCode: 404, message: 'Store not found' });
    }
    const store = await fastify.prisma.store.findUnique({
      where: { id: request.params.id },
    });
    if (!store) return reply.status(404).send({ statusCode: 404, message: 'Store not found' });
    return store;
  });
};
