import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Liveness probe do frontend. Não revela se segredos estão configurados.
 * Readiness e saúde das integrações devem ser testadas em endpoint
 * próprio, autenticado e sem dados sensíveis.
 */
export async function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      service: 'crm-eurovia-web',
      timestamp: new Date().toISOString(),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
