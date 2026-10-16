#!/usr/bin/env bash
# CRM EUROVIA: PostgREST local; nunca usar banco Supabase ou Syonet.
set -euo pipefail
if [[ "$CRM_EUROVIA_RLS_CI" != 1 ||
      "$PGHOST" != "127.0.0.1" ||
      "$PGPORT" != 5432 ||
      "$PGDATABASE" != eurovia_rls_ci ||
      "$PGUSER" != postgres ]]; then
  echo "BLOQUEADO: este teste executa apenas no CI de CRM EUROVIA"; exit 1
fi

db() { psql -X -qAt -v ON_ERROR_STOP=1 "$@"; }
if [[ "$(db -c 'select current_database()')" != eurovia_rls_ci ]]; then
  echo "BLOQUEADO: database inesperado"; exit 1
fi

export EUROVIA_CI_JWT_SECRET='eurovia-postgrest-ci-only-secret-2026-1234567890'
token_for_role() {
  TEST_ROLE="$1" node <<'NODE'
const {createHmac} = require('node:crypto');
const base = x => Buffer.from(JSON.stringify(x)).toString('base64url');
const hdr = base({alg:'HS256',typ:'JWT'});
const body = base({role:process.env.TEST_ROLE,exp:Math.floor(Date.now()/1000)+1800});
const input = hdr+'.'+body;
const sig = createHmac('sha256',process.env.EUROVIA_CI_JWT_SECRET)
  .update(input).digest('base64url');
process.stdout.write(input+'.'+sig);
NODE
}
auth_token="$(token_for_role authenticated)"
service_token="$(token_for_role service_role)"
name=crm-eurovia-postgrest-ci
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$name" --network host \
  -e PGRST_DB_URI='postgresql://postgres:ci-only-postgres@127.0.0.1:5432/eurovia_rls_ci' \
  -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$EUROVIA_CI_JWT_SECRET" \
  -e PGRST_SERVER_PORT=3000 \
  postgrest/postgrest:v16.3 >/dev/null

positive=000
for attempt in $(seq 1 40); do
  positive="$(curl -sS --max-time 3 -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $service_token" \
    'http://127.0.0.1:3000/stores?id=eq.ci-loja-1' 2>/dev/null || true)"
  if [[ "$positive" == 200 ]]; then break; fi
  sleep 1
done
if [[ "$positive" != 200 ]]; then
  echo "FALHOU: PostgREST nao respondeu como service_role."
  docker logs --tail 50 "$name" || true
  exit 1
fi
echo "HTTP 1: controle positivo service_role 200"

for table in stores users media_sources leads lead_events appointments flow_events sales productivity_snapshots sync_runs refresh_tokens sync_metrics dashboard_users validation_reports; do
  for role in anon authenticated; do
    if [[ "$role" == anon ]]; then
      status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
        "http://127.0.0.1:3000/$table?select=*" || true)"
    else
      status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer $auth_token" \
        "http://127.0.0.1:3000/$table?select=*" || true)"
    fi
    if [[ "$status" != 401 && "$status" != 403 ]]; then
      echo "FALHOU: $role GET $table, status $status"; exit 1
    fi
  done
done
echo "HTTP 2: anon/authenticated sem leitura nas 14 tabelas"

payload='{"id":"ci-loja-2","shortName":"CI Teste","syonetName":"CI_SINTETICO_2","plaza":"FORTALEZA","city":"Fortaleza","state":"CE","timezone":"America/Fortaleza","updated_at":"2026-10-15T12:00:00Z"}'
for role in anon authenticated; do
  for method in POST PATCH DELETE; do
    if [[ "$role" == anon ]]; then
      status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
        -X "$method" -H 'Content-Type: application/json' \
        --data "$payload" \
        "http://127.0.0.1:3000/stores?id=eq.ci-loja-1" || true)"
    else
      status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
        -X "$method" -H 'Content-Type: application/json' \
        -H "Authorization: Bearer $auth_token" \
        --data "$payload" \
        "http://127.0.0.1:3000/stores?id=eq.ci-loja-1" || true)"
    fi
    if [[ "$status" != 401 && "$status" != 403 ]]; then
      echo "FALHOU: $role $method stores, status $status"; exit 1
    fi
  done
done
echo "HTTP 3: POST/PATCH/DELETE anon/authenticated negados"

unchanged="$(db -c "SELECT count(*) FROM public.stores WHERE id='ci-loja-1' AND city='Fortaleza';")"
not_created="$(db -c "SELECT count(*) FROM public.stores WHERE id='ci-loja-2';")"
if [[ "$unchanged" != 1 || "$not_created" != 0 ]]; then
  echo "FALHOU: dados de fixture local alterados"; exit 1
fi
echo "HTTP 4: fixture permaneceu intacta"
echo "HOMOLOGACAO POSTGREST LOCAL APROVADA. Nenhum Supabase hospedado acessado."
