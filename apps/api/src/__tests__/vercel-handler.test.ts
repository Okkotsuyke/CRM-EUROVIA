import { describe, it, expect } from 'vitest';
import handler from '../../api/index';

describe('Vercel explicit Fastify adapter', () => {
  it('routes an HTTP request through api/index.ts', async () => {
    const previous = {
      nodeEnv: process.env.NODE_ENV,
      jwt: process.env.JWT_SECRET,
      db: process.env.DATABASE_URL,
      staging: process.env.CRM_NEON_STAGING_MODE,
    };
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'vercel-adapter-test-secret-at-least-32-characters';
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    delete process.env.CRM_NEON_STAGING_MODE;

    let statusCode = 200;
    let payload = '';
    const headers: Record<string, string | string[]> = {};
    const req = {
      method: 'GET',
      url: '/api/cron/health',
      headers: {},
      body: undefined,
      query: {},
    } as any;
    const res = {
      headersSent: false,
      status(code: number) { statusCode = code; return this; },
      setHeader(key: string, value: string | string[]) { headers[key] = value; },
      send(value: unknown) { payload = String(value); this.headersSent = true; return this; },
      json(value: unknown) { payload = JSON.stringify(value); this.headersSent = true; return this; },
    } as any;

    try {
      await handler(req, res);
      expect(statusCode).toBe(200);
      expect(JSON.parse(payload)).toMatchObject({ status: 'ok', service: 'cron-jobs' });
    } finally {
      process.env.NODE_ENV = previous.nodeEnv;
      process.env.JWT_SECRET = previous.jwt;
      process.env.DATABASE_URL = previous.db;
      if (previous.staging === undefined) delete process.env.CRM_NEON_STAGING_MODE;
      else process.env.CRM_NEON_STAGING_MODE = previous.staging;
    }
  });
});
