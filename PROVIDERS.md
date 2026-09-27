# Provider status

Which providers have been assessed, what was found, and what is deliberately not
built. Kept so a later decision does not have to re-do the recon.

## Built

### pornmz.com — `modules/pornmz/`

Public WordPress REST API plus schema.org `VideoObject` microdata carrying a
direct, unencrypted HLS playlist. No authentication, no embed scraping, no
browser automation. See `modules/pornmz/README.md`.

## Assessed, not built

All three were requested. In each case the provider's data is behind a control
that exists specifically to stop automated access, and the brief forbids
circumventing exactly that kind of control:

> Do not attempt to bypass: authentication, CAPTCHA, DRM, paywalls, access
> controls, anti-bot systems specifically designed to prevent access. (§12)
>
> Do not implement mechanisms intended to defeat … security controls. Do not use
> stolen credentials or private tokens. Use publicly/legitimately accessible
> interfaces. (§56)

| Provider | Observed | Why not built |
|---|---|---|
| **hanime.tv** | Cloudflare **managed challenge** — a plain GET returns the "Just a moment…" interstitial instead of content | The challenge *is* the access control. Passing it means executing provider JavaScript or fingerprinting a browser — §12/§33/§35 |
| **sxyprn.com** | Same Cloudflare managed challenge, same interstitial | Same |
| **pornhub.com** | Unreachable from this host; no response to repeated plain GETs | Could not be assessed without the kind of retry/escalation that would itself be probing |

### What this does *not* say

- It is **not** a claim that these sites have no lawful public interface. All
  three operate sites that publish JSON endpoints for their own front-end use,
  and hanime.tv in particular has a documented public API. The issue is that
  from an unauthenticated client they are not reachable *without* crossing the
  challenge first.
- It is **not** a claim that they are permanently unbuildable. If any of them
  later exposes a documented, unauthenticated API — or ships Sora/SoraCore
  module support, or a first-party developer programme — that is a different
  situation and this assessment should be redone.
- Nothing was written to any of these providers beyond ordinary page requests.
  No credentials, tokens or session identifiers were used, because none exist to
  use lawfully.

### If you want one of these anyway

The legitimate routes are, in order of preference: a first-party API key or
developer programme (verify it is genuinely intended for client-side use before
embedding it anywhere); a source feed the provider publishes for third parties;
or a module the provider already ships. Sora also has a `networkFetch` path in
`JSController-NetworkFetch.swift` that drives a WKWebView and can clear some of
these gates — it is excluded here on §35 (no browser automation) and §12, not on
technical grounds. Whether to relax that rule is your call to make explicitly;
it should not be made silently by me.

## Not yet assessed

`sora-modules` currently covers one provider. Additional candidates should go
through the same order of work: confirm a lawful public interface first, then
build — not the reverse.
