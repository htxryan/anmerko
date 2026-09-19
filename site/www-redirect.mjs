const CANONICAL_ORIGIN = 'https://anmerko.com';
const WWW_HOST = 'www.anmerko.com';

export default {
  fetch(request) {
    const source = new URL(request.url);
    if (source.hostname !== WWW_HOST) {
      return new Response('Misdirected Request', { status: 421 });
    }

    const target = new URL(CANONICAL_ORIGIN);
    target.pathname = source.pathname;
    target.search = source.search;
    return Response.redirect(target, 308);
  },
};
