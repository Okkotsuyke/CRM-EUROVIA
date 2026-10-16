import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../plugins/sentry.plugin', () => ({
  default: (async () => {}) as any,
  __esModule: true,
}));

describe('leads e agendamentos - isolamento por loja (sem Syonet)', () => {
  let app: FastifyInstance;
  let leadFindMany: ReturnType<typeof vi.fn>;
  let leadCount: ReturnType<typeof vi.fn>;
  let leadFindFirst: ReturnType<typeof vi.fn>;
  let appointmentFindMany: ReturnType<typeof vi.fn>;
  let appointmentCount: ReturnType<typeof vi.fn>;
  let appointmentFindFirst: ReturnType<typeof vi.fn>;
  let leadUpdate: ReturnType<typeof vi.fn>;
  let appointmentUpdate: ReturnType<typeof vi.fn>;
  let createAppointment: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-scope-secret-with-32-chars-abcdefghijk';
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    const { buildApp } = await import('../app');
    app = await buildApp();
    leadFindMany = vi.fn().mockResolvedValue([]);
    leadCount = vi.fn().mockResolvedValue(0);
    leadFindFirst = vi.fn().mockResolvedValue(null);
    appointmentFindMany = vi.fn().mockResolvedValue([]);
    appointmentCount = vi.fn().mockResolvedValue(0);
    appointmentFindFirst = vi.fn().mockResolvedValue(null);
    leadUpdate = vi.fn();
    appointmentUpdate = vi.fn();
    createAppointment = vi.fn();
    app.decorate('prisma', {
      user: { findUnique: vi.fn().mockResolvedValue({
        id: 'user-a', username:'operador', active:true,
        role:'VL_CONSULTANT', storeId:'loja-a',
      }) },
      lead: {
        findMany: leadFindMany, count: leadCount,
        findFirst: leadFindFirst, update: leadUpdate,
      },
      appointment: {
        findMany: appointmentFindMany, count: appointmentCount,
        findFirst: appointmentFindFirst, update: appointmentUpdate,
      },
    } as any);
    await app.ready();
  });

  afterAll(async () => { if (app) await app.close(); });

  function token() {
    // Token falsifica acesso de ADMIN a loja B: banco recusa esse papel.
    return app.jwt.sign({ id: 'user-a', role: 'ADMIN', storeId:null });
  }
  const id = '00000000-0000-4000-8000-000000000001';

  it('nao permite ampliar lista de leads para loja B', async () => {
    const response = await app.inject({
      method:'GET', url:'/api/v1/leads?storeId=loja-b',
      headers:{authorization:'Bearer '+token()},
    });
    expect(response.statusCode).toBe(200);
    expect(leadFindMany).toHaveBeenCalled();
    expect(leadFindMany.mock.calls.at(-1)?.[0]?.where.storeId).toEqual({in:[]});
  });

  it('nao permite ampliar lista de agendamentos para loja B', async () => {
    const response = await app.inject({
      method:'GET', url:'/api/v1/appointments?storeId=loja-b',
      headers:{authorization:'Bearer '+token()},
    });
    expect(response.statusCode).toBe(200);
    expect(appointmentFindMany.mock.calls.at(-1)?.[0]?.where.storeId).toEqual({in:[]});
  });

  it('detalhes de lead aplicam filtro de loja na query', async () => {
    const response = await app.inject({
      method:'GET', url:'/api/v1/leads/'+id,
      headers:{authorization:'Bearer '+token()},
    });
    expect(response.statusCode).toBe(404);
    expect(leadFindFirst.mock.calls.at(-1)?.[0]?.where.storeId).toEqual({in:['loja-a']});
  });

  it('mutacoes sobre leads externos retornam 404 sem escrever', async () => {
    const response = await app.inject({
      method:'PUT', url:'/api/v1/leads/'+id,
      payload:{priorityFlag:true},
      headers:{authorization:'Bearer '+token()},
    });
    expect(response.statusCode).toBe(404);
    expect(leadUpdate).not.toHaveBeenCalled();
  });

  it('nao cria agendamento sem lead autorizado', async () => {
    const response = await app.inject({
      method:'POST', url:'/api/v1/appointments',
      payload:{leadId:id,storeId:'loja-b',appointmentDate:'2026-10-25T10:00:00.000Z'},
      headers:{authorization:'Bearer '+token()},
    });
    expect(response.statusCode).toBe(404);
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it('nao cancela agendamento externo', async () => {
    const response = await app.inject({
      method:'DELETE', url:'/api/v1/appointments/'+id,
      headers:{authorization:'Bearer '+token()},
    });
    expect(response.statusCode).toBe(404);
    expect(appointmentUpdate).not.toHaveBeenCalled();
  });
});
