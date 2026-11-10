import assert from 'node:assert/strict';
import test from 'node:test';
import {
  charsetOf,
  CookieJar,
  filterResponseHeaders,
  PROXY_CSP,
  responseCsp,
  rewriteBody,
  rewriteLocation,
  textKindOf,
  upstreamRequestHeaders,
  upstreamTarget,
} from '../src/lib/webuiProxy.js';

const B = '/api/servers/11111111-1111-1111-1111-111111111111/webui/webadmin/~t/TOKEN';

test('HTML: root-absolute attributes, quoted and unquoted, are prefixed', () => {
  const html =
    '<a href="/ServerAdmin/">x</a><img src=\'/img/a.png\'><form action="/login" method=post>' +
    '<a href=/plain>p</a><a href="/">root</a><link rel=stylesheet href="//cdn.example/x.css">' +
    '<a href="https://example.com/x">ext</a><a href="rel/x">rel</a><a href="#top">t</a>' +
    '<meta http-equiv="refresh" content="0; url=/ServerAdmin/current">';
  const out = rewriteBody(html, 'html', B);
  assert.ok(out.includes(`href="${B}/ServerAdmin/"`));
  assert.ok(out.includes(`src='${B}/img/a.png'`));
  assert.ok(out.includes(`action="${B}/login"`));
  assert.ok(out.includes(`href=${B}/plain`));
  assert.ok(out.includes(`href="${B}/"`));
  assert.ok(out.includes('href="//cdn.example/x.css"'));
  assert.ok(out.includes('href="https://example.com/x"'));
  assert.ok(out.includes('href="rel/x"'));
  assert.ok(out.includes('href="#top"'));
  assert.ok(out.includes(`url=${B}/ServerAdmin/current`));
});

test('rewriting is idempotent (already prefixed URLs are left alone)', () => {
  const once = rewriteBody('<a href="/x">x</a><script>var u = "/api/data";</script>', 'html', B);
  assert.equal(rewriteBody(once, 'html', B), once);
  assert.equal(rewriteBody('a{background:url(/i.png)}', 'css', B), rewriteBody(rewriteBody('a{background:url(/i.png)}', 'css', B), 'css', B));
});

test('CSS url() and JS string literals', () => {
  assert.equal(rewriteBody('a{background:url(/i.png)} b{background:url("/j.png")}', 'css', B), `a{background:url(${B}/i.png)} b{background:url("${B}/j.png")}`);
  assert.equal(rewriteBody("@import '/base.css';", 'css', B), `@import '${B}/base.css';`);
  assert.equal(rewriteBody('fetch("/ServerAdmin/data?x=1")', 'js', B), `fetch("${B}/ServerAdmin/data?x=1")`);
  // Separators, comments and protocol-relative URLs are not paths.
  assert.equal(rewriteBody('p.split("/"); q.join(\'/\'); x = "//cdn/x";', 'js', B), 'p.split("/"); q.join(\'/\'); x = "//cdn/x";');
});

test('Location rewriting', () => {
  const up = 'http://172.18.0.5:8080';
  assert.equal(rewriteLocation('/ServerAdmin/', B, up), `${B}/ServerAdmin/`);
  assert.equal(rewriteLocation('http://172.18.0.5:8080/a?b=1#c', B, up), `${B}/a?b=1#c`);
  assert.equal(rewriteLocation('https://steamcommunity.com/x', B, up), 'https://steamcommunity.com/x');
  assert.equal(rewriteLocation('current', B, up), 'current');
  assert.equal(rewriteLocation('//evil.example/', B, up), '//evil.example/');
  assert.equal(rewriteLocation(`${B}/x`, B, up), `${B}/x`);
});

test('CSP: upstream frame-ancestors/sandbox removed, ours appended', () => {
  assert.equal(responseCsp("default-src 'self'; frame-ancestors 'none'"), `default-src 'self'; ${PROXY_CSP}`);
  assert.equal(responseCsp(undefined), PROXY_CSP);
  assert.ok(PROXY_CSP.includes("frame-ancestors 'self'"));
  assert.ok(PROXY_CSP.startsWith('sandbox ') && !PROXY_CSP.includes('allow-same-origin'));
});

test('request headers: allowlist only; panel cookies and tokens never forwarded; basic auth injected', () => {
  const h = upstreamRequestHeaders(
    {
      cookie: 'scf_sid=SECRET; other=1',
      authorization: 'Bearer scf_abc',
      accept: 'text/html',
      'content-type': 'application/x-www-form-urlencoded',
      host: 'panel.example',
      'x-forwarded-for': '1.2.3.4',
      origin: 'null',
      connection: 'keep-alive',
    },
    { upstreamHost: '172.18.0.5:8080', cookie: 'sessionid=abc', basicAuth: { user: 'admin', password: 'p:w' }, bodyLength: 3 },
  );
  assert.deepEqual(h, {
    accept: 'text/html',
    'content-type': 'application/x-www-form-urlencoded',
    host: '172.18.0.5:8080',
    'accept-encoding': 'identity',
    origin: 'http://172.18.0.5:8080',
    cookie: 'sessionid=abc',
    authorization: `Basic ${Buffer.from('admin:p:w').toString('base64')}`,
    'content-length': '3',
  });
  const none = upstreamRequestHeaders({ cookie: 'scf_sid=x', authorization: 'Basic eA==' }, { upstreamHost: 'h:1', cookie: null, basicAuth: null, bodyLength: null });
  assert.equal(none.cookie, undefined);
  assert.equal(none.authorization, undefined);
});

test('response headers: framing, cookies, hop-by-hop and HSTS are dropped', () => {
  const out = filterResponseHeaders({
    'Content-Type': 'text/html',
    'X-Frame-Options': 'DENY',
    'Set-Cookie': ['a=1'],
    'Content-Security-Policy': "frame-ancestors 'none'",
    'Transfer-Encoding': 'chunked',
    'Strict-Transport-Security': 'max-age=1',
    'Content-Length': '10',
    etag: '"x"',
    location: '/x',
  });
  assert.deepEqual(out, { 'content-type': 'text/html', etag: '"x"', location: '/x' });
});

test('cookie jar keeps upstream cookies server-side', () => {
  const j = new CookieJar();
  j.setAll(['sessionid=abc; Path=/ServerAdmin; HttpOnly', 'theme=dark']);
  assert.equal(j.header(), 'sessionid=abc; theme=dark');
  j.set('theme=; Max-Age=0');
  j.set('bad name=1');
  j.set('x=a\nb');
  j.set('old=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  assert.equal(j.header(), 'sessionid=abc');
});

test('upstream target: only origin-form paths after the prefix', () => {
  assert.equal(upstreamTarget(`${B}/ServerAdmin/?a=1`, B), '/ServerAdmin/?a=1');
  assert.equal(upstreamTarget(B, B), '/');
  assert.equal(upstreamTarget(`${B}?x=1`, B), '/?x=1');
  assert.equal(upstreamTarget(`${B}x`, B), null);
  assert.equal(upstreamTarget('/api/servers/other/webui/x/~t/T/a', B), null);
  assert.equal(upstreamTarget(`${B}/a b`, B), null);
  assert.equal(upstreamTarget(`${B}/a\\b`, B), null);
  // A path can never change the upstream host: "//host" stays a path on the container's own server.
  assert.equal(upstreamTarget(`${B}//evil.example/x`, B), '//evil.example/x');
});

test('content kinds and charsets', () => {
  assert.equal(textKindOf('text/html; charset=utf-8'), 'html');
  assert.equal(textKindOf('text/css'), 'css');
  assert.equal(textKindOf('application/javascript'), 'js');
  assert.equal(textKindOf('image/png'), null);
  assert.equal(textKindOf(undefined), null);
  assert.equal(charsetOf('text/html; charset=ISO-8859-1'), 'latin1');
  assert.equal(charsetOf('text/html'), 'utf8');
});
