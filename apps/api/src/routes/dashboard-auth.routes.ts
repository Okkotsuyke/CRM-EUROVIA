/**
 * Routes: Dashboard Auth
 *
 * Autenticação para o dashboard analítico (usuário avaliador)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { authenticateDashboard } from '../middleware/auth.middleware';
import { NeonAccessDenied, neonSignInDashboard, withNeonDashboardPrincipal } from '../services/neon-auth-bridge';


interface LoginBody {
  username: string;
  password: string;
}

export async function dashboardAuthRoutes(fastify: FastifyInstance) {
  if (process.env.CRM_NEON_STAGING_MODE === 'true') {
    fastify.post<{ Body: LoginBody }>('/login', {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const { username, password } = request.body || {};
      if (!username || !password) return reply.status(400).send({
        success: false, error: 'Credenciais obrigatorias',
      });
      const session = await neonSignInDashboard(fastify.prisma, username, password);
      if (!session) return reply.status(401).send({
        success: false, error: 'Credenciais invalidas',
      });
      return {
        success: true,
        data: {
          token: fastify.jwt.sign({ id: session.user_id, type: 'dashboard' }, { expiresIn: '30m' }),
          user: {
            id: session.user_id, username: session.user_name,
            name: session.display_name, role: session.user_role,
          },
          expiresIn: '30m',
        },
      };
    });

    fastify.get('/me', async (request, reply) => {
      let claims: unknown;
      try { claims = await request.jwtVerify(); }
      catch { return reply.status(401).send({ success: false, error: 'Unauthorized' }); }
      try {
        return await withNeonDashboardPrincipal(fastify.prisma, claims, async (_tx, actor) => ({
          success: true,
          data: {
            id: actor.id, username: actor.username, name: actor.name,
            role: actor.role, allowedStores: actor.allowedStores,
          },
        }));
      } catch (error) {
        if (error instanceof NeonAccessDenied) return reply.status(401).send({
          success: false, error: 'Unauthorized',
        });
        throw error;
      }
    });
    // Dashboard logout remains unavailable until JWT/session revocation is integrated.
    return;
  }



  /**
   * POST /api/v1/dashboard/auth/login
   * Login do usuário avaliador
   */
  fastify.post<{ Body: LoginBody }>('/login', async (request, reply) => {
    try {
      const { username, password } = request.body || {};

      if (!username || !password) {
        return reply.status(400).send({
          success: false,
          error: 'Username e senha são obrigatórios',
        });
      }

      // Buscar usuário no banco
      const user = await fastify.prisma.dashboardUser.findUnique({
        where: { username },
      });

      if (!user || !user.active) {
        return reply.status(401).send({
          success: false,
          error: 'Credenciais inválidas',
        });
      }

      // Verificar senha
      const isValid = await bcrypt.compare(password, user.passwordHash);
      if (!isValid) {
        return reply.status(401).send({
          success: false,
          error: 'Credenciais inválidas',
        });
      }

      // Gerar JWT
      const token = fastify.jwt.sign(
        {
          id: user.id,
          username: user.username,
          name: user.name,
          role: user.role,
          type: 'dashboard',
        },
        { expiresIn: '24h' }
      );

      return {
        success: true,
        data: {
          token,
          user: {
            id: user.id,
            username: user.username,
            name: user.name,
            role: user.role,
          },
          expiresIn: '24h',
        },
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Erro ao fazer login',
      });
    }
  });

  /**
   * GET /api/v1/dashboard/auth/me
   * Revalida usuario ativo, role e lojas no PostgreSQL (nunca pelo JWT).
   */
  fastify.get('/me', { onRequest: authenticateDashboard }, async (request) => {
    const user = request.dashboardUser;
    return {
      success: true,
      data: {
        id: user.id, username: user.username, name: user.name,
        role: user.role, allowedStores: user.allowedStores,
      },
    };
  });

  /**
   * POST /api/v1/dashboard/auth/logout
   * Logout (invalida token no frontend)
   */
  fastify.post('/logout', async (request, reply) => {
    return {
      success: true,
      message: 'Logout realizado com sucesso',
    };
  });
}

export default dashboardAuthRoutes;
