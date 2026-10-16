import { NextRequest, NextResponse } from 'next/server';

import { resolveEuroviaUpstream } from '@/lib/eurovia-upstream';
const READ_PATHS = new Set([
  '/api/v1/dashboard/auth/me',
  '/api/v1/analytics/overview',
  '/api/v1/analytics/by-store',
  '/api/v1/analytics/by-vl',
  '/api/v1/analytics/by-media',
  '/api/v1/analytics/productivity',
  '/api/v1/analytics/trend',
  '/api/v1/syonet-sync/status',
]);

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const upstreamConfig = resolveEuroviaUpstream();
  if (!upstreamConfig) {
    return NextResponse.json({ success: false, error: 'Proxy de homologacao/producao indisponivel' }, { status: 503 });
  }
  const { path } = await params;
  const requestedPath = '/' + path.join('/');
  if (!READ_PATHS.has(requestedPath)) {
    return NextResponse.json({ success: false, error: 'Rota nao permitida' }, { status: 404 });
  }
  const authorization = request.headers.get('authorization');
  if (!authorization || !/^Bearer [A-Za-z0-9_.-]{20,4096}$/.test(authorization)) {
    return NextResponse.json({ success: false, error: 'Autenticacao necessaria' }, { status: 401 });
  }
  try {
    const upstream = await fetch(upstreamConfig.baseUrl + requestedPath + request.nextUrl.search, {
      headers: { ...upstreamConfig.headers, Authorization: authorization },
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    });
    const type = upstream.headers.get('content-type') || '';
    if (!type.includes('application/json')) {
      return NextResponse.json({ success: false, error: 'API indisponivel' }, { status: 503 });
    }
    return new NextResponse(await upstream.text(), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Falha de comunicacao com a API' }, { status: 503 });
  }
}
