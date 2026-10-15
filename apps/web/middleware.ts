import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Middleware de sessão Supabase.
 *
 * IMPORTANTE: este middleware apenas mantém a sessão do Supabase
 * atualizada (refresh de tokens). Ele NÃO faz gate de rotas.
 *
 * O gate atual de auth continua sendo o localStorage 'user' e o
 * cookie 'access_token' emitidos pelo Fastify. A migração para
 * Supabase Auth (supabase.auth.signInWithPassword) é uma fase
 * posterior.
 *
 * Se este middleware redirecionasse com base em `!user`, todos os
 * usuários atualmente logados via Fastify seriam chutados para
 * /avaliador/login porque não têm sessão Supabase.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  // A branch de avaliação do CRM Eurovia usa somente Fastify+Neon.
  // Nunca tentar atualizar sessão de Supabase herdada em Preview.
  if (process.env.CRM_EUROVIA_PREVIEW_ONLY === 'true') {
    return response;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Se as env vars não estão setadas, deixa a request passar.
  // Sem este early-return, o createServerClient lá embaixo poderia
  // lançar e derrubar o site inteiro com 500 em toda request.
  if (!url || !key) {
    return response;
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // Refresh silencioso. Falha do Supabase = passa direto.
  try {
    await supabase.auth.getUser();
  } catch {
    // Supabase indisponível ou env vars inválidas — request continua.
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
