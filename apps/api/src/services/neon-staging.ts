/**
 * CRM EUROVIA - Neon STAGING DB perimeter.
 * This is a preview-only connection test, not a production release.
 * The only allowed project/branch are verified before Prisma connects.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

export const NEON_STAGING = Object.freeze({
  project: 'noisy-hat-46747617',
  branch: 'br-bold-sun-b6p0nkhp',
  database: 'crm_eurovia',
  loginRole: 'crm_eurovia_staging_login',
  rlsRole: 'crm_eurovia_runtime',
});

export function validateNeonStagingEnv(env: NodeJS.ProcessEnv): void {
  if (env.CRM_NEON_STAGING_MODE !== 'true') return;
  if (
    env.CRM_NEON_PROJECT_ID !== NEON_STAGING.project ||
    env.CRM_NEON_BRANCH_ID !== NEON_STAGING.branch
  ) {
    throw new Error('CRM Eurovia: Neon staging project/branch identity mismatch');
  }
  if (env.VERCEL_ENV && env.VERCEL_ENV !== 'preview') {
    throw new Error('CRM Eurovia: staging credentials prohibited outside preview');
  }
  if (env.SYONET_USE_REAL !== 'false' || env.SYNC_ENABLED !== 'false') {
    throw new Error('CRM Eurovia: external synchronization must be disabled in staging');
  }

  const raw = env.DATABASE_URL;
  if (!raw) throw new Error('CRM Eurovia: staging DATABASE_URL missing');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('CRM Eurovia: invalid staging database URL');
  }
  if (
    (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') ||
    !url.hostname.endsWith('.sa-east-1.aws.neon.tech') ||
    url.pathname !== '/' + NEON_STAGING.database ||
    decodeURIComponent(url.username) !== NEON_STAGING.loginRole ||
    url.searchParams.get('sslmode') !== 'require'
  ) {
    throw new Error('CRM Eurovia: Neon staging URL must use the restricted role, São Paulo and SSL');
  }
}

export type StagingReadiness = {
  connected: boolean;
  restrictedRole: boolean;
  rlsTables: number;
};

export async function checkNeonStagingReadiness(
  prisma: Pick<PrismaClient, '$queryRaw' | '$transaction'>,
): Promise<StagingReadiness> {
  const meta = await prisma.$queryRaw<Array<{
    db: string;
    role_name: string;
    bypass: boolean;
    rls_tables: bigint;
  }>>`
    SELECT current_database() AS db, current_user AS role_name,
      (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass,
      (SELECT count(*)::bigint
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r'
          AND c.relrowsecurity AND c.relforcerowsecurity) AS rls_tables
  `;
  const item = meta[0];
  if (
    !item || item.db !== NEON_STAGING.database ||
    item.role_name !== NEON_STAGING.loginRole ||
    item.bypass || Number(item.rls_tables) !== 14
  ) throw new Error('CRM Eurovia: Neon staging identity or RLS invariant failed');

  const visible = await prisma.$transaction(async tx => {
    // Literal SQL only; no user-supplied names/expressions in SET ROLE.
    await tx.$executeRawUnsafe('SET LOCAL ROLE crm_eurovia_runtime');
    const rows = await tx.$queryRaw<Array<{ visible: bigint }>>`
      SELECT count(*)::bigint AS visible FROM public.stores
    `;
    return Number(rows[0]?.visible ?? -1);
  });
  // There are synthetic staging stores; with no trusted request actor,
  // the RLS role must see zero, or this preview cannot be served.
  if (visible !== 0) throw new Error('CRM Eurovia: missing RLS actor must deny all rows');
  return { connected: true, restrictedRole: true, rlsTables: 14 };
}

/**
 * Future authorized requests MUST use the transaction-bound client.
 * The API must validate JWT and refresh the active actor from a trusted
 * authentication service BEFORE calling this function.
 */
export async function withNeonStagingActor<T>(
  prisma: Pick<PrismaClient, '$transaction'>,
  actor: { id: string; kind: 'user' | 'dashboard' },
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!/^[a-zA-Z0-9_-]{3,128}$/.test(actor.id)) {
    throw new Error('CRM Eurovia: invalid actor identifier');
  }
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE crm_eurovia_runtime');
    const key = actor.kind === 'dashboard'
      ? 'crm_eurovia.dashboard_actor_id'
      : 'crm_eurovia.actor_id';
    await tx.$queryRaw`SELECT set_config(${key}, ${actor.id}, true)`;
    return run(tx);
  });
}
