// Serves the web build of Front Desk at https://desk.rotmanav.ca/.
//
// The app is the same file the Windows host loads: every record lives in the
// browser's own IndexedDB on the device that opened it, and nothing is sent
// back here. This Worker only hands out the three static files in web/, with
// the headers a page that holds a PIN screen and people's phone numbers
// should have.
//
// Its own host, not a path on rotmanav.ca. A browser keeps storage per origin,
// and rotmanav.ca also serves /cast, /clicker and whatever comes next: any page
// on that origin could read the desk's records. The desk briefly lived at
// rotmanav.ca/desk/; that route is kept only to redirect here.

const HOST = "desk.rotmanav.ca";
const OLD_PREFIX = "/desk";

// The CSP's script hashes are worked out from the page itself, so editing an
// inline <script> or an onclick in index.html cannot leave the policy blocking
// it. Cached per isolate, keyed on the asset's ETag.
let _csp = { tag: null, value: null };

const BASE_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // Never framed: a framed PIN screen is a clickjacking target.
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  // A staff tool, not a page for search results.
  "x-robots-tag": "noindex, nofollow",
  // No versioned filenames, so always revalidate: a fix that is deployed has to
  // reach the tablet on its next load, not whenever a cache expires.
  "cache-control": "no-cache",
  // Once a browser has seen the page over HTTPS it will not try plain HTTP again.
  // Not includeSubDomains: the other hosts on rotmanav.ca are not this file's call.
  "strict-transport-security": "max-age=31536000"
};

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return `'sha256-${btoa(bin)}'`;
}

function unescapeAttr(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export async function buildCsp(html) {
  const hashes = new Set();
  // Inline <script> blocks, exactly as the browser hashes them.
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    hashes.add(await sha256(m[1]));
  }
  // Inline event handlers (onclick="..."), allowed by hash under 'unsafe-hashes'.
  for (const m of html.matchAll(/\son[a-z]+="([^"]*)"/gi)) {
    hashes.add(await sha256(unescapeAttr(m[1])));
  }
  // The fatal-error screen app.js writes when bootstrap fails carries one of its own.
  hashes.add(await sha256("location.reload()"));
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-hashes' ${[...hashes].join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join("; ");
}

function withHeaders(res, extra = {}) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...BASE_HEADERS, ...extra })) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Plain HTTP used to be served as is: a page with a PIN screen, open to
    // anyone on the same Wi-Fi to rewrite in flight, and a separate origin with
    // its own empty storage, so the desk looked wiped. Always HTTPS.
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return withHeaders(Response.redirect(url.toString(), 301));
    }
    // The old address, rotmanav.ca/desk/..., goes to the same path here. Its
    // route pattern (rotmanav.ca/desk*) also matches /desktop and the like,
    // which are not ours.
    if (url.hostname !== HOST) {
      if (url.pathname === OLD_PREFIX || url.pathname.startsWith(OLD_PREFIX + "/")) {
        const to = new URL(`https://${HOST}/`);
        to.pathname = url.pathname.slice(OLD_PREFIX.length) || "/";
        to.search = url.search;
        return withHeaders(Response.redirect(to.toString(), 301));
      }
      return withHeaders(new Response("Not found", { status: 404 }));
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return withHeaders(new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } }));
    }

    // Always a GET to the asset layer: the policy is built from the page's body,
    // and a HEAD has none. Building it from a HEAD used to cache a policy with
    // no script hashes in it, which then blocked the page's own inline scripts
    // for every GET after it.
    const isHead = request.method === "HEAD";
    const res = await env.ASSETS.fetch(new Request(url, { method: "GET", headers: request.headers }));

    const type = res.headers.get("content-type") || "";
    if (res.status === 200 && type.startsWith("text/html")) {
      const tag = res.headers.get("etag");
      const html = await res.text();
      if (!_csp.value || _csp.tag !== tag || !tag) _csp = { tag, value: await buildCsp(html) };
      return withHeaders(new Response(isHead ? null : html, res), {
        "content-security-policy": _csp.value
      });
    }
    return withHeaders(isHead ? new Response(null, res) : res);
  }
};
