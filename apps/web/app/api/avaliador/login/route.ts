import { NextRequest, NextResponse } from 'next/server';
import { resolveEuroviaUpstream } from '@/lib/eurovia-upstream';

export async function POST(request: NextRequest) {
  const upstreamConfig = resolveEuroviaUpstream();
  if (!upstreamConfig) {
    return NextResponse.json(
      { success: false, error: 'API de autenticacao indisponivel' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Solicitacao invalida' }, { status: 400 });
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ success: false, error: 'Solicitacao invalida' }, { status: 400 });
  }
  const { username, password } = body as Record<string, unknown>;
  if (
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    username.length < 1 ||
    username.length > 120 ||
    password.length < 1 ||
    password.length > 72
  ) {
    return NextResponse.json({ success: false, error: 'Credenciais invalidas' }, { status: 400 });
  }

  try {
    const upstream = await fetch(
      upstreamConfig.baseUrl + '/api/v1/dashboard/auth/login',
      {
        method: 'POST',
        headers: { ...upstreamConfig.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
      },
    );
    if (!(upstream.headers.get('content-type') || '').includes('application/json')) {
      return NextResponse.json(
        { success: false, error: 'API de autenticacao indisponivel' },
        { status: 503 },
      );
    }
    return NextResponse.json(await upstream.json(), {
      status: upstream.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Falha de comunicacao com a API' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
