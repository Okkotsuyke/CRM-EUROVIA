import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../plugins/sentry.plugin', () => ({
  default: (async () => {}) as any,
  __esModule: true,
}));

describe('Fastify Neon staging: JWT -> Prisma transaction -> RLS (no external networks)', () => {
  let app: FastifyInstance;
  const prisma = {
    $transaction: vi.fn(),
  };
  const tx = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findUnique: vi.fn() },
    dashboardUser: { findUnique: vi.fn() },
    store: { findFirst: vi.fn(), findMany: vi.fn() },
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.CRM_NEON_STAGING_MODE = 'true';
    process.env.DATABASE_URL = 'postgresql://ci:ci@localhost:5432/fixture_db';
    process.env.JWT_SECRET = 'eurovia-test-only-jwt-secret-at-least-32-characters';
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
    prisma.$transaction.mockImplementation(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
    tx.$queryRaw.mockResolvedValue([]);
    tx.user.findUnique.mockResolvedValue({
      id: 'operator-a', username: 'operator-a', name: 'Operator A',
      email: null, role: 'VL_CONSULTANT', storeId: 'store-a', active: true,
    });
    tx.dashboardUser.findUnique.mockResolvedValue({
      id: 'evaluator', username: 'eval', name: 'Evaluator',
      role: 'VIEWER', allowedStores: ['store-a'], active: true,
    });
    tx.store.findMany.mockResolvedValue([{id: 'store-a', shortName: 'Loja A', plaza: 'FORTALEZA'}]);
    tx.store.findFirst.mockResolvedValue({id: 'store-a',shortName: 'Loja A',plaza: 'FORTALEZA'});
  });

  const access = () => app.jwt.sign({id:'operator-a', role:'ADMIN', storeId:'store-b'});
  const dashboard = () => app.jwt.sign({id:'evaluator',type:'dashboard',allowedStores:['store-b'],role:'ADMIN'});

  it('anonymous GET /stores gets 401, not SQL access', async () => {
    const res=await app.inject({method:'GET',url:'/api/v1/stores'});
    expect(res.statusCode).toBe(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('signed forged role cannot broaden store scopes beyond DB role', async () => {
    const res=await app.inject({
      method:'GET',url:'/api/v1/stores',
      headers:{authorization:'Bearer '+access()},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{id:'store-a',shortName:'Loja A',plaza:'FORTALEZA'}]);
    expect(tx.store.findMany.mock.calls[0][0].where.id).toEqual({in:['store-a']});
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL ROLE crm_eurovia_runtime');
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it('GET /auth/me reads identity and associated store inside same transaction', async () => {
    const res=await app.inject({
      method:'GET',url:'/api/v1/auth/me',
      headers:{authorization:'Bearer '+access()},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id:'operator-a',role:'VL_CONSULTANT',storeId:'store-a',
      store:{id:'store-a'},
    });
    expect(JSON.stringify(res.json())).not.toMatch(/password|passwordHash|refreshToken/);
    expect(tx.store.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it('inactive user is rejected even with signed non-expired JWT', async () => {
    tx.user.findUnique.mockResolvedValue({id:'operator-a',active:false,role:'ADMIN',storeId:null});
    const res=await app.inject({
      method:'GET',url:'/api/v1/stores',
      headers:{authorization:'Bearer '+access()},
    });
    expect(res.statusCode).toBe(401);
    expect(tx.store.findMany).not.toHaveBeenCalled();
  });

  it('dashboard JWT cannot authenticate operational endpoints', async () => {
    const res=await app.inject({
      method:'GET',url:'/api/v1/stores',
      headers:{authorization:'Bearer '+dashboard()},
    });
    expect(res.statusCode).toBe(401);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('evaluator allowedStores comes from DB rather than token', async () => {
    const res=await app.inject({
      method:'GET',url:'/api/v1/dashboard/auth/me',
      headers:{authorization:'Bearer '+dashboard()},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({success:true,data:{allowedStores:['store-a']}});
    expect(tx.dashboardUser.findUnique).toHaveBeenCalled();
  });

  it('cross-store known ID is indistinguishable from absent store', async () => {
    const res=await app.inject({
      method:'GET',url:'/api/v1/stores/store-b',
      headers:{authorization:'Bearer '+access()},
    });
    expect(res.statusCode).toBe(404);
    expect(tx.store.findFirst).not.toHaveBeenCalled();
  });

  it('invalid login does not reveal hashes or mint a token', async () => {
    const res=await app.inject({
      method:'POST',url:'/api/v1/auth/login',
      payload:{username:'no-user',password:'not-valid'},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).not.toHaveProperty('accessToken');
    expect(tx.user.findUnique).not.toHaveBeenCalled();
    expect(String(tx.$queryRaw.mock.calls[0][0][0])).toContain('crm_security.login_user(');
  });

  it('valid SQL-auth session issues short-lived JWT and opaque refresh', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{
      user_id:'operator-a',user_name:'operator-a',display_name:'Operator A',
      email:null,user_role:'VL_CONSULTANT',store_id:'store-a',
      refresh_token:'f'.repeat(64),expires_at:new Date(),
    }]);
    const res=await app.inject({
      method:'POST',url:'/api/v1/auth/login',
      payload:{username:'operator-a',password:'valid-only-in-mock'},
    });
    expect(res.statusCode).toBe(200);
    const payload=res.json();
    expect(payload.accessToken).toBeTruthy();
    expect(payload.refreshToken).toBe('f'.repeat(64));
    expect(app.jwt.verify(payload.accessToken)).toMatchObject({id:'operator-a'});
  });

  it('all other commercial mutations, Syonet and cron remain gated', async () => {
    for (const request of [
      {method:'PUT',url:'/api/v1/leads/stg-lead-a'},
      {method:'POST',url:'/api/v1/users'},
      {method:'POST',url:'/api/v1/sync/run'},
      {method:'GET',url:'/api/v1/syonet-dashboard'},
      {method:'GET',url:'/api/cron/health'},
    ]) {
      const res=await app.inject(request as any);
      expect(res.statusCode).toBe(503);
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
