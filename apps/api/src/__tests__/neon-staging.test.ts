import { describe, it, expect, vi } from 'vitest';
import {
  NEON_STAGING,
  validateNeonStagingEnv,
  checkNeonStagingReadiness,
  withNeonStagingActor,
} from '../services/neon-staging';

const example = {
  CRM_NEON_STAGING_MODE: 'true',
  CRM_NEON_PROJECT_ID: NEON_STAGING.project,
  CRM_NEON_BRANCH_ID: NEON_STAGING.branch,
  SYONET_USE_REAL: 'false',
  SYNC_ENABLED: 'false',
  VERCEL_ENV: 'preview',
  DATABASE_URL: 'postgresql://crm_eurovia_staging_login:sandbox-only@ep-test.c-2.sa-east-1.aws.neon.tech/crm_eurovia?sslmode=require',
};
describe('CRM Eurovia staging Neon guard', () => {
  it('accepts only staging project, branch, role, TLS and Brazil region', () => {
    expect(() => validateNeonStagingEnv(example as any)).not.toThrow();
  });
  it.each([
    ['project', { CRM_NEON_PROJECT_ID: 'nameless-night-94061643' }],
    ['branch', { CRM_NEON_BRANCH_ID: 'br-delicate-sound-b6l7thd1' }],
    ['production', { VERCEL_ENV: 'production' }],
    ['syonet', { SYONET_USE_REAL: 'true' }],
    ['sync', { SYNC_ENABLED: 'true' }],
    ['privileged login', { DATABASE_URL: example.DATABASE_URL.replace('crm_eurovia_staging_login', 'crm_eurovia_owner') }],
    ['other host', { DATABASE_URL: example.DATABASE_URL.replace('.sa-east-1.aws.neon.tech', '.us-east-1.aws.neon.tech') }],
    ['insecure', { DATABASE_URL: example.DATABASE_URL.replace('sslmode=require', 'sslmode=disable') }],
  ])('denies %s', (_, change) => {
    expect(() => validateNeonStagingEnv({ ...example, ...change } as any)).toThrow();
  });
  it('confirms the login is not BYPASSRLS and a missing actor sees zero rows', async () => {
    const execute = vi.fn().mockResolvedValueOnce(1);
    const query = vi.fn().mockResolvedValueOnce([{ visible: 0n }]);
    const fake = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{
        db: 'crm_eurovia',
        role_name: 'crm_eurovia_staging_login',
        bypass: false,
        rls_tables: 14n,
      }]),
      $transaction: vi.fn(async (fn: any) => fn({
        $executeRawUnsafe: execute,
        $queryRaw: query,
      })),
    };
    await expect(checkNeonStagingReadiness(fake as any)).resolves.toEqual({
      connected: true, restrictedRole: true, rlsTables: 14,
    });
    expect(execute).toHaveBeenCalledWith('SET LOCAL ROLE crm_eurovia_runtime');
  });
  it('fails closed when actor absent can read stores', async () => {
    const fake = {
      $queryRaw: vi.fn().mockResolvedValue([{
        db: 'crm_eurovia', role_name: 'crm_eurovia_staging_login',
        bypass: false, rls_tables: 14n,
      }]),
      $transaction: vi.fn(async (fn: any) => fn({
        $executeRawUnsafe: vi.fn(),
        $queryRaw: vi.fn().mockResolvedValue([{ visible: 1n }]),
      })),
    };
    await expect(checkNeonStagingReadiness(fake as any)).rejects.toThrow(/missing RLS actor/);
  });
  it('requires explicit validated actor identifiers for scoped queries', async () => {
    const fake = { $transaction: vi.fn() };
    await expect(withNeonStagingActor(fake as any, {id: '',kind:'user'}, async()=>1))
      .rejects.toThrow(/invalid actor/);
    expect(fake.$transaction).not.toHaveBeenCalled();
  });
});
