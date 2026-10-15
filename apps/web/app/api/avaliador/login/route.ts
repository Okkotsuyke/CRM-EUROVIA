import { NextRequest, NextResponse } from 'next/server';

const STAGING_API = 'https://crm-eurovia-api-git-fix-eurovia-hardening-0307ad-maykengld-9931.vercel.app';

export async function POST(request: NextRequest) {
  if (process.env.CRM_EUROVIA_PREVIEW_ONLY !== 'true' || process.env.VERCEL_ENV !== 'preview') {
    return NextResponse.json({ success: false, error: 'Disponivel apenas no ambiente de homologacao' }, { status: 503 });
  }
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ success: false, error: 'Solicitacao invalida' }, { status: 400 }); }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ success: false, error: 'Solicitacao invalida' }, { status: 400 });
  }
  const { username, password } = body as Record<string, unknown>;
  if (typeof username !== 'string' || typeof password !== 'string' ||
    username.length < 1 || username.length > 120 || password.length < 1 || password.length > 72) {
    return NextResponse.json({ success: false, error: 'Credenciais invalidas' }, { status: 400 });
  }
  const bypass = process.env.CRM_EUROVIA_VERCEL_BYPASS_SECRET;
  if (!bypass) {
    return NextResponse.json({ success: false, error: 'Autenticacao entre servicos indisponivel' }, { status: 503 });
  }
  try {
    const upstream = await fetch(STAGING_API + '/api/v1/dashboard/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vercel-protection-bypass': bypass },
      body: JSON.stringify({ username, password }),
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    });
    const type = upstream.headers.get('content-type') || '';
    if (!type.includes('application/json')) {
      return NextResponse.json({ success: false, error: 'API de autenticacao indisponivel' }, { status: 503 });
    }
    const response = await upstream.json();
    return NextResponse.json(response, { status: upstream.status, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ success: false, error: 'Falha de comunicacao com a API de homologacao' }, { status: 503 });
  }
}
