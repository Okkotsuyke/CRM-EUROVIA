import { describe, expect, it } from 'vitest';
import { isValidCronAuthorization } from '../routes/cron.routes';

const secret = 'cron-test-secret-32-chars-0123456789abcdef';

describe('autorizacao de cron (sem rede)', () => {
  it('recusa segredo ausente ou curto', () => {
    expect(isValidCronAuthorization('Bearer qualquer', undefined)).toBe(false);
    expect(isValidCronAuthorization('Bearer curto', 'curto')).toBe(false);
  });
  it('recusa cabecalho informativo, valor diferente ou formato incorreto', () => {
    expect(isValidCronAuthorization(undefined, secret)).toBe(false);
    expect(isValidCronAuthorization('Bearer errado', secret)).toBe(false);
    expect(isValidCronAuthorization('Basic ' + secret, secret)).toBe(false);
  });
  it('autoriza apenas bearer forte exato', () => {
    expect(isValidCronAuthorization('Bearer ' + secret, secret)).toBe(true);
  });
});
