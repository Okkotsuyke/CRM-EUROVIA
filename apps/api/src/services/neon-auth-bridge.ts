/**
 * CRM Eurovia: Neon staging authentication and transaction-level RLS.
 * No privileged DB role, Syonet access, or broad Prisma client escapes.
 * All callbacks receive the SAME Prisma TransactionClient used for SET LOCAL.
 */
import type { Prisma, PrismaClient, UserRole } from '@prisma/client';
import { withNeonStagingActor } from './neon-staging';

type Database = Pick<PrismaClient, '$transaction'>;

export class NeonAccessDenied extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'NeonAccessDenied';
  }
}

export type OperationalPrincipal = {
  id: string;
  name: string;
  username: string;
  email: string | null;
  role: UserRole;
  storeId: string | null;
  active: boolean;
};

export type DashboardPrincipal = {
  id: string;
  username: string;
  name: string;
  role: string;
  active: boolean;
  allowedStores: string[];
};

export type OperationalSession = {
  user_id: string;
  user_name: string;
  display_name: string;
  email: string | null;
  user_role: UserRole;
  store_id: string | null;
  refresh_token: string;
  expires_at: Date;
};

export type DashboardSession = {
  user_id: string;
  user_name: string;
  display_name: string;
  user_role: string;
  allowed_stores: string[];
};

export function parseVerifiedNeonClaims(
  value: unknown, kind: 'user' | 'dashboard',
): { id: string; kind: 'user' | 'dashboard' } {
  if (!value || typeof value !== 'object') throw new NeonAccessDenied();
  const claims = value as { id?: unknown; type?: unknown };
  if (typeof claims.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{3,128}$/.test(claims.id)) {
    throw new NeonAccessDenied();
  }
  if (kind === 'user' ? claims.type !== undefined : claims.type !== 'dashboard') {
    throw new NeonAccessDenied();
  }
  return { id: claims.id, kind };
}

/** Internal DB functions are callable ONLY after SET LOCAL to non-bypass role. */
export async function withNeonAuthSql<T>(
  prisma: Database,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE crm_eurovia_runtime');
    return action(tx);
  }, { maxWait: 5000, timeout: 8000 });
}

export async function neonSignInUser(
  prisma: Database, username: string, password: string,
): Promise<OperationalSession | null> {
  return withNeonAuthSql(prisma, async tx => {
    const rows = await tx.$queryRaw<OperationalSession[]>`SELECT * FROM crm_security.login_user(${username}, ${password})`;
    return rows[0] ?? null;
  });
}

export async function neonRefreshUser(
  prisma: Database, refreshToken: string,
): Promise<OperationalSession | null> {
  return withNeonAuthSql(prisma, async tx => {
    const rows = await tx.$queryRaw<OperationalSession[]>`SELECT * FROM crm_security.refresh_user(${refreshToken})`;
    return rows[0] ?? null;
  });
}

export async function neonLogoutUser(
  prisma: Database, refreshToken: string,
): Promise<boolean> {
  return withNeonAuthSql(prisma, async tx => {
    const rows = await tx.$queryRaw<Array<{ revoked: boolean }>>`SELECT crm_security.logout_user(${refreshToken}) AS revoked`;
    return rows[0]?.revoked === true;
  });
}

export async function neonSignInDashboard(
  prisma: Database, username: string, password: string,
): Promise<DashboardSession | null> {
  return withNeonAuthSql(prisma, async tx => {
    const rows = await tx.$queryRaw<DashboardSession[]>`SELECT * FROM crm_security.login_dashboard(${username}, ${password})`;
    return rows[0] ?? null;
  });
}

/**
 * Caller MUST obtain claims from Fastify's jwtVerify(), never from body,
 * headers without cryptographic verification, or arbitrary request data.
 */
export async function withNeonOperationalPrincipal<T>(
  prisma: Database, verifiedClaims: unknown,
  action: (tx: Prisma.TransactionClient, actor: OperationalPrincipal) => Promise<T>,
): Promise<T> {
  const claims = parseVerifiedNeonClaims(verifiedClaims, 'user');
  return withNeonStagingActor(prisma, claims, async tx => {
    const principal = await tx.user.findUnique({
      where: { id: claims.id },
      select: {
        id: true, name: true, username: true, email: true,
        role: true, storeId: true, active: true,
      },
    });
    if (!principal?.active ||
        (principal.role !== 'ADMIN' && !principal.storeId)) {
      throw new NeonAccessDenied();
    }
    return action(tx, principal);
  });
}

export async function withNeonDashboardPrincipal<T>(
  prisma: Database, verifiedClaims: unknown,
  action: (tx: Prisma.TransactionClient, actor: DashboardPrincipal) => Promise<T>,
): Promise<T> {
  const claims = parseVerifiedNeonClaims(verifiedClaims, 'dashboard');
  return withNeonStagingActor(prisma, claims, async tx => {
    const principal = await tx.dashboardUser.findUnique({
      where: { id: claims.id },
      select: {
        id: true, username: true, name: true,
        role: true, active: true, allowedStores: true,
      },
    });
    if (!principal?.active ||
        !['ADMIN', 'VIEWER'].includes(principal.role) ||
        !principal.allowedStores.length) {
      throw new NeonAccessDenied();
    }
    return action(tx, principal);
  });
}
