# Legacy domain cutover

## Owner decision

On 15 September 2026, Ryan requested an immediate, simple cutover because
the prelaunch preview had no users and had never been shared. This supersedes issue #76's
old deep-link, download/manifest preservation, release-promotion dependency,
and 24–48-hour observation requirements for the legacy domain.

All web requests to `briefmark.app` and `www.briefmark.app` redirect to
`https://anmerko.com/`. Old paths and query strings are discarded, including
download and release-manifest URLs. New-domain approved downloads and release
integrity requirements remain in force.

## Configuration

Cloudflare zone: `briefmark.app`. Single Redirect, first in its phase, active
on 15 September 2026. Rule ID: `a1bf3ce6d1104f1f9b20b480bd7fe67f`.

```json
{
  "description": "briefmark to anmerko homepage",
  "expression": "(http.host in {\"briefmark.app\" \"www.briefmark.app\"})",
  "action": "redirect",
  "action_parameters": {
    "from_value": {
      "status_code": 301,
      "target_url": { "value": "https://anmerko.com/" },
      "preserve_query_string": false
    }
  },
  "enabled": true
}
```

The existing proxied apex record remains. A proxied `www` CNAME targeting
`briefmark.app` was added with automatic TTL. Mail DNS, domain registration
and old Worker deployments are retained as an optional rollback;
the redirect intercepts old-host web traffic before application serving.
Current main deploys only the new `anmerko-site` and `anmerko-support` Workers.

This is a dashboard-managed rule; normal site Deploy does not manage it.
See Cloudflare's [Single Redirect documentation](https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-dashboard/).

## Verification

Before cutover, the old homepage and privacy page returned 200, old `www`
had no DNS record, and the new homepage and release manifest returned 200.

Post-cutover verification at 13:14 UTC on 15 September 2026:

- Cloudflare shows the rule active at order 1 and the saved proxied CNAME.
- Both old hostnames return `301 Location: https://anmerko.com/` for HTTP and
  HTTPS, GET and HEAD, across `/`, `/support/privacy/?cutover=1`, an old download
  path, and `/release-manifest.json` (32 checks).
- Apex checks used ordinary DNS. The new `www` record resolves through both
  Cloudflare `1.1.1.1` and Google `8.8.8.8`; its 16 curl checks used that returned
  address with `--resolve` because the local system retained a negative cache.
  TLS certificate verification remained enabled.
- Following either HTTPS hostname reaches the new homepage with 200 in one hop.
- Actual Chrome navigation from an old privacy URL and an old `www` path/query
  reaches `https://anmerko.com/`, displaying the anmerko homepage and its GitHub
  and Report Issue links. Chrome resolved `www` normally.

No scheduled observation or legacy URL compatibility work remains under the
owner's simplified cutover decision. Deleting retained infrastructure is optional.

## Rollback

Disable the named Single Redirect to restore the previous apex serving path.
Do not rerun a historical old-domain deployment. Permanent redirects may be
cached by clients. Worker or domain deletion is not part of this cutover.
