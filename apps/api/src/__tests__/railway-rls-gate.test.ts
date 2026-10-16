import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../plugins/sentry.plugin', () => ({
  default: (async () => {}) as any,
  __esModule: true,
}));

describe('Railway production evaluator: fail-closed transactional RLS', () => {
  let app: FastifyInstance;
  const privilegedDashboardLookup = vi.fn();
  const txSetRole = vi.fn().mockResolvedValue(0);
  const txQuery = vi.fn().mockImplementation(async (sql: unknown) => {
    const text = JSON.stringify(sql);
    if (text.includes('crm_security.login_dashboard')) return [];
    if (text.includes('set_config')) return [{ set_config: 'dashboard-avaliador-eurovia' }];
    return [{
      total_leads: 0, total_appointments: 0,
      total_flow: 0, total_sales: 0, stores_count: 0,
    }];
  });
  const scopedLookup = vi.fn().mockResolvedValue({
    id: 'dashboard-avaliador-eurovia',
    username: 'AVALIADOR.EUROVIA',
    name: 'Avaliador',
    role: 'ADMIN',
    active: true,
    allowedStores: ['store-authorized'],
  });
  const tx = {
    $executeRawUnsafe: txSetRole,
    $queryRaw: txQuery,
    dashboardUser: { findUnique: scopedLookup },
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.CRM_DEPLOY_TARGET = 'railway';
    process.env.CRM_NEON_STAGING_MODE = 'false';
    process.env.CRM_EUROVIA_PRODUCTION_READONLY = 'true';
    process.env.CRM_KPI_RECONCILED = 'false';
    process.env.SYNC_ENABLED = 'false';
    process.env.SYONET_USE_REAL = 'false';
    process.env.JWT_SECRET = 'railway-test-secret-longer-than-32-characters';
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.CRM_ALLOWED_ORIGINS = 'https://example.invalid';
    const { buildApp } = await import('../app');
    app = await buildApp();
    app.decorate('prisma', {
      dashboardUser: { findUnique: privilegedDashboardLookup },
      $queryRaw: vi.fn().mockResolvedValue([{ one: 1 }]),
      $transaction: vi.fn(async (fn: (transaction: unknown) => unknown) => fn(tx)),
    } as any);
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    for (const key of [
      'CRM_DEPLOY_TARGET', 'CRM_EUROVIA_PRODUCTION_READONLY', 'CRM_KPI_RECONCILED',
      'CRM_NEON_STAGING_MODE', 'SYNC_ENABLED', 'SYONET_USE_REAL',
    ]) delete process.env[key];
  });

  function authorizedToken() {
    return app.jwt.sign({ id: 'dashboard-avaliador-eurovia', type: 'dashboard' });
  }

  it('blocks operational routes, including synchronization, before auth or any Syonet calls', async () => {
    for (const path of ['/api/v1/syonet-sync/run', '/api/v1/auth/login']) {
      const response = await app.inject({ method: 'POST', url: path, payload: {} });
      expect(response.statusCode).toBe(503);
    }
  });

  it('serves health through the private API and refuses unauthenticated analytics', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().integrations.database).toBe('connected');
    const analytics = await app.inject({ method: 'GET', url: '/api/v1/analytics/overview' });
    expect(analytics.statusCode).toBe(401);
  });

  it('uses the RLS actor for /me, never the owner connection', async () => {
    const response = await app.inject({
      method: 'GET', url: '/api/v1/dashboard/auth/me',
      headers: { authorization: 'Bearer ' + authorizedToken() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.allowedStores).toEqual(['store-authorized']);
    expect(txSetRole).toHaveBeenCalledWith('SET LOCAL ROLE crm_eurovia_runtime');
    expect(privilegedDashboardLookup).not.toHaveBeenCalled();
  });

  it('never presents unverified zero KPIs as real metrics', async () => {
    const response = await app.inject({
      method: 'GET', url: '/api/v1/analytics/overview',
      headers: { authorization: 'Bearer ' + authorizedToken() },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatch(/reconciliacao/);
  });

  it('after KPI reconciliation, analytics queries still use scoped transactions', async () => {
    process.env.CRM_KPI_RECONCILED = 'true';
    const response = await app.inject({
      method: 'GET', url: '/api/v1/analytics/overview',
      headers: { authorization: 'Bearer ' + authorizedToken() },
    });
    expect(response.statusCode).toBe(200);
    expect(scopedLookup).toHaveBeenCalled();
    expect(txSetRole).toHaveBeenCalledWith('SET LOCAL ROLE crm_eurovia_runtime');
    expect(JSON.stringify(txQuery.mock.calls)).toContain('store-authorized');
    expect(privilegedDashboardLookup).not.toHaveBeenCalled();
    process.env.CRM_KPI_RECONCILED = 'false';
  });
});
