/**
 * Isolamento de lojas no CRM EUROVIA.
 * Somente ADMIN pode acessar multiplas lojas sem lista explicita.
 * MANAGER e perfis operacionais precisam de storeId valido.
 * Um filtro de query NUNCA amplia permissoes do usuario.
 *
 * SQL/PostgREST: a politica RLS deny-by-default e uma barreira separada.
 */
import type { UserRole } from '@prisma/client';

export type StorePrincipal = {
  role: UserRole;
  storeId: string | null;
};

/**
 * null: sem restricao (somente ADMIN)
 * []: negado / nenhuma loja
 */
export function authorizedStoreIds(user: StorePrincipal, requested?: readonly string[]): string[] | null {
  if (user.role === 'ADMIN') return requested?.length ? [...requested] : null;
  if (!user.storeId) return [];
  return requested?.length && !requested.includes(user.storeId) ? [] : [user.storeId];
}

export function storeIdFilter(
  user: StorePrincipal,
  requested?: readonly string[],
): { in: string[] } | undefined {
  const ids = authorizedStoreIds(user, requested);
  return ids === null ? undefined : { in: ids };
}

export function canAccessStore(user: StorePrincipal, storeId: string): boolean {
  return user.role === 'ADMIN' || (!!user.storeId && user.storeId === storeId);
}
