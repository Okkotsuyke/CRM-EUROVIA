import { describe, expect, it, vi } from 'vitest';
import {
  NeonAccessDenied, parseVerifiedNeonClaims, withNeonAuthSql,
  neonSignInUser, neonRefreshUser, neonLogoutUser, neonSignInDashboard,
  withNeonOperationalPrincipal, withNeonDashboardPrincipal,
} from '../services/neon-auth-bridge';

function fakeDb() {
  const tx = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findUnique: vi.fn() },
    dashboardUser: { findUnique: vi.fn() },
    store: { findMany: vi.fn(), findFirst: vi.fn() },
  };
  const db = {
    $transaction: vi.fn(async (callback: (tx: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return { db, tx };
}

describe('Neon staging auth and transaction invariants', () => {
  it('accepts only verified claims of the expected token type', () => {
    expect(parseVerifiedNeonClaims({ id: 'user-a', role: 'ADMIN' }, 'user').id).toBe('user-a');
    expect(parseVerifiedNeonClaims({ id: 'evaluator', type: 'dashboard' }, 'dashboard').id).toBe('evaluator');
    expect(() => parseVerifiedNeonClaims({id:'user-a',type:'refresh'},'user')).toThrow(NeonAccessDenied);
    expect(() => parseVerifiedNeonClaims({id:'user-a',type:'dashboard'},'user')).toThrow(NeonAccessDenied);
    expect(() => parseVerifiedNeonClaims({id:'user-a'},'dashboard')).toThrow(NeonAccessDenied);
    expect(() => parseVerifiedNeonClaims({id:''},'user')).toThrow(NeonAccessDenied);
    expect(() => parseVerifiedNeonClaims(null,'user')).toThrow(NeonAccessDenied);
  });

  it('sets local least-privilege SQL role before calling auth function', async () => {
    const {db,tx}=fakeDb();
    await withNeonAuthSql(db as any, async (trx) => {
      expect(trx).toBe(tx);
      expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL ROLE crm_eurovia_runtime');
      return true;
    });
    expect(db.$transaction).toHaveBeenCalledOnce();
  });

  it('does not query table passwords; login uses only SECURITY DEFINER function', async () => {
    const {db,tx}=fakeDb();
    tx.$queryRaw.mockResolvedValueOnce([{user_id:'user-a',user_name:'user-a',refresh_token:'a'.repeat(64)}]);
    const session=await neonSignInUser(db as any,'user-a','password-provided-by-client');
    expect(session?.user_id).toBe('user-a');
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL ROLE crm_eurovia_runtime');
    expect(tx.user.findUnique).not.toHaveBeenCalled();
    const template=tx.$queryRaw.mock.calls[0]?.[0];
    expect(String(template?.[0])).toContain('crm_security.login_user(');
    expect(tx.$queryRaw.mock.calls[0].slice(1)).toEqual(['user-a','password-provided-by-client']);
  });

  it('rotates and revokes through restricted functions rather than raw table access', async () => {
    const {db,tx}=fakeDb();
    tx.$queryRaw.mockResolvedValueOnce([{user_id:'user-a',refresh_token:'b'.repeat(64)}])
      .mockResolvedValueOnce([{revoked:true}]);
    const session=await neonRefreshUser(db as any,'a'.repeat(64));
    expect(session?.refresh_token).toBe('b'.repeat(64));
    expect(await neonLogoutUser(db as any,'b'.repeat(64))).toBe(true);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(String(tx.$queryRaw.mock.calls[0][0][0])).toContain('crm_security.refresh_user(');
    expect(String(tx.$queryRaw.mock.calls[1][0][0])).toContain('crm_security.logout_user(');
  });

  it('dashboard login never grants SELECT on password hash', async () => {
    const {db,tx}=fakeDb();
    tx.$queryRaw.mockResolvedValueOnce([{user_id:'evaluator',user_role:'VIEWER',allowed_stores:['store-a']}]);
    const session=await neonSignInDashboard(db as any,'evaluator','password');
    expect(session?.allowed_stores).toEqual(['store-a']);
    expect(String(tx.$queryRaw.mock.calls[0][0][0])).toContain('crm_security.login_dashboard(');
    expect(tx.dashboardUser.findUnique).not.toHaveBeenCalled();
  });

  it('revalidates active user and role from RLS DB, ignoring forged JWT claims', async () => {
    const {db,tx}=fakeDb();
    tx.user.findUnique.mockResolvedValue({
      id:'user-a',username:'operator',name:'Operator A',email:null,
      role:'VL_CONSULTANT',storeId:'store-a',active:true,
    });
    const act=vi.fn(async (_:unknown,user:unknown) => user);
    const result=await withNeonOperationalPrincipal(db as any,{
      id:'user-a',role:'ADMIN',storeId:'store-b',
    },act);
    expect(result).toMatchObject({role:'VL_CONSULTANT',storeId:'store-a'});
    expect(act).toHaveBeenCalledOnce();
    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where:{id:'user-a'},
      select:{id:true,name:true,username:true,email:true,role:true,storeId:true,active:true},
    });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL ROLE crm_eurovia_runtime');
  });

  it('blocks inactive and non-admin users without assigned store', async () => {
    const {db,tx}=fakeDb();
    const action=vi.fn();
    tx.user.findUnique.mockResolvedValueOnce({id:'user-a',active:false,role:'ADMIN',storeId:null})
      .mockResolvedValueOnce({id:'user-a',active:true,role:'MANAGER',storeId:null});
    await expect(withNeonOperationalPrincipal(db as any,{id:'user-a'},action))
      .rejects.toThrow(NeonAccessDenied);
    await expect(withNeonOperationalPrincipal(db as any,{id:'user-a'},action))
      .rejects.toThrow(NeonAccessDenied);
    expect(action).not.toHaveBeenCalled();
  });

  it('revalidates evaluator allowedStores in DB and denies empty scopes', async () => {
    const {db,tx}=fakeDb();
    const action=vi.fn(async (_:unknown,user:unknown) => user);
    tx.dashboardUser.findUnique.mockResolvedValueOnce({
      id:'evaluator',username:'eval',name:'Evaluator',role:'VIEWER',
      active:true,allowedStores:['store-a'],
    }).mockResolvedValueOnce({
      id:'evaluator',username:'eval',name:'Evaluator',role:'VIEWER',
      active:true,allowedStores:[],
    });
    const out=await withNeonDashboardPrincipal(db as any,{
      id:'evaluator',type:'dashboard',allowedStores:['store-b'],
    },action);
    expect(out).toMatchObject({allowedStores:['store-a']});
    await expect(withNeonDashboardPrincipal(db as any,{
      id:'evaluator',type:'dashboard',allowedStores:['store-b'],
    },action)).rejects.toThrow(NeonAccessDenied);
    expect(action).toHaveBeenCalledOnce();
  });
});
