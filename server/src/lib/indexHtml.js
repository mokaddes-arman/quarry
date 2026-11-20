'use strict';

// Link-preview crawlers (Facebook, LinkedIn, WhatsApp, Slack, X...) ignore
// root-relative og:image / twitter:image URLs, but the deploy domain is only
// known at runtime. This rewrites those meta tags to absolute URLs when the
// SPA's index.html is served.

const ABSOLUTIZE = ['og:image', 'og:url', 'twitter:image'];
const META_RE = new RegExp(
  `(<meta\\s+(?:property|name)="(?:${ABSOLUTIZE.join('|')})"\\s+content=")(/[^"]*)"`,
  'g',
);
const HOST_RE = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

/**
 * Origin to put in front of root-relative URLs. APP_PUBLIC_URL wins; otherwise
 * fall back to the request's host (validated, so a forged Host header cannot
 * inject markup). Behind Render's proxy the scheme comes from X-Forwarded-Proto.
 */
function publicOrigin(req, appPublicUrl) {
  if (appPublicUrl) return appPublicUrl.replace(/\/+$/, '');
  const host = String(req.get('host') || '');
  if (!HOST_RE.test(host)) return '';
  const fwd = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  const proto = fwd === 'https' || fwd === 'http' ? fwd : req.protocol;
  return `${proto}://${host}`;
}

function absolutizeMeta(html, origin) {
  if (!origin) return html;
  return html.replace(META_RE, (_, head, p) => `${head}${origin}${p}"`);
}

module.exports = { publicOrigin, absolutizeMeta };
