# Retired-domain cutover

## Owner decision

On 15 September 2026, the owner requested an immediate, simple cutover because
the prelaunch preview had no users and had never been shared. This superseded
the earlier deep-link, download preservation, release-promotion dependency, and
observation requirements for the retired domain.

All requests to the retired apex and `www` hostnames redirect permanently to
`https://anmerko.com/`. Paths and query strings are discarded, including old
download and release-manifest URLs. Approved downloads and release-integrity
requirements on the canonical origin remain in force.

## Configuration

A dashboard-managed Cloudflare Single Redirect is first in its phase and active.
It matches both retired hostnames, returns status 301, targets the canonical
homepage, and does not preserve the query string. The proxied apex record and
proxied `www` CNAME remain so Cloudflare can apply the redirect. Mail DNS, domain
registration, and provider-side retired Worker state are outside repository
deployment.

Retired Worker source and Wrangler configurations have been removed and must not
be recreated or deployed. Current main deploys only `anmerko-site` and
`anmerko-support`. Normal site Deploy does not manage the dashboard rule. See
Cloudflare's [Single Redirect documentation](https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-dashboard/).

## Verification

The saved rule was verified at order 1 with both DNS records proxied. HTTP and
HTTPS requests using GET and HEAD redirected the apex and `www` hosts to the
canonical homepage across root, privacy, download, and manifest paths. The
redirect discarded paths and queries, preserved TLS verification, and reached
the canonical homepage in one hop. Browser navigation confirmed the same result.

No scheduled observation or retired-URL compatibility work remains. The
provider-managed redirect stays active; this repository does not manage or
delete it.

## Rollback

Disable the Single Redirect only as an authorized provider-side recovery step.
Do not deploy a retired application or restore removed Worker source. Permanent
redirects may be cached by clients. Worker, DNS, or domain deletion is outside
this repository cleanup.
