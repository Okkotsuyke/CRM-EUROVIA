import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../plugins/sentry.plugin', () => ({
  default: (async () => {}) as any,
  __esModule: true,
}));

describe('Neon staging GET-only leads and appointments (without Syonet)', () => {
  let app: FastifyInstance;
  const tx = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    lead: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    appointment: { findMany: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
  };
  const prisma = { $transaction: vi.fn() };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.CRM_NEON_STAGING_MODE = 'true';
    process.env.JWT_SECRET = 'eurovia-stage-readonly-tests-at-least-32-chars';
    process.env.DATABASE_URL = 'postgresql://ci:ci@localhost:5432/unused';
    process.env.SYONET_USE_REAL = 'false';
    process.env.SYNC_ENABLED = 'false';
    const { buildApp } = await import('../app');
    app = await buildApp();
    app.decorate('prisma', prisma as any);
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    delete process.env.CRM_NEON_STAGING_MODE;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (action: (tx: typeof tx) => Promise<unknown>) => action(tx));
    tx.user.findUnique.mockResolvedValue({
      id: 'operator-a', name: 'Operator A', username: 'operator-a',
      email: null, active: true, role: 'VL_CONSULTANT', storeId: 'store-a',
    });
    tx.user.findMany.mockResolvedValue([]);
    tx.lead.findMany.mockResolvedValue([{
      id: 'stg-lead-a', storeId: 'store-a', assignedVlId: null,
      assignedVsId: null, assignedBdcId: null, status: 'STAGING_ONLY',
    }]);
    tx.lead.findFirst.mockResolvedValue(null);
    tx.lead.count.mockResolvedValue(1);
    tx.appointment.findMany.mockResolvedValue([{
      id: 'stg-appointment-a', storeId: 'store-a',
      lead: {
        id: 'stg-lead-a', assignedVlId: null,
        assignedVsId: null, assignedBdcId: null,
      },
    }]);
    tx.appointment.findFirst.mockResolvedValue(null);
    tx.appointment.count.mockResolvedValue(1);
  });

  const auth = () => ({
    authorization: 'Bearer ' + app.jwt.sign({
      id: 'operator-a', role: 'ADMIN', storeId: 'store-b',
    }),
  });
  const dashboardAuth = () => ({
    authorization: 'Bearer ' + app.jwt.sign({id:'evaluator', type:'dashboard', role:'ADMIN'}),
  });

  it('blocks unauthenticated readers without any Prisma transaction', async () => {
    for (const path of ['/api/v1/leads', '/api/v1/appointments']) {
      const response = await app.inject({ method: 'GET', url: path });
      expect(response.statusCode).toBe(401);
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns only authorized leads and excludes raw Syonet payload in select', async () => {
    const response = await app.inject({
      method:'GET',url:'/api/v1/leads',headers:auth(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({success:true,data:{total:1}});
    expect(tx.lead.findMany.mock.calls[0][0].where.storeId).toEqual({in:['store-a']});
    expect(tx.lead.count.mock.calls[0][0].where.storeId).toEqual({in:['store-a']});
    expect(tx.lead.findMany.mock.calls[0][0].select).not.toHaveProperty('rawPayload');
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL ROLE crm_eurovia_runtime');
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it('store B filter cannot expand lead access using forged ADMIN JWT', async () => {
    const response=await app.inject({
      method:'GET',url:'/api/v1/leads?storeId=store-b',headers:auth(),
    });
    expect(response.statusCode).toBe(200);
    expect(tx.lead.findMany.mock.calls[0][0].where.storeId).toEqual({in:[]});
  });

  it('known cross-store lead ID returns 404 under authorized A context', async () => {
    const response=await app.inject({
      method:'GET',url:'/api/v1/leads/stg-lead-b',headers:auth(),
    });
    expect(response.statusCode).toBe(404);
    expect(tx.lead.findFirst.mock.calls[0][0].where).toMatchObject({
      id:'stg-lead-b',storeId:{in:['store-a']},
    });
  });

  it('appointments use the same transaction, RLS and safe projections', async () => {
    const response=await app.inject({
      method:'GET',url:'/api/v1/appointments',headers:auth(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({success:true,data:{total:1}});
    expect(tx.appointment.findMany.mock.calls[0][0].where.storeId).toEqual({in:['store-a']});
    expect(tx.appointment.findMany.mock.calls[0][0].select).not.toHaveProperty('rawData');
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL ROLE crm_eurovia_runtime');
  });

  it('cross-store appointment query filter returns empty authorized set', async () => {
    const response=await app.inject({
      method:'GET',url:'/api/v1/appointments?storeId=store-b',headers:auth(),
    });
    expect(response.statusCode).toBe(200);
    expect(tx.appointment.findMany.mock.calls[0][0].where.storeId).toEqual({in:[]});
  });

  it('known appointment ID from another store returns 404', async () => {
    const response=await app.inject({
      method:'GET',url:'/api/v1/appointments/stg-appointment-b',headers:auth(),
    });
    expect(response.statusCode).toBe(404);
    expect(tx.appointment.findFirst.mock.calls[0][0].where.storeId).toEqual({in:['store-a']});
  });

  it('dashboard access token is not accepted for operational leads', async () => {
    const response=await app.inject({
      method:'GET',url:'/api/v1/leads',headers:dashboardAuth(),
    });
    expect(response.statusCode).toBe(401);
    expect(tx.lead.findMany).not.toHaveBeenCalled();
  });

  it('inactive users never read leads or appointments', async () => {
    tx.user.findUnique.mockResolvedValue({
      id:'operator-a',active:false,role:'VL_CONSULTANT',storeId:'store-a',
    });
    for(const url of ['/api/v1/leads','/api/v1/appointments']) {
      const response=await app.inject({method:'GET',url,headers:auth()});
      expect(response.statusCode).toBe(401);
    }
    expect(tx.lead.findMany).not.toHaveBeenCalled();
    expect(tx.appointment.findMany).not.toHaveBeenCalled();
  });

  it('all business mutations and portfolio aggregations stay disabled', async () => {
    for(const r of [
      {method:'PUT',url:'/api/v1/leads/stg-lead-a'},
      {method:'POST',url:'/api/v1/leads/stg-lead-a/events'},
      {method:'POST',url:'/api/v1/appointments'},
      {method:'PUT',url:'/api/v1/appointments/stg-appointment-a'},
      {method:'DELETE',url:'/api/v1/appointments/stg-appointment-a'},
      {method:'GET',url:'/api/v1/leads/stats/portfolio'},
      {method:'GET',url:'/api/v1/syonet-dashboard'},
      {method:'GET',url:'/api/cron/health'},
    ]) {
      const response=await app.inject({method:r.method as any,url:r.url,headers:auth()});
      expect(response.statusCode).toBe(503);
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
