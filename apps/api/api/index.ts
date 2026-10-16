// Serverless handler for Vercel — CRM EUROVIA API
// Uses fastify.inject() to handle requests without listening on a port.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildApp } from '../src/app';

let fastifyPromise: Promise<Awaited<ReturnType<typeof buildApp>>> | null = null;

function getFastify() {
  if (!fastifyPromise) {
    fastifyPromise = buildApp().then(async app => {
      await app.ready();
      return app;
    }).catch(error => {
      fastifyPromise = null;
      throw error;
    });
  }
  return fastifyPromise;
}

export const config = { maxDuration: 300 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const fastify = await getFastify();
    const response = await fastify.inject({
      method: req.method as any,
      url: req.url ?? '/',
      headers: req.headers as any,
      // Requests without a body must not inject an artificial "{}" payload.
      payload: req.body == null ? undefined
        : typeof req.body === 'string' || Buffer.isBuffer(req.body)
          ? req.body
          : JSON.stringify(req.body),
      query: req.query as any,
    });

    res.status(response.statusCode);
    Object.entries(response.headers).forEach(([key, value]) => {
      if (value) res.setHeader(key, value as string | string[]);
    });
    res.send(response.body);
  } catch (error: any) {
    console.error('[api/index] Error handling request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Request could not be processed',
      });
    }
  }
}
