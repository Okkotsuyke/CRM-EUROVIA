# CRM EUROVIA — Fase de autorizacao (15/10/2026)

## Situacao
- Projeto Supabase exclusivo: `crm-eurovia`, `sa-east-1`.
- 14 tabelas public com RLS inativa; grants amplos a `anon` e
  `authenticated`. Confirmado por inspeção somente leitura.
- O front usa majoritariamente JWT do Fastify; Supabase Auth nao substituiu
  integralmente a identidade legada.
- `docs/security/eurovia-rls-firewall.sql` e uma PROPOSTA NAO APLICADA.

## Ajustes de codigo neste PR
1. JWT nao autoriza usuario inexistente/inativo; role/loja sao recarregadas
   do DB por requisicao, impedindo confiar em privilegio antigo.
2. A funcao `storeIdFilter` implementa deny-by-default para perfis sem loja.
   ADMIN pode operar multi-loja; MANAGER e outros perfis requerem loja atual.
3. Filtros `storeIds` recebidos pelo frontend nunca substituem a restricao
   do usuario. Dashboard, lojas e usuarios usam intersecao de escopos.
4. Removido texto de credencial demo na tela de login e a senha-padrao
   automatica na criacao de usuario.
5. Testes de escopo sem acesso a Syonet.

## Proximas verificacoes antes da aplicacao no banco
- Homologar usuarios administradores e gestores multi-loja contratados.
- Ensaiar SQL em staging com dados sinteticos e testes de roles/PostgREST.
- Validar DB role de Prisma, permissao de migrador, RLS e policies adicionais
  por loja para acesso direto quando Supabase Auth estiver completo.
- Revisar endpoints `leads`, `appointments`, `analytics`, `validation`
  e `productivity` para evitar bypass por ID/agragacoes.
- API Vercel pode ficar READY mas falhar no runtime se faltar DATABASE_URL.
  Verificar health via deployment autorizado e sem revelar segredos.
- Rotacionar material de sessao removido do repositorio publico.
- NENHUMA operacao ao Syonet; integracao read-only deve falhar fechada.

## Testes necessarios
- Conta loja A consulta loja B por filtro, ID conhecido e aggregacao => 403/404/vazio.
- Perfil com `storeId=null` que nao seja ADMIN => sem dados.
- Conta inativa com JWT antigo => 401.
- ALTER TABLE RLS+REVOKE protege anon/authenticated => 42501.
- Prisma com usuario runtime de menor privilegio => nenhuma fuga entre lojas.
