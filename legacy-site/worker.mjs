const CANONICAL = 'https://anmerko.com';
const LEGACY_HOSTS = new Set(['briefmark.app', 'www.briefmark.app']);

export function canonicalRedirect(source) {
  const target = new URL(CANONICAL);
  target.pathname = source.pathname;
  target.search = source.search;
  if (target.origin !== CANONICAL) throw new Error('Canonical redirect origin changed');
  return Response.redirect(target, 308);
}

export function legacyResponse(request, env) {
  const source = new URL(request.url);
  if (!LEGACY_HOSTS.has(source.hostname)) return new Response('Misdirected Request', { status: 421 });
  if (source.pathname === '/release-manifest.json' || /^\/downloads\/briefmark-[A-Za-z0-9_.-]+\.(?:zip|xpi)$/.test(source.pathname)) {
    return env.ASSETS.fetch(request);
  }
  if (source.pathname === '/downloads' || source.pathname.startsWith('/downloads/')) return new Response('Archived download not found', { status: 404 });
  return canonicalRedirect(source);
}

export default { fetch: legacyResponse };
