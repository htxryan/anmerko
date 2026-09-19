import { canonicalRedirect } from './worker.mjs';

export default {
  fetch(request) {
    const source = new URL(request.url);
    if (source.hostname !== 'www.anmerko.com') return new Response('Misdirected Request', { status: 421 });
    return canonicalRedirect(source);
  },
};
