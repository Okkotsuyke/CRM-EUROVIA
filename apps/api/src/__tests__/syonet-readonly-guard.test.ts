import { describe, expect, it } from 'vitest';
import { checkSyonetReadOnlyRequest, assertSyonetReadOnlyRequest } from '../services/syonet-readonly-guard';

const base = 'https://viasul.syonet.com';

describe('politica imutavel de somente leitura Syonet', () => {
  it('permite exclusivamente APIs de dados e navegacao de leitura aprovadas', () => {
    expect(checkSyonetReadOnlyRequest(base + '/api/dashboard/189?empresa=71', 'GET', base).allowed).toBe(true);
    expect(checkSyonetReadOnlyRequest(base + '/api/evento?page=0&size=200', 'GET', base).allowed).toBe(true);
    expect(checkSyonetReadOnlyRequest(base + '/portal/app.do?modulo=login', 'GET', base).allowed).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('impede %s mesmo em endpoint de leitura', method => {
    expect(checkSyonetReadOnlyRequest(base + '/api/empresa', method, base).allowed).toBe(false);
  });

  it('permite somente o POST exato do formulario de login do portal', () => {
    expect(checkSyonetReadOnlyRequest(base + '/portal/app.do?modulo=login', 'POST', base).allowed).toBe(true);
    expect(checkSyonetReadOnlyRequest(base + '/portal/app.do?modulo=login', 'POST', base).reason).toBe('read-only-login');
    expect(checkSyonetReadOnlyRequest(base + '/portal/app.do?modulo=login&acao=excluir', 'POST', base).allowed).toBe(false);
    expect(checkSyonetReadOnlyRequest(base + '/api/login', 'POST', base).allowed).toBe(false);
    expect(checkSyonetReadOnlyRequest(base + '/api/empresa', 'POST', base).allowed).toBe(false);
  });

  it('bloqueia GET de efeito colateral e rotas sem allowlist', () => {
    expect(checkSyonetReadOnlyRequest(base + '/api/excluir/1', 'GET', base).allowed).toBe(false);
    expect(checkSyonetReadOnlyRequest(base + '/api/evento?acao=delete', 'GET', base).allowed).toBe(false);
    expect(checkSyonetReadOnlyRequest(base + '/api/unknown', 'GET', base).allowed).toBe(false);
    expect(checkSyonetReadOnlyRequest(base + '/portal/reset', 'GET', base).allowed).toBe(false);
  });

  it('recusa host incorreto e HTTP inseguro', () => {
    expect(checkSyonetReadOnlyRequest('https://outro.syonet.com/api/dashboard', 'GET', base).allowed).toBe(false);
    expect(checkSyonetReadOnlyRequest('http://viasul.syonet.com/api/dashboard', 'GET', base).allowed).toBe(false);
  });

  it('falha fechado e nao envia requisicao', () => {
    expect(() => assertSyonetReadOnlyRequest(base + '/api/empresa', 'POST', base)).toThrow(/somente leitura/);
  });
});
