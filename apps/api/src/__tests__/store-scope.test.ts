import { describe, it, expect } from 'vitest';
import { authorizedStoreIds, canAccessStore, storeIdFilter } from '../services/store-scope';

describe('autorizacao por loja CRM EUROVIA', () => {
  const user = {role: 'VL_CONSULTANT' as const, storeId: 'loja-a'};
  it('bloqueia pedido de outra loja sem ampliar filtros', () => {
    expect(authorizedStoreIds(user, ['loja-b'])).toEqual([]);
    expect(storeIdFilter(user, ['loja-b'])).toEqual({in: []});
    expect(canAccessStore(user, 'loja-b')).toBe(false);
  });
  it('permite apenas loja do usuario quando filtro e omitido', () => {
    expect(authorizedStoreIds(user)).toEqual(['loja-a']);
    expect(storeIdFilter(user)).toEqual({in: ['loja-a']});
    expect(canAccessStore(user, 'loja-a')).toBe(true);
  });
  it('nega usuario sem loja, inclusive MANAGER', () => {
    expect(authorizedStoreIds({role: 'MANAGER',storeId:null})).toEqual([]);
  });
  it('somente ADMIN pode ser explicitamente global', () => {
    expect(authorizedStoreIds({role:'ADMIN',storeId:null})).toBeNull();
    expect(storeIdFilter({role:'ADMIN',storeId:null})).toBeUndefined();
    expect(authorizedStoreIds({role:'ADMIN',storeId:null},['loja-b'])).toEqual(['loja-b']);
  });
});
