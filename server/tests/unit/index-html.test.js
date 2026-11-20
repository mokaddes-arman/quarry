'use strict';

/* globals describe, it, expect */
const { publicOrigin, absolutizeMeta } = require('../../src/lib/indexHtml');

function fakeReq(headers = {}, protocol = 'http') {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { protocol, get: (name) => lower[name.toLowerCase()] };
}

const HTML = [
  '<meta property="og:image" content="/og-image.png" />',
  '<meta name="twitter:image" content="/og-image.png" />',
  '<meta property="og:title" content="/not-a-url" />',
  '<link rel="icon" href="/favicon.ico" />',
].join('\n');

describe('link-preview meta tags', () => {
  it('makes og:image and twitter:image absolute and leaves everything else alone', () => {
    const out = absolutizeMeta(HTML, 'https://quarry.example.com');
    expect(out).toContain('property="og:image" content="https://quarry.example.com/og-image.png"');
    expect(out).toContain('name="twitter:image" content="https://quarry.example.com/og-image.png"');
    expect(out).toContain('property="og:title" content="/not-a-url"');
    expect(out).toContain('href="/favicon.ico"');
  });

  it('prefers APP_PUBLIC_URL and strips trailing slashes', () => {
    expect(publicOrigin(fakeReq({ host: 'evil.test' }), 'https://quarry.example.com/')).toBe(
      'https://quarry.example.com',
    );
  });

  it('falls back to the request host, honouring X-Forwarded-Proto', () => {
    expect(publicOrigin(fakeReq({ host: 'quarry.onrender.com', 'x-forwarded-proto': 'https' }), '')).toBe(
      'https://quarry.onrender.com',
    );
    expect(publicOrigin(fakeReq({ host: 'localhost:3001' }), '')).toBe('http://localhost:3001');
  });

  it('rejects a Host header that could inject markup', () => {
    expect(publicOrigin(fakeReq({ host: 'x"><script>' }), '')).toBe('');
    expect(absolutizeMeta(HTML, '')).toBe(HTML);
  });
});
