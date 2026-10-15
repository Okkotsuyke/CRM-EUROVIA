/**
 * Real PostgreSQL + Prisma + Fastify HTTP integration.
 * Only enabled by CRM_EUROVIA_PG_E2E_CI=1 in a disposable localhost CI DB.
 * Never reads Neon, Supabase or Syonet credentials. No Sentry connection.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

vi.mock('../plugins/sentry.plugin', () => ({
  default: (async () => {}) as any,
  __esModule: true,
}));

describe.skipIf(process.env.CRM_EUROVIA_PG_E2E_CI !== '1')(
  'CRM Eurovia real Fastify/Prisma/Postgres RLS E2E (ephemeral CI only)',
  () => {
    let app: FastifyInstance;
    let prisma: PrismaClient;
    let tokenA: string;
    let tokenB: string;
    let refreshA: string;
    let refreshB: string;

    const secureUrl = 'postgresql://crm_eurovia_ci_login:ci-only-login@127.0.0.1:5432/crm_eurovia?schema=public';

    beforeAll(async () => {
      if (
        process.env.CRM_EUROVIA_PG_E2E_CI !== '1' ||
        process.env.NODE_ENV !== 'test' ||
        process.env.CRM_NEON_STAGING_MODE !== 'true' ||
        process.env.DATABASE_URL !== secureUrl ||
        process.env.SYONET_USE_REAL !== 'false' ||
        process.env.SYNC_ENABLED !== 'false'
      ) {
        throw new Error('CRM Eurovia CI only: refused unsafe database target');
      }
      const { PrismaClient: PrismaClientCtor } = await import('@prisma/client');
      prisma = new PrismaClientCtor();
      const { buildApp } = await import('../app');
      app = await buildApp();
      app.decorate('prisma', prisma);
      await app.ready();
    });

    afterAll(async () => {
      if (app) {
        for (const rt of [refreshA, refreshB]) {
          if (rt) {
            await app.inject({ method: 'POST', url: '/api/v1/auth/logout',
              payload: { refreshToken: rt } }).catch(() => undefined);
          }
        }
        await app.close();
      }
      if (prisma) await prisma.$disconnect();
    });

    function authorized(jwt: string) {
      return { authorization: 'Bearer ' + jwt };
    }

    it('authenticates synthetic users A and B using restricted SQL functions', async () => {
      const missing = await app.inject({
        method: 'POST', url: '/api/v1/auth/login',
        payload: { username: 'CI.USER.A', password: 'invalid-only-ci' },
      });
      expect(missing.statusCode).toBe(401);
      for (const [name,store,assign] of [
        ['CI.USER.A','ci-acl-a','A'],
        ['CI.USER.B','ci-acl-b','B'],
      ] as const) {
        const res = await app.inject({
          method: 'POST', url: '/api/v1/auth/login',
          payload: { username: name, password: 'ci-only-user-password' },
        });
        expect(res.statusCode, res.body.slice(0,200)).toBe(200);
        const value = res.json();
        expect(value.user.storeId).toBe(store);
        expect(value.user.role).toBe('VL_CONSULTANT');
        expect(typeof value.accessToken).toBe('string');
        expect(value.refreshToken).toMatch(/^[a-f0-9]{64}$/);
        if(assign==='A') { tokenA=value.accessToken; refreshA=value.refreshToken; }
        else {tokenB=value.accessToken;refreshB=value.refreshToken;}
      }
    });

    it('denies anonymous requests without DB data leakage', async () => {
      for(const path of ['/api/v1/leads','/api/v1/appointments']) {
        const r=await app.inject({method:'GET',url:path});
        expect(r.statusCode).toBe(401);
      }
    });

    it('returns only store A lead and appointment fields via Prisma RLS', async () => {
      const a=await app.inject({method:'GET',url:'/api/v1/leads',headers:authorized(tokenA)});
      expect(a.statusCode,a.body.slice(0,300)).toBe(200);
      const leads=a.json().data;
      expect(leads.total).toBe(1);
      expect(leads.leads.map((x: { id:string })=>x.id)).toEqual(['ci-acl-lead-a']);
      expect(leads.leads[0]).not.toHaveProperty('rawPayload');
      expect(leads.leads[0].storeId).toBe('ci-acl-a');

      const b=await app.inject({method:'GET',url:'/api/v1/appointments',headers:authorized(tokenA)});
      expect(b.statusCode,b.body.slice(0,300)).toBe(200);
      const appointments=b.json().data;
      expect(appointments.total).toBe(1);
      expect(appointments.appointments.map((x: { id:string })=>x.id)).toEqual(['ci-acl-appointment-a']);
      expect(appointments.appointments[0]).not.toHaveProperty('rawData');
    });

    it('consultant B cannot view store A, and A cannot expand a store filter', async () => {
      const a=await app.inject({method:'GET',url:'/api/v1/leads',headers:authorized(tokenB)});
      expect(a.statusCode).toBe(200);
      expect(a.json().data.leads.map((x:{id:string})=>x.id)).toEqual(['ci-acl-lead-b']);
      const filtered=await app.inject({method:'GET',url:'/api/v1/leads?storeId=ci-acl-b',headers:authorized(tokenA)});
      expect(filtered.statusCode).toBe(200);
      expect(filtered.json().data.total).toBe(0);
      expect(filtered.json().data.leads).toEqual([]);
      const appts=await app.inject({method:'GET',url:'/api/v1/appointments?storeId=ci-acl-b',headers:authorized(tokenA)});
      expect(appts.statusCode).toBe(200);
      expect(appts.json().data.total).toBe(0);
    });

    it('details respect RLS and never include raw Syonet payloads', async () => {
      const own=await app.inject({method:'GET',url:'/api/v1/leads/ci-acl-lead-a',headers:authorized(tokenA)});
      expect(own.statusCode,own.body.slice(0,220)).toBe(200);
      expect(own.json().data.id).toBe('ci-acl-lead-a');
      expect(own.json().data).not.toHaveProperty('rawPayload');
      const other=await app.inject({method:'GET',url:'/api/v1/leads/ci-acl-lead-b',headers:authorized(tokenA)});
      expect(other.statusCode).toBe(404);
      const apt=await app.inject({method:'GET',url:'/api/v1/appointments/ci-acl-appointment-a',headers:authorized(tokenA)});
      expect(apt.statusCode,apt.body.slice(0,220)).toBe(200);
      expect(apt.json().data).not.toHaveProperty('rawData');
      const denied=await app.inject({method:'GET',url:'/api/v1/appointments/ci-acl-appointment-b',headers:authorized(tokenA)});
      expect(denied.statusCode).toBe(404);
    });

    it('keeps all writes and Syonet/cron routes unavailable in staging', async () => {
      for(const [method,url] of [
        ['PUT','/api/v1/leads/ci-acl-lead-a'],
        ['POST','/api/v1/appointments'],
        ['DELETE','/api/v1/appointments/ci-acl-appointment-a'],
        ['GET','/api/cron/health'],
        ['GET','/api/v1/syonet-dashboard'],
      ] as const){
        const res=await app.inject({method,url,headers:authorized(tokenA)});
        expect(res.statusCode).toBe(503);
      }
    });

    it('refresh is single-use and logout revokes the successor token', async () => {
      const res=await app.inject({method:'POST',url:'/api/v1/auth/refresh',payload:{refreshToken:refreshA}});
      expect(res.statusCode,res.body.slice(0,200)).toBe(200);
      const next=res.json().refreshToken;
      expect(next).toMatch(/^[a-f0-9]{64}$/);
      expect(next).not.toBe(refreshA);
      const old=refreshA;refreshA=next;
      const replay=await app.inject({method:'POST',url:'/api/v1/auth/refresh',payload:{refreshToken:old}});
      expect(replay.statusCode).toBe(401);
      const logout=await app.inject({method:'POST',url:'/api/v1/auth/logout',payload:{refreshToken:next}});
      expect(logout.statusCode).toBe(200);
      refreshA='';
      const revoked=await app.inject({method:'POST',url:'/api/v1/auth/refresh',payload:{refreshToken:next}});
      expect(revoked.statusCode).toBe(401);
    });
  },
);
