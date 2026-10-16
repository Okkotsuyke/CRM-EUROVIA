/**
 * Select the authorized API for the evaluator's same-origin Next.js proxy.
 *
 * Railway traffic is private service-to-service HTTP. Browser traffic never
 * targets railway.internal, and there is no Vercel bypass secret on Railway.
 *
 * Existing Vercel deployments retain their previous production/preview path
 * for rollback while we validate the containerized alternative.
 */
export type EuroviaUpstream = {
  baseUrl: string;
  headers: Record<string, string>;
};

const VERCEL_PREVIEW_API =
  'https://crm-eurovia-api-git-fix-eurovia-hardening-0307ad-maykengld-9931.vercel.app';
const VERCEL_PRODUCTION_API = 'https://crm-eurovia-api.vercel.app';

export function resolveEuroviaUpstream(): EuroviaUpstream | null {
  if (process.env.CRM_DEPLOY_TARGET === 'railway') {
    if (
      process.env.NODE_ENV !== 'production' ||
      process.env.CRM_EUROVIA_PRODUCTION_READONLY !== 'true'
    ) return null;

    const candidate = process.env.CRM_API_INTERNAL_URL;
    if (!candidate) return null;
    try {
      const url = new URL(candidate);
      if (
        url.protocol !== 'http:' ||
        !url.hostname.endsWith('.railway.internal') ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) return null;
      return { baseUrl: url.origin, headers: {} };
    } catch {
      return null;
    }
  }

  const isPreview =
    process.env.VERCEL_ENV === 'preview' &&
    process.env.CRM_EUROVIA_PREVIEW_ONLY === 'true';
  const isProduction =
    process.env.VERCEL_ENV === 'production' &&
    process.env.CRM_EUROVIA_PRODUCTION_READONLY === 'true';
  if (!isPreview && !isProduction) return null;

  const bypass = process.env.CRM_EUROVIA_VERCEL_BYPASS_SECRET;
  if (!bypass) return null;
  return {
    baseUrl: isProduction ? VERCEL_PRODUCTION_API : VERCEL_PREVIEW_API,
    headers: { 'x-vercel-protection-bypass': bypass },
  };
}
