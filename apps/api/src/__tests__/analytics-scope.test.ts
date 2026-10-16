import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../plugins/sentry.plugin', () => ({
  default: (async () => {}) as any,
  __esModule: true,
}));

describe('analytics fail-closed sem consulta ao Syonet', () => {
  let app: FastifyInstance;
  let findUser: ReturnType<typeof vi.fn>;
  let rawQuery: ReturnType<typeof vi.fn>;
  let allowedStores: string[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'integration-test-secret-with-32-chars-abcdefgh';
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    const { buildApp } = await import('../app');
    app = await buildApp();
    findUser = vi.fn().mockImplementation(async () => ({
      id: 'evaluator', username: 'evaluator', name: 'Evaluator',
      role: 'VIEWER', active: true, allowedStores,
    }));
    rawQuery = vi.fn().mockResolvedValue([{ total_leads: 0, total_sales: 0,
      total_flow: 0, total_appointments: 0, stores_count: 0 }]);
    app.decorate('prisma', {
      dashboardUser: { findUnique: findUser },
      $queryRaw: rawQuery,
    } as any);
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function token() {
    return app.jwt.sign({ id: 'evaluator', type: 'dashboard', role: 'ADMIN', allowedStores: ['loja-de-outra-pessoa'] });
  }

  it('rejeita quando allowedStores real e vazio, mesmo com ADMIN falsificado no JWT', async () => {
    allowedStores = [];
    const response = await app.inject({
      method: 'GET', url: '/api/v1/analytics/overview',
      headers: { authorization: 'Bearer ' + token() },
    });
    expect(response.statusCode).toBe(403);
    expect(rawQuery).not.toHaveBeenCalled();
  });

  it('usa apenas allowedStores do banco como parametro de consulta SQL', async () => {
    allowedStores = ['loja-autorizada'];
    const response = await app.inject({
      method: 'GET', url: '/api/v1/analytics/overview',
      headers: { authorization: 'Bearer ' + token() },
    });
    expect(response.statusCode).toBe(200);
    expect(rawQuery).toHaveBeenCalledOnce();
    const args = rawQuery.mock.calls[0] ?? [];
    expect(JSON.stringify(args)).toContain('loja-autorizada');
    expect(JSON.stringify(args)).not.toContain('loja-de-outra-pessoa');
  });
});
