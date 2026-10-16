/**
 * Auth routes — login, refresh, logout
 */
import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import {
  NeonAccessDenied, neonSignInUser, neonRefreshUser,
  neonLogoutUser, withNeonOperationalPrincipal,
} from '../services/neon-auth-bridge';

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  if (process.env.CRM_NEON_STAGING_MODE === 'true') {
    // Auth SQL functions use SECURITY DEFINER with narrow results.
    // Only synthetic staging accounts exist; no direct password SELECT.
    fastify.post('/login', {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const body = LoginSchema.parse(request.body);
      const session = await neonSignInUser(fastify.prisma, body.username, body.password);
      if (!session) return reply.status(401).send({
        statusCode: 401, message: 'Invalid credentials', error: 'Unauthorized',
      });
      return {
        accessToken: fastify.jwt.sign({ id: session.user_id }, { expiresIn: '15m' }),
        refreshToken: session.refresh_token,
        user: {
          id: session.user_id,
          name: session.display_name,
          username: session.user_name,
          email: session.email,
          role: session.user_role,
          storeId: session.store_id,
        },
      };
    });

    fastify.post('/refresh', {
      config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const body = z.object({
        refreshToken: z.string().regex(/^[a-f0-9]{64}$/),
      }).parse(request.body);
      const session = await neonRefreshUser(fastify.prisma, body.refreshToken);
      if (!session) return reply.status(401).send({
        statusCode: 401, message: 'Invalid refresh token', error: 'Unauthorized',
      });
      // Refresh tokens are single-use and rotated in the SAME DB transaction.
      return {
        accessToken: fastify.jwt.sign({ id: session.user_id }, { expiresIn: '15m' }),
        refreshToken: session.refresh_token,
      };
    });

    fastify.post('/logout', async request => {
      const body = z.object({
        refreshToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      }).parse(request.body || {});
      if (body.refreshToken) await neonLogoutUser(fastify.prisma, body.refreshToken);
      return { message: 'Logged out successfully' };
    });

    fastify.get('/me', async (request, reply) => {
      let claims: unknown;
      try { claims = await request.jwtVerify(); }
      catch { return reply.status(401).send({ statusCode: 401, error: 'Unauthorized' }); }
      try {
        return await withNeonOperationalPrincipal(fastify.prisma, claims, async (tx, user) => {
          // User and store are read within the SAME SET LOCAL RLS transaction.
          const store = user.storeId ? await tx.store.findFirst({
            where: { id: user.storeId },
            select: { id: true, shortName: true, plaza: true },
          }) : null;
          return {
            id: user.id, name: user.name, username: user.username,
            email: user.email, role: user.role, storeId: user.storeId, store,
          };
        });
      } catch (error) {
        if (error instanceof NeonAccessDenied) return reply.status(401).send({
          statusCode: 401, error: 'Unauthorized',
        });
        throw error;
      }
    });
    return;
  }


  // POST /api/v1/auth/login
  // Rate limit específico: 5 tentativas por minuto (proteção brute force)
  fastify.post('/login', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    const body = LoginSchema.parse(request.body);

    const user = await fastify.prisma.user.findFirst({
      where: { username: body.username, active: true },
    });

    if (!user) {
      return reply.status(401).send({ statusCode: 401, message: 'Invalid credentials', error: 'Unauthorized' });
    }

    const valid = await bcrypt.compare(body.password, user.password);
    if (!valid) {
      return reply.status(401).send({ statusCode: 401, message: 'Invalid credentials', error: 'Unauthorized' });
    }

    const accessToken = fastify.jwt.sign(
      { id: user.id, username: user.username, role: user.role, storeId: user.storeId },
      { expiresIn: process.env.JWT_EXPIRES_IN ?? '7d' },
    );

    const refreshToken = fastify.jwt.sign(
      { id: user.id, type: 'refresh' },
      { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '30d' },
    );

    // Armazenar refresh token no banco
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    await fastify.prisma.refreshToken.create({
      data: { token: refreshToken, userId: user.id, expiresAt },
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        role: user.role,
        storeId: user.storeId,
      },
    };
  });

  // POST /api/v1/auth/refresh
  fastify.post('/refresh', async (request, reply) => {
    const { refreshToken } = request.body as { refreshToken: string };

    const storedToken = await fastify.prisma.refreshToken.findUnique({ where: { token: refreshToken } });
    if (!storedToken || storedToken.expiresAt < new Date()) {
      return reply.status(401).send({ statusCode: 401, message: 'Invalid refresh token', error: 'Unauthorized' });
    }

    const user = await fastify.prisma.user.findUnique({
      where: { id: storedToken.userId, active: true },
    });
    if (!user) {
      return reply.status(401).send({ statusCode: 401, message: 'User not found', error: 'Unauthorized' });
    }

    const newAccessToken = fastify.jwt.sign(
      { id: user.id, username: user.username, role: user.role, storeId: user.storeId },
      { expiresIn: process.env.JWT_EXPIRES_IN ?? '7d' },
    );

    return { accessToken: newAccessToken };
  });

  // POST /api/v1/auth/logout
  fastify.post('/logout', async (request, reply) => {
    const { refreshToken } = request.body as { refreshToken?: string };
    if (refreshToken) {
      await fastify.prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
    }
    return { message: 'Logged out successfully' };
  });

  // GET /api/v1/auth/me
  fastify.get('/me', { onRequest: [(fastify as any).authenticate] as any }, async (request) => {
    const user = await fastify.prisma.user.findUnique({
      where: { id: request.authUser.id },
      include: { store: true },
    });
    if (!user) throw { statusCode: 404, message: 'User not found' };
    return {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: user.role,
      storeId: user.storeId,
      store: user.store,
    };
  });
};
