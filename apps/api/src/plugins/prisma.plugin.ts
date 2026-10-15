/**
 * Prisma plugin — adiciona prisma client ao fastify instance
 */
import fp from 'fastify-plugin';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { validateNeonStagingEnv } from '../services/neon-staging';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

async function prismaPluginInner(fastify: FastifyInstance) {
  // Em testes, pular conexão real — os mocks do vitest fornecem stubs
  if (process.env.NODE_ENV === 'test') {
    fastify.log.info('Prisma plugin skipped (test mode)');
    return;
  }

  // Never fall back to another project's database. In staging, the
  // project, branch, SQL role and region must be checked before connect.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL da API CRM EUROVIA nao configurada');
  }

  validateNeonStagingEnv(process.env);

  const prisma = new PrismaClient({
    log: process.env.NODE_ENV !== 'production' ? ['error', 'warn'] : ['error'],
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
  });

  await prisma.$connect();
  fastify.decorate('prisma', prisma);

  fastify.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
}

export const prismaPlugin = fp(prismaPluginInner, {
  name: 'prisma-plugin',
});
