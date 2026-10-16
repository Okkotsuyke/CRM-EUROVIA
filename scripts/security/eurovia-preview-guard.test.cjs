// CRM EUROVIA: enforce isolated frontend preview before Vercel deployment.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const turbo = JSON.parse(fs.readFileSync(path.join(root, 'turbo.json'), 'utf8'));
const vars = turbo.tasks.build.env;
assert.ok(vars.includes('CRM_EUROVIA_PREVIEW_ONLY'), 'Turbo must forward preview safety flag');
assert.ok(vars.includes('NEXT_PUBLIC_API_URL'), 'Turbo must forward explicit API host');

const target = 'https://crm-eurovia-o4hk341kc-maykengld-9931.vercel.app';
const webVercel = JSON.parse(fs.readFileSync(path.join(root, 'apps/web/vercel.json'), 'utf8'));
assert.equal(webVercel.git?.deploymentEnabled?.['fix/eurovia-hardening-deploy-20261015'], false,
  'CRM Eurovia preview branch must require manual deploy after CI');
const configPath = path.join(root, 'apps/web/next.config.js');
const keys = [
  'CRM_EUROVIA_PREVIEW_ONLY',
  'VERCEL_ENV',
  'NEXT_PUBLIC_API_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
];
const prev = Object.fromEntries(keys.map(k => [k,process.env[k]]));

function evaluate({previewFlag='true', env='preview', api=target, supabase}={}) {
  process.env.CRM_EUROVIA_PREVIEW_ONLY=previewFlag;
  process.env.VERCEL_ENV=env;
  process.env.NEXT_PUBLIC_API_URL=api;
  if(supabase === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL=supabase;
  delete require.cache[require.resolve(configPath)];
  return require(configPath);
}
try {
  const config = evaluate();
  assert.equal(config.env.NEXT_PUBLIC_API_URL,target,'Preview bound to CRM Neon-backed API');
  assert.throws(()=>evaluate({api:'https://some-other-project.vercel.app'}),/CRM EUROVIA/);
  assert.throws(()=>evaluate({env:'production'}),/CRM EUROVIA/);
  assert.throws(()=>evaluate({supabase:'https://wrong.supabase.co'}),/CRM EUROVIA/);
  const middleware=fs.readFileSync(path.join(root,'apps/web/middleware.ts'),'utf8');
  assert.match(middleware,/CRM_EUROVIA_PREVIEW_ONLY === 'true'/);
  const page=fs.readFileSync(path.join(root,'apps/web/app/avaliador/login/page.tsx'),'utf8');
  assert.doesNotMatch(page,/evaluator2024|Credenciais de demonstração/);
  console.log('CRM EUROVIA PREVIEW GUARD PASS: isolated target, env propagation and safe evaluator login');
} finally {
  for (const k of keys) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k]=prev[k];
  }
}
