#!/usr/bin/env python3
"""Resolve a fuckingfast.co landing page to its real dl.fuckingfast.co direct URL.

Cloudflare blocks plain OS/Node TLS fingerprints at the edge with a "Just a
moment..." challenge, but it lets real Chrome traces straight through. curl_cffi
impersonates a full Chrome TLS/HTTP2 handshake, so the landing page loads and
the HTMX POST returns the signed direct download URL in its HX-Redirect header.

Usage:
    python ffResolver.py <https://fuckingfast.co/<fileId>[#something]>

Prints:
    DIRECT:<signed dl.fuckingfast.co URL>        on success (exit 0)
    BLOCKED:<short reason>                       when Cloudflare/rate-limit stops it
    ERROR:<short reason>                         on any other failure
"""

import re
import sys
from urllib.parse import urlparse

from curl_cffi import requests as cr

def looks_blocked(status, body):
    """True only when the response is the Cloudflare interstitial, not the
    real landing page (which legitimately references challenge scripts)."""
    if status == 429:
        return "rate-limited (429), wait a few minutes"
    if status == 403 or status == 503:
        lower = body.lower()
        if "just a moment" in lower or "__cf_chl" in lower:
            return "Cloudflare edge challenge could not be passed"
    lower = (body or "").lower()
    if "just a moment" in lower and ("cf_chl" in lower or "challenge-platform" in lower):
        return "Cloudflare edge challenge could not be passed"
    return None


def file_id_from_url(url):
    clean = url.split("#")[0].split("?")[0]
    parts = [p for p in urlparse(clean).path.split("/") if p]
    return parts[-1] if parts else None


def main():
    if len(sys.argv) < 2 or not sys.argv[1].startswith("http"):
        print("ERROR: pass a fuckingfast.co landing page URL", flush=True)
        return 2

    url = sys.argv[1].split("#")[0]
    file_id = file_id_from_url(url)
    if not file_id:
        print(f"ERROR: could not parse file id from {url}", flush=True)
        return 2

    try:
        session = cr.Session(impersonate="chrome", timeout=25)
        landing = session.get(url, allow_redirects=False)
        if landing.status_code == 429:
            print("BLOCKED: rate-limited (429), wait a few minutes", flush=True)
            return 1
        blocked = looks_blocked(landing.status_code, landing.text or "")
        if blocked:
            print(f"BLOCKED: {blocked}", flush=True)
            return 1

        resp = session.post(
            f"https://fuckingfast.co/f/{file_id}/go",
            data={"cf-turnstile-response": ""},
            allow_redirects=False,
        )

        direct = (
            resp.headers.get("hx-redirect")
            or resp.headers.get("hx-location")
            or resp.headers.get("location")
            or ""
        ).strip()
        if direct and "dl.fuckingfast.co" in direct and "/dl/" in direct:
            print(f"DIRECT:{direct}", flush=True)
            return 0
        if direct:
            # Fall back to a direct URL on the main domain
            print(f"DIRECT:{direct}", flush=True)
            return 0

        if resp.status_code == 429:
            print("BLOCKED: rate-limited (429), wait a few minutes", flush=True)
            return 1
        body = resp.text or ""
        blocked = looks_blocked(resp.status_code, body)
        if blocked:
            print(f"BLOCKED: {blocked}", flush=True)
            return 1

        inline = re.search(
            r"https?://[a-zA-Z0-9.-]+\.fuckingfast\.co/dl/[^\s\"'<>\\]+", body
        )
        if inline and "/dl/" in inline.group(0):
            print(f"DIRECT:{inline.group(0)}", flush=True)
            return 0

        print("ERROR: direct link not found in response", flush=True)
        return 1

    except Exception as exc:  # noqa: BLE001 - must never crash the caller
        print(f"ERROR: {type(exc).__name__}: {exc}".strip()[:400], flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())