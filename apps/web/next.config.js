/** @type {import('next').NextConfig} */
const path = require('node:path');
// Aplicado apenas ao Preview isolado CRM EUROVIA; producao nao e alterada.
const previewOnly = process.env.CRM_EUROVIA_PREVIEW_ONLY === 'true';
const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
if (previewOnly && (
  process.env.VERCEL_ENV !== 'preview' ||
  apiBase !== 'https://crm-eurovia-o4hk341kc-maykengld-9931.vercel.app' ||
  process.env.NEXT_PUBLIC_SUPABASE_URL
)) {
  throw new Error('CRM EUROVIA: Preview precisa usar API staging autorizada e nunca Supabase');
}
const nextConfig = {
  // Build a self-contained Next.js server from the monorepo root.
  output: 'standalone',
  outputFileTracingRoot: path.resolve(__dirname, '../..'),
  transpilePackages: ['@crm/shared', '@supabase/ssr', '@supabase/supabase-js'],
  env: { NEXT_PUBLIC_API_URL: apiBase },
};
module.exports = nextConfig;
