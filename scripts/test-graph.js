#!/usr/bin/env node
// Offline tests for graph building, broken-link detection, suggestions and
// link injection. No store or API keys needed.
const assert = require('assert');
const path = require('path');
process.env.SITE_URL = 'https://www.acmesupply.example';
process.env.SHOPIFY_BLOG_HANDLE = 'news';
process.env.CONFIG_DIR = path.resolve(__dirname, 'fixtures');
const g = require('../src/link-graph.js');
const inj = require('../src/inject-links.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const filler = ' Coffee is brewed in many ways and every method has its own grind size, water temperature and timing that change the cup.'.repeat(4);

const articles = [
  { id: 1, handle: 'pour-over-coffee-brewing-guide', title: 'Pour Over Coffee Brewing Guide', published_at: '2026-01-01',
    body_html: `<p>Brewing guide.${filler} See <a href="/blogs/news/how-to-store-coffee-beans">storage</a> and <a href="/blogs/news/how-to-store-coffee">this one</a>. Our espresso blend makes great crema.</p>` },
  { id: 2, handle: 'how-to-store-coffee-beans', title: 'How to Store Coffee Beans', published_at: '2026-01-02',
    body_html: `<p>Storage.${filler} A good pour over coffee brewing guide helps.</p>` },
  { id: 3, handle: 'light-roast-vs-dark-roast', title: 'Light Roast vs Dark Roast', published_at: '2026-01-03',
    body_html: `<p>Roast.${filler}</p>` },
];
const products = [{ id: 9, handle: 'espresso-blend', title: 'Espresso Blend', body_html: '<p>Espresso blend.</p>', published_at: '2026-01-01' }];
const url = p => g.SITE + p;
const byUrl = g.buildGraph(articles, products);

t('graph counts inbound and outbound links per page', () => {
  assert.strictEqual(byUrl.get(url('/blogs/news/how-to-store-coffee-beans')).inlinks.length, 1);
  assert.strictEqual(byUrl.get(url('/blogs/news/pour-over-coffee-brewing-guide')).outlinks.length, 1);
  assert.strictEqual(byUrl.get(url('/blogs/news/light-roast-vs-dark-roast')).inlinks.length, 0);
  assert.strictEqual(byUrl.get(url('/products/espresso-blend')).type, 'product');
});

t('a link to a slug that does not exist is matched to the closest real slug', () => {
  const broken = g.detectBrokenLinks(articles, byUrl);
  assert.strictEqual(broken.length, 1);
  assert.strictEqual(broken[0].type, 'wrong_slug');
  assert.strictEqual(broken[0].fixHref, url('/blogs/news/how-to-store-coffee-beans'));
});

t('posts are assigned to the topic cluster with the most keyword hits', () => {
  assert.strictEqual(g.getCluster('Pour Over Coffee Brewing Guide', 'pour-over-coffee-brewing-guide'), 'brewing');
  assert.strictEqual(g.getCluster('Company News', 'company-news'), 'general');
});

const suggestions = g.generateSuggestions(byUrl);

t('suggestions only target pages with at most one inbound link', () => {
  assert.ok(suggestions.length > 0);
  for (const s of suggestions) assert.ok(s.inlinkCount <= 1);
});

t('no suggestion repeats a link that already exists', () => {
  assert.ok(!suggestions.some(s => s.sourceHandle === 'pour-over-coffee-brewing-guide' && s.targetHandle === 'how-to-store-coffee-beans'));
});

t('a configured money page mentioned in the source outranks blog targets', () => {
  const money = suggestions.find(s => s.targetHandle === 'espresso-blend');
  assert.ok(money, 'expected a suggestion pointing at the product page');
  const bestBlog = Math.max(...suggestions.filter(s => s.targetType === 'blog').map(s => s.relevanceScore));
  assert.ok(money.relevanceScore > bestBlog);
});

t('every suggestion starts as pending and survives a CSV round trip', () => {
  const rows = inj.parseCsv(g.writeCsv(suggestions));
  assert.strictEqual(rows.length, suggestions.length);
  assert.ok(rows.every(r => r.status === 'pending'));
  assert.strictEqual(rows[0].target_url, suggestions[0].targetUrl);
});

t('injection wraps the first unlinked occurrence and keeps its casing', () => {
  const r = inj.injectLink('<p>We love <a href="/x">espresso blend</a> and Espresso Blend too.</p>', 'espresso blend', '/products/espresso-blend');
  assert.strictEqual(r.injected, true);
  assert.strictEqual(r.html, '<p>We love <a href="/x">espresso blend</a> and <a href="/products/espresso-blend">Espresso Blend</a> too.</p>');
});

t('injection reports a miss instead of changing the HTML', () => {
  const html = '<p>Nothing relevant here.</p>';
  const r = inj.injectLink(html, 'espresso', '/products/espresso-blend');
  assert.strictEqual(r.injected, false);
  assert.strictEqual(r.html, html);
});

console.log(`\n${n} tests passed`);
