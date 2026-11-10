#!/usr/bin/env node
/**
 * link-graph.js: Internal link graph builder + orphan page fixer + broken link scanner
 *
 * Fetches every published blog post, parses its HTML for internal links,
 * builds a full link graph, identifies orphan pages and single-link pages,
 * detects broken internal links, and optionally auto-fixes them.
 *
 * Outputs (in OUTPUT_DIR, default ./output):
 *   link-graph-cache.json      raw article data, reused for 12 hours
 *   link-graph-report.txt      human-readable summary
 *   approved-links.csv         suggested link injections, for review and injection
 *   broken-internal-links.json broken internal links found, with suggested fixes
 *
 * Link targets and topic clusters are defined in config/link-targets.json.
 *
 * Usage:
 *   node src/link-graph.js                  # full analysis + generate CSV
 *   node src/link-graph.js --refresh        # force re-fetch all article bodies
 *   node src/link-graph.js --report-only    # print report from cache, no CSV write
 *   node src/link-graph.js --limit 20       # only fetch first 20 articles (for testing)
 *   node src/link-graph.js --fix-broken     # auto-fix broken internal links in Shopify
 *   node src/link-graph.js --fix-broken --dry-run  # preview fixes without writing
 *   node src/link-graph.js --auto-approve   # auto-approve high-confidence link suggestions
 */

require('dotenv').config({ quiet: true });
const fs   = require('fs');
const path = require('path');

const _fetch = globalThis.fetch;

// ─── Config ──────────────────────────────────────────────────────────────────
const STORE       = process.env.SHOPIFY_STORE       || '';
const TOKEN       = process.env.SHOPIFY_ADMIN_TOKEN;
const BLOG_HANDLE = process.env.SHOPIFY_BLOG_HANDLE || 'news';
const BLOG_ID     = process.env.SHOPIFY_BLOG_ID     || '';
const REST_BASE   = `https://${STORE}/admin/api/2024-10`;
const SITE        = (process.env.SITE_URL || 'https://www.acmesupply.example').replace(/\/+$/, '');
const COMPANY_NAME = process.env.COMPANY_NAME || 'Link Graph';
const BLOG_BASE   = `${SITE}/blogs/${BLOG_HANDLE}`;

const OUTPUT_DIR        = process.env.OUTPUT_DIR || path.resolve(__dirname, '..', 'output');
const CACHE_FILE        = path.join(OUTPUT_DIR, 'link-graph-cache.json');
const REPORT_FILE       = path.join(OUTPUT_DIR, 'link-graph-report.txt');
const CSV_FILE          = path.join(OUTPUT_DIR, 'approved-links.csv');
const BROKEN_LINKS_FILE = path.join(OUTPUT_DIR, 'broken-internal-links.json');
const CACHE_TTL_MS      = 12 * 60 * 60 * 1000; // 12 hours

// Max suggestions per orphan
const MAX_SUGGESTIONS_PER_ORPHAN = 5;
// Orphan = 0 inbound links from other blog posts; low-link = 1
const ORPHAN_THRESHOLD   = 0;
const LOW_LINK_THRESHOLD = 1;

// ─── Link targets and topic clusters, from config/link-targets.json ──────────
//   canonicalUrls:  the page that should rank for each keyword cluster. Link
//                   suggestions preferentially point to these pages.
//   moneyPages:     product pages that should receive the most internal link
//                   authority from related blog content, each with keywords and a priority.
//   deprecatedUrls: pages being redirected or noindexed. Never suggested as link targets.
//   topicClusters:  keyword sets; a post's cluster is the one with the most hits
//                   in its handle and title.
const CONFIG_DIR = process.env.CONFIG_DIR || path.resolve(__dirname, '..', 'config');
function loadConfig() {
  for (const f of ['link-targets.json', 'link-targets.example.json']) {
    const p = path.join(CONFIG_DIR, f);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return {};
}
const CONFIG = loadConfig();
const CANONICAL_URLS = CONFIG.canonicalUrls || {};
const MONEY_PAGES    = CONFIG.moneyPages || [];
const MONEY_PAGE_MAP = new Map(MONEY_PAGES.map(mp => [mp.url, mp]));
const DEPRECATED_URLS = new Set(CONFIG.deprecatedUrls || []);
const CANONICAL_URL_PATHS = new Set(Object.values(CANONICAL_URLS));
const TOPIC_CLUSTERS = CONFIG.topicClusters || {};

// Returns the primary cluster name for a post, or 'general'
function getCluster(title, handle) {
  const text = (title + ' ' + handle).toLowerCase().replace(/-/g,' ');
  const scores = {};
  for (const [cluster, keywords] of Object.entries(TOPIC_CLUSTERS)) {
    scores[cluster] = keywords.filter(k => text.includes(k)).length;
  }
  const best = Object.entries(scores).sort((a,b)=>b[1]-a[1])[0];
  return best && best[1] > 0 ? best[0] : 'general';
}

// ─── Improved relevance scoring (0-100) ──────────────────────────────────────
// Criteria:
//   +40  same primary topic cluster
//   +20  secondary cluster overlap or shared cluster keywords
//   +30  target keywords found in source body text (up to +30)
//   +10  strong title keyword overlap (shared non-stopwords)
const STOPWORDS = new Set(['that','this','with','from','have','will','what','your','more','also','been','into','than','then','them','they','when','where','which','their','about','after','before','between','through','without','there','these','those','being','every','other','some','such','only','over','both','very','just','like','make','know','take','time','long','good','look','come','most','also','back','used','each','much','well','even','does','want','does','here','same','how','its','the','and','for','are','but','not','you','all','can','her','was','one','our','out','use','day','get','has','him','his','how','man','new','now','old','see','two','way','who','boy','did','its','let','put','say','she','too','use']);

function scoreRelevanceV2(target, source) {
  let score = 0;

  // 1. Topic cluster match (+40 same cluster, +20 related cluster)
  const targetCluster = getCluster(target.title, target.handle);
  const sourceCluster = getCluster(source.title, source.handle);
  if (targetCluster === sourceCluster && targetCluster !== 'general') {
    score += 40;
  } else {
    // Partial credit for cluster keyword overlap
    const targetWords = new Set((target.title + ' ' + target.handle).toLowerCase().replace(/-/g,' ').split(/\s+/));
    const sourceWords = new Set((source.title + ' ' + source.handle).toLowerCase().replace(/-/g,' ').split(/\s+/));
    const clusterKeywords = [...(TOPIC_CLUSTERS[targetCluster] || [])];
    const sharedClusterKeys = clusterKeywords.filter(k => sourceWords.has(k) || (source.plainText||'').toLowerCase().includes(k));
    score += Math.min(20, sharedClusterKeys.length * 5);
  }

  // 2. Target keywords in source body text (+3 per hit, max +30)
  const targetKeywords = (target.title + ' ' + target.handle)
    .toLowerCase().replace(/-/g,' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w));
  const sourceBody = (source.plainText || '').toLowerCase();
  const bodyHits = targetKeywords.filter(w => sourceBody.includes(w));
  score += Math.min(30, bodyHits.length * 3);

  // 3. Title keyword overlap (+2 per shared meaningful word, max +10)
  const targetTitleWords = new Set(targetKeywords);
  const sourceTitleWords = (source.title + ' ' + source.handle)
    .toLowerCase().replace(/-/g,' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w));
  const titleOverlap = sourceTitleWords.filter(w => targetTitleWords.has(w));
  score += Math.min(10, titleOverlap.length * 2);

  // 4. Money page boost: configured product pages get a large priority boost, so a
  //    product page that matches the topic outranks a blog post as a link target.
  const targetUrl = target.url || '';
  const moneyPage = MONEY_PAGE_MAP.get(targetUrl.replace(SITE, ''));
  if (moneyPage) {
    // Check if the source content mentions any of the money page's keywords
    const moneyHits = moneyPage.keywords.filter(k => sourceBody.includes(k.toLowerCase()));
    if (moneyHits.length > 0) {
      // Strong match: source blog talks about the money page's topic
      score += moneyPage.priority; // +75 to +100 boost
    } else {
      // Weak match: money page exists but source doesn't mention its keywords
      score += Math.floor(moneyPage.priority * 0.3); // +22 to +30 boost
    }
  } else if (targetUrl.includes('/products/') || targetUrl.includes('/collections/')) {
    // Generic product/collection page boost (even if not in MONEY_PAGES list)
    score += 15;
  }

  return Math.min(200, score); // Allow scores above 100 for money pages
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const args         = process.argv.slice(2);
const FORCE        = args.includes('--refresh');
const REPORT_ONLY  = args.includes('--report-only');
const FIX_BROKEN   = args.includes('--fix-broken');
const DRY_RUN      = args.includes('--dry-run');
const AUTO_APPROVE = args.includes('--auto-approve');
const limitArg     = args.find(a => a.startsWith('--limit'));
const LIMIT        = limitArg ? parseInt(limitArg.split('=')[1] || args[args.indexOf(limitArg)+1], 10) : 0;

// ─── Shopify helpers ─────────────────────────────────────────────────────────
async function resolveBlogId() {
  if (BLOG_ID) return BLOG_ID;
  const res  = await _fetch(`${REST_BASE}/blogs.json?fields=id,handle`, {
    headers: { 'X-Shopify-Access-Token': TOKEN },
  });
  const { blogs } = await res.json();
  const blog = (blogs || []).find(b => b.handle === BLOG_HANDLE);
  if (!blog) throw new Error(`Blog "${BLOG_HANDLE}" not found`);
  return String(blog.id);
}

async function fetchAllArticlesWithBody(blogId) {
  const articles = [];
  let url = `${REST_BASE}/blogs/${blogId}/articles.json` +
            `?limit=50&status=active&fields=id,title,handle,body_html,published_at`;

  while (url) {
    process.stdout.write(`  Fetching articles... ${articles.length} so far\r`);
    const res = await _fetch(url, { headers: { 'X-Shopify-Access-Token': TOKEN } });
    if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text().then(t=>t.slice(0,200))}`);

    const { articles: batch } = await res.json();
    articles.push(...(batch || []));

    if (LIMIT && articles.length >= LIMIT) {
      articles.splice(LIMIT);
      break;
    }

    const link = res.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  process.stdout.write('\n');
  return articles;
}

// ─── Fetch product pages from Shopify ────────────────────────────────────────
async function fetchProductPages() {
  const products = [];
  let url = `${REST_BASE}/products.json?limit=50&status=active&fields=id,title,handle,body_html,published_at`;
  while (url) {
    process.stdout.write(`  Fetching products... ${products.length} so far\r`);
    const res = await _fetch(url, { headers: { 'X-Shopify-Access-Token': TOKEN } });
    if (!res.ok) break;
    const { products: batch } = await res.json();
    products.push(...(batch || []));
    const link = res.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  process.stdout.write('\n');
  return products;
}

// ─── Link extraction from HTML ───────────────────────────────────────────────
function extractInternalBlogLinks(html) {
  if (!html) return [];
  const links = new Set();
  // Match <a href="...">: both absolute and relative internal links
  const re = /<a[^>]+href=["']([^"'#?]+)[^"']*["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1].trim();
    // Normalise relative → absolute
    if (href.startsWith('/blogs/')) href = SITE + href;
    if (href.startsWith('/products/')) href = SITE + href;
    // Keep links to our own blog posts
    if (href.startsWith(BLOG_BASE + '/') && href !== BLOG_BASE + '/') {
      links.add(href.replace(/\/$/, ''));
    }
    // Also keep links to our product pages
    if (href.startsWith(SITE + '/products/') && href !== SITE + '/products/') {
      links.add(href.replace(/\/$/, ''));
    }
  }
  return [...links];
}

// ─── Extract ALL hrefs from HTML (for broken link detection) ─────────────────
function extractAllHrefs(html) {
  if (!html) return [];
  const links = [];
  const re = /<a[^>]+href=["']([^"'#]+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    links.push(m[1].trim());
  }
  return links;
}

// ─── Classify a broken internal link ─────────────────────────────────────────
function classifyBrokenLink(href, knownHandles) {
  // Type 1: Malformed external URL (missing https://) that got turned into an internal path
  //   e.g. href="example.org" → browser resolves to <site>/blogs/<blog>/example.org
  const afterBlog = href.replace(BLOG_BASE + '/', '');
  if (afterBlog.includes('.com') || afterBlog.includes('.org') || afterBlog.includes('.gov') ||
      afterBlog.includes('.edu') || afterBlog.includes('.net') || afterBlog.includes('.io')) {
    return { type: 'malformed_external', detail: `External URL missing https:// → "${afterBlog}"` };
  }

  // Type 2: URL-encoded spaces (from copy-paste errors)
  //   e.g. /blogs/news/Ethiopia%20Natural%20Light%20Roast
  if (href.includes('%20')) {
    const decoded = decodeURIComponent(afterBlog).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const match = findClosestSlug(decoded, knownHandles);
    return { type: 'url_encoded_spaces', detail: `Spaces in URL, likely meant: ${match || decoded}`, suggestedSlug: match };
  }

  // Type 3: Hallucinated / close-but-wrong slug
  const match = findClosestSlug(afterBlog, knownHandles);
  if (match) {
    return { type: 'wrong_slug', detail: `Slug doesn't exist, closest match: ${match}`, suggestedSlug: match };
  }

  // Type 4: No close match found
  return { type: 'unknown', detail: 'No matching blog post found' };
}

// ─── Fuzzy slug matching using Levenshtein-like word overlap ──────────────────
function findClosestSlug(brokenSlug, knownHandles) {
  const brokenWords = new Set(brokenSlug.toLowerCase().replace(/[^a-z0-9-]/g, '').split('-').filter(w => w.length > 2));
  if (brokenWords.size === 0) return null;

  let bestHandle = null;
  let bestScore  = 0;

  for (const handle of knownHandles) {
    const handleWords = new Set(handle.split('-').filter(w => w.length > 2));
    // Count shared words
    let shared = 0;
    for (const w of brokenWords) {
      if (handleWords.has(w)) shared++;
    }
    // Score = shared words / max(broken words, handle words): favours tight matches
    const score = shared / Math.max(brokenWords.size, handleWords.size);
    // Also try substring containment (a truncated slug inside the real one)
    const containsBonus = handle.includes(brokenSlug) || brokenSlug.includes(handle) ? 0.2 : 0;
    const total = score + containsBonus;

    if (total > bestScore && shared >= 2) {
      bestScore  = total;
      bestHandle = handle;
    }
  }

  // Only return if reasonable confidence (>40% word overlap)
  return bestScore >= 0.4 ? bestHandle : null;
}

// ─── Detect broken internal links across all articles ────────────────────────
function detectBrokenLinks(articles, byUrl) {
  const knownHandles = new Set([...byUrl.keys()].map(u => u.replace(BLOG_BASE + '/', '')));
  const brokenLinks  = []; // { sourceHandle, sourceId, sourceTitle, brokenHref, classification, fixHref }

  for (const a of articles) {
    const allHrefs = extractAllHrefs(a.body_html);

    for (const href of allHrefs) {
      let normalised = href;

      // Normalise relative blog links
      if (normalised.startsWith('/blogs/')) normalised = SITE + normalised;

      // Check if it's an internal blog link
      const isBlogLink = normalised.startsWith(BLOG_BASE + '/') && normalised !== BLOG_BASE + '/';
      if (!isBlogLink) continue;

      // Strip trailing slash for matching
      normalised = normalised.replace(/\/$/, '');

      // Check if target exists
      if (byUrl.has(normalised)) continue; // ✅ valid link

      // 🔴 Broken internal blog link found
      const classification = classifyBrokenLink(normalised, knownHandles);

      let fixHref = null;
      if (classification.type === 'malformed_external') {
        // Reconstruct the original external URL
        const externalDomain = normalised.replace(BLOG_BASE + '/', '');
        fixHref = `https://${externalDomain}`;
      } else if (classification.suggestedSlug) {
        fixHref = `${BLOG_BASE}/${classification.suggestedSlug}`;
      }

      brokenLinks.push({
        sourceHandle: a.handle,
        sourceId:     String(a.id),
        sourceTitle:  a.title,
        brokenHref:   href,  // original href as it appears in HTML
        normalised,
        type:         classification.type,
        detail:       classification.detail,
        fixHref,
      });
    }
  }

  return brokenLinks;
}

// ─── Apply broken link fixes to Shopify ──────────────────────────────────────
async function applyBrokenLinkFixes(brokenLinks, articles) {
  const fixable = brokenLinks.filter(b => b.fixHref);
  if (fixable.length === 0) {
    console.log('  ✅  No fixable broken links found');
    return { fixed: 0, failed: 0 };
  }

  // Group by source article
  const bySource = new Map();
  for (const fix of fixable) {
    if (!bySource.has(fix.sourceHandle)) bySource.set(fix.sourceHandle, []);
    bySource.get(fix.sourceHandle).push(fix);
  }

  console.log(`\n  🔧  ${DRY_RUN ? 'DRY RUN: ' : ''}Fixing ${fixable.length} broken links across ${bySource.size} articles...`);

  let fixed = 0, failed = 0;
  const blogId = await resolveBlogId();

  for (const [handle, fixes] of bySource) {
    const article = articles.find(a => a.handle === handle);
    if (!article) { failed += fixes.length; continue; }

    let html = article.body_html;
    let changesInArticle = 0;

    for (const fix of fixes) {
      // Escape the broken href for regex
      const escaped = fix.brokenHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(href=["'])${escaped}(["'])`, 'gi');
      const newHtml = html.replace(re, `$1${fix.fixHref}$2`);
      if (newHtml !== html) {
        html = newHtml;
        changesInArticle++;
        console.log(`  ✅  ${handle}: ${fix.brokenHref.slice(0, 50)}... → ${fix.fixHref.slice(0, 50)}...`);
      }
    }

    if (changesInArticle === 0) continue;

    if (DRY_RUN) {
      console.log(`  🧪  Would update "${article.title}" (${changesInArticle} fixes)`);
      fixed += changesInArticle;
      continue;
    }

    // Push to Shopify
    try {
      const res = await _fetch(`${REST_BASE}/blogs/${blogId}/articles/${article.id}.json`, {
        method: 'PUT',
        headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ article: { id: article.id, body_html: html } }),
      });
      if (!res.ok) throw new Error(`Shopify ${res.status}`);
      fixed += changesInArticle;
      // Rate limiting
      await new Promise(r => setTimeout(r, 600));
    } catch (err) {
      console.error(`  ❌  Failed to update "${article.title}": ${err.message}`);
      failed += changesInArticle;
    }
  }

  return { fixed, failed };
}

// ─── Strip HTML tags for text analysis ───────────────────────────────────────
function stripHtml(html) {
  return (html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── Relevance: find the best anchor text in source HTML for a target ─────────
// Returns { anchor, context } or null if no good match found
function findAnchorInSource(sourceText, targetTitle, targetHandle) {
  // Build candidate phrases from target title and handle
  const titleWords = targetTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3);
  const handleWords = targetHandle.replace(/-/g, ' ').split(' ').filter(w => w.length > 3);
  const candidates = [...new Set([...titleWords, ...handleWords])];

  // Look for sentences containing the most candidate words
  const sentences = sourceText.split(/(?<=[.!?])\s+/);
  let bestSentence = null;
  let bestScore = 0;
  let bestAnchor = null;

  for (const sent of sentences) {
    const sentLower = sent.toLowerCase();
    let score = 0;
    for (const c of candidates) {
      if (sentLower.includes(c)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSentence = sent;
    }
  }

  if (bestScore === 0 || !bestSentence) return null;

  // Find the longest candidate phrase that appears in the sentence
  const sentLower = bestSentence.toLowerCase();
  let longestPhrase = '';
  for (const c of candidates) {
    if (sentLower.includes(c) && c.length > longestPhrase.length) {
      longestPhrase = c;
    }
  }

  if (!longestPhrase) return null;

  // Find the actual casing in the sentence
  const idx = sentLower.indexOf(longestPhrase);
  bestAnchor = bestSentence.slice(idx, idx + longestPhrase.length);

  // Trim context to ~120 chars around the match
  const ctxStart = Math.max(0, idx - 40);
  const ctxEnd   = Math.min(bestSentence.length, idx + longestPhrase.length + 40);
  const context  = '...' + bestSentence.slice(ctxStart, ctxEnd).trim() + '...';

  return { anchor: bestAnchor, context, score: bestScore };
}

// ─── Relevance scoring (reuse from blog-catalog logic) ──────────────────────
function scoreRelevance(targetTitle, targetHandle, sourceTitle, sourceHandle) {
  const target = (targetTitle + ' ' + targetHandle).toLowerCase();
  const source = (sourceTitle + ' ' + sourceHandle).toLowerCase();
  const tWords = target.split(/[\s-]+/).filter(w => w.length > 3);
  let score = 0;
  for (const w of tWords) {
    if (source.includes(w)) score += 2;
  }
  return score;
}

// ─── Build the full link graph ────────────────────────────────────────────────
function buildGraph(articles, productPages = []) {
  // Map: url → article entry
  const byUrl = new Map();
  for (const a of articles) {
    const url = `${BLOG_BASE}/${a.handle}`;
    byUrl.set(url, {
      id:          String(a.id),
      title:       a.title,
      handle:      a.handle,
      url,
      type:        'blog',
      outlinks:    [],
      inlinks:     [],
      plainText:   stripHtml(a.body_html),
      bodyHtml:    a.body_html,
      publishedAt: a.published_at,
    });
  }

  // Add product pages to the graph
  for (const p of productPages) {
    const url = `${SITE}/products/${p.handle}`;
    byUrl.set(url, {
      id:          String(p.id),
      title:       p.title,
      handle:      p.handle,
      url,
      type:        'product',
      outlinks:    [],
      inlinks:     [],
      plainText:   stripHtml(p.body_html),
      bodyHtml:    p.body_html,
      publishedAt: p.published_at,
    });
  }

  // Parse outlinks for all entries (articles + products)
  const allPages = [...articles.map(a => ({ ...a, _url: `${BLOG_BASE}/${a.handle}` })),
                    ...productPages.map(p => ({ ...p, _url: `${SITE}/products/${p.handle}` }))];

  for (const page of allPages) {
    const url      = page._url;
    const outlinks = extractInternalBlogLinks(page.body_html);
    const entry    = byUrl.get(url);
    if (!entry) continue;

    entry.outlinks = outlinks.filter(l => l !== url && byUrl.has(l));

    // Register inlinks on targets
    for (const target of entry.outlinks) {
      const targetEntry = byUrl.get(target);
      if (targetEntry && !targetEntry.inlinks.includes(url)) {
        targetEntry.inlinks.push(url);
      }
    }
  }

  return byUrl;
}

// ─── Generate link suggestions for orphan/low-link pages ─────────────────────
function generateSuggestions(byUrl) {
  const suggestions = [];

  for (const [url, entry] of byUrl) {
    if (entry.inlinks.length > LOW_LINK_THRESHOLD) continue; // skip well-linked pages

    // Skip deprecated/noindexed pages: they should NOT be link targets
    const targetPath = url.replace(SITE, '');
    if (DEPRECATED_URLS.has(targetPath)) continue;

    // Find candidate SOURCE pages to link FROM
    // Criteria: relevant topic, doesn't already link here, has enough text
    const candidates = [];
    for (const [sUrl, sEntry] of byUrl) {
      if (sUrl === url) continue;                          // not self
      if (sEntry.outlinks.includes(url)) continue;        // already links here
      if (sEntry.plainText.length < 300) continue;        // too short

      let relevance = scoreRelevanceV2(entry, sEntry);

      // Boost relevance for canonical URLs (+15)
      if (CANONICAL_URL_PATHS.has(targetPath)) {
        relevance = Math.min(100, relevance + 15);
      }

      if (relevance < 20) continue; // minimum 20/100 to be considered

      const anchorResult = findAnchorInSource(sEntry.plainText, entry.title, entry.handle);
      if (!anchorResult) continue;

      candidates.push({
        source:        sEntry,
        target:        entry,
        relevance,
        anchor:        anchorResult.anchor,
        context:       anchorResult.context,
        anchorScore:   anchorResult.score,
      });
    }

    // Sort by relevance + anchor quality
    candidates.sort((a, b) => (b.relevance + b.anchorScore*2) - (a.relevance + a.anchorScore*2));

    for (const c of candidates.slice(0, MAX_SUGGESTIONS_PER_ORPHAN)) {
      const confidence = c.relevance >= 60 && entry.inlinks.length === 0 && c.source.outlinks.length >= 3 && c.anchorScore >= 2
        ? 'high' : 'medium';

      suggestions.push({
        inlinkCount:     entry.inlinks.length,
        sourceId:        c.source.id,
        sourceTitle:     c.source.title,
        sourceHandle:    c.source.handle,
        sourceUrl:       c.source.url,
        sourceType:      c.source.type || 'blog',
        targetId:        entry.id,
        targetTitle:     entry.title,
        targetHandle:    entry.handle,
        targetUrl:       url,
        targetType:      entry.type || 'blog',
        suggestedAnchor: c.anchor,
        contextSnippet:  c.context.replace(/,/g, ';').replace(/\n/g, ' '),
        relevanceScore:  c.relevance,
        confidence,
        status:          'pending', // user changes to 'approved' or 'skip'
      });
    }
  }

  return suggestions;
}

// ─── Stats summary ────────────────────────────────────────────────────────────
function buildReport(byUrl, suggestions, brokenLinks = []) {
  const all        = [...byUrl.values()];
  const orphans    = all.filter(e => e.inlinks.length === ORPHAN_THRESHOLD);
  const lowLink    = all.filter(e => e.inlinks.length === LOW_LINK_THRESHOLD);
  const wellLinked = all.filter(e => e.inlinks.length > LOW_LINK_THRESHOLD);

  const totalLinks = all.reduce((s, e) => s + e.outlinks.length, 0);
  const avgOut     = totalLinks / (all.length || 1);
  const noOutlinks = all.filter(e => e.outlinks.length === 0);

  // Top linked pages (most inlinks)
  const topLinked = [...all].sort((a,b) => b.inlinks.length - a.inlinks.length).slice(0, 10);

  // Broken link stats
  const fixable   = brokenLinks.filter(b => b.fixHref);
  const unfixable = brokenLinks.filter(b => !b.fixHref);
  const byType    = {};
  for (const b of brokenLinks) {
    byType[b.type] = (byType[b.type] || 0) + 1;
  }

  const blogPages    = all.filter(e => e.type === 'blog' || !e.type);
  const productPages = all.filter(e => e.type === 'product');

  const lines = [
    '══════════════════════════════════════════════════════════════',
    `  INTERNAL LINK GRAPH REPORT: ${SITE.replace(/^https?:\/\//, '')}`,
    `  Generated: ${new Date().toISOString().slice(0,19).replace('T',' ')}`,
    '══════════════════════════════════════════════════════════════',
    '',
    '  OVERVIEW',
    `  Total pages in graph:      ${all.length} (${blogPages.length} blog + ${productPages.length} product)`,
    `  Total internal links:      ${totalLinks}`,
    `  Avg outlinks per page:     ${avgOut.toFixed(1)}`,
    '',
    '  LINK HEALTH',
    `  ✅ Well-linked (>1 inlink): ${wellLinked.length}`,
    `  ⚠️  Single-link pages:      ${lowLink.length}`,
    `  🔴 Orphan pages (0 inlinks):${orphans.length}`,
    `  📭 Posts with 0 outlinks:   ${noOutlinks.length}`,
    '',
  ];

  // ── Broken internal links section ──
  if (brokenLinks.length > 0) {
    lines.push(
      '  ═══ BROKEN INTERNAL LINKS ═══',
      `  🔴 Total broken:           ${brokenLinks.length}`,
      `  ✅ Auto-fixable:           ${fixable.length}`,
      `  ❌ Manual review needed:   ${unfixable.length}`,
      '',
      '  By type:',
    );
    for (const [type, count] of Object.entries(byType)) {
      const label = {
        'wrong_slug':         'Wrong/hallucinated slug',
        'malformed_external': 'External URL missing https://',
        'url_encoded_spaces': 'URL-encoded spaces (copy-paste)',
        'unknown':            'No match found',
      }[type] || type;
      lines.push(`    ${String(count).padStart(4)}  ${label}`);
    }
    lines.push('');

    // Show fixable broken links
    if (fixable.length > 0) {
      lines.push('  FIXABLE BROKEN LINKS (first 30):');
      for (const b of fixable.slice(0, 30)) {
        lines.push(`    In: ${b.sourceTitle.slice(0, 50)}`);
        lines.push(`      ❌ ${b.brokenHref.slice(0, 70)}`);
        lines.push(`      ✅ → ${b.fixHref.slice(0, 70)}`);
      }
      if (fixable.length > 30) lines.push(`    ... and ${fixable.length - 30} more`);
      lines.push('');
    }

    // Show unfixable broken links
    if (unfixable.length > 0) {
      lines.push('  UNFIXABLE BROKEN LINKS (manual review):');
      for (const b of unfixable.slice(0, 20)) {
        lines.push(`    In: ${b.sourceTitle.slice(0, 50)}`);
        lines.push(`      ❌ ${b.brokenHref.slice(0, 70)} (${b.detail})`);
      }
      if (unfixable.length > 20) lines.push(`    ... and ${unfixable.length - 20} more`);
      lines.push('');
    }
  } else {
    lines.push('  ✅ BROKEN INTERNAL LINKS:  0: all clear!', '');
  }

  const approved = suggestions.filter(s => s.status === 'approved').length;
  const highConf = suggestions.filter(s => s.confidence === 'high').length;
  lines.push(
    `  SUGGESTIONS GENERATED:     ${suggestions.length} link injections`,
    `  (covering ${[...new Set(suggestions.map(s=>s.targetUrl))].length} orphan/low-link pages)`,
    `  High-confidence:           ${highConf}`,
    approved > 0 ? `  Auto-approved:             ${approved}` : '',
    '',
    '  TOP 10 MOST-LINKED PAGES',
    ...topLinked.map((e,i) =>
      `  ${String(i+1).padStart(2)}.  ${String(e.inlinks.length).padStart(3)} inlinks  ${e.title.slice(0,55)}`
    ),
    '',
    '  ORPHAN PAGES (0 inlinks): FIRST 20',
    ...orphans.slice(0, 20).map(e =>
      `       ${e.url.replace(SITE,'')}`
    ),
    orphans.length > 20 ? `       ... and ${orphans.length - 20} more (see approved-links.csv)` : '',
    '',
    '══════════════════════════════════════════════════════════════',
  );

  return lines.filter(l => l !== undefined).join('\n');
}

// ─── Write CSV ───────────────────────────────────────────────────────────────
function writeCsv(suggestions) {
  const header = [
    'status',
    'confidence',
    'target_inlinks',
    'source_type',
    'source_title',
    'source_url',
    'target_type',
    'target_title',
    'target_url',
    'suggested_anchor',
    'context_snippet',
    'relevance_score',
    'source_article_id',
    'target_article_id',
  ].join(',');

  const rows = suggestions.map(s => [
    s.status,
    s.confidence || 'medium',
    s.inlinkCount,
    s.sourceType || 'blog',
    `"${s.sourceTitle.replace(/"/g,'""')}"`,
    s.sourceUrl,
    s.targetType || 'blog',
    `"${s.targetTitle.replace(/"/g,'""')}"`,
    s.targetUrl,
    `"${s.suggestedAnchor.replace(/"/g,'""')}"`,
    `"${s.contextSnippet.replace(/"/g,'""')}"`,
    s.relevanceScore,
    s.sourceId,
    s.targetId,
  ].join(','));

  return [header, ...rows].join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🕸️   Internal Link Graph Builder: ${SITE.replace(/^https?:\/\//, '')}\n`);
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  if (!TOKEN) {
    console.error('❌  SHOPIFY_ADMIN_TOKEN not set in .env');
    process.exit(1);
  }

  // ── Load or fetch article data ──────────────────────────────
  let articles;
  let cacheExists = fs.existsSync(CACHE_FILE);
  let cacheAge = Infinity;

  // Safely parse cache: handle corrupted JSON (e.g. git merge conflicts)
  if (cacheExists && !FORCE) {
    try {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      cacheAge = Date.now() - new Date(parsed.fetchedAt).getTime();
    } catch (e) {
      console.warn(`  ⚠️  Cache file corrupted (${e.message}): will re-fetch from Shopify`);
      try { fs.unlinkSync(CACHE_FILE); } catch {}
      cacheExists = false;
      cacheAge = Infinity;
    }
  }

  if (!FORCE && cacheExists && cacheAge < CACHE_TTL_MS) {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    articles = cached.articles;
    console.log(`  📦  Loaded ${articles.length} articles from cache (${Math.round(cacheAge/60000)}m old)`);
  } else {
    console.log('  🔄  Fetching all articles from Shopify (includes body HTML)...');
    const blogId = await resolveBlogId();
    articles = await fetchAllArticlesWithBody(blogId);
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), articles }, null, 2));
    console.log(`  ✅  Fetched and cached ${articles.length} articles`);
  }

  // ── Fetch product pages ─────────────────────────────────────
  console.log('\n  🛒  Fetching product pages from Shopify...');
  let productPages = [];
  try {
    productPages = await fetchProductPages();
    console.log(`  ✅  Fetched ${productPages.length} product pages`);
  } catch (err) {
    console.warn(`  ⚠️  Product page fetch failed: ${err.message}: continuing with blog only`);
  }

  // ── Build graph ─────────────────────────────────────────────
  console.log('\n  🔗  Building link graph...');
  const byUrl = buildGraph(articles, productPages);

  // ── Detect broken internal links ───────────────────────────
  console.log('\n  🔍  Scanning for broken internal links...');
  const brokenLinks = detectBrokenLinks(articles, byUrl);
  const fixable     = brokenLinks.filter(b => b.fixHref);
  const unfixable   = brokenLinks.filter(b => !b.fixHref);
  console.log(`       🔴 Broken: ${brokenLinks.length} (${fixable.length} auto-fixable, ${unfixable.length} need manual review)`);

  // Save broken links report
  if (brokenLinks.length > 0) {
    fs.writeFileSync(BROKEN_LINKS_FILE, JSON.stringify(brokenLinks, null, 2));
    console.log(`       📄 Saved → ${path.basename(BROKEN_LINKS_FILE)}`);
  }

  // Apply fixes if requested
  if (FIX_BROKEN && fixable.length > 0) {
    const result = await applyBrokenLinkFixes(brokenLinks, articles);
    console.log(`\n  🔧  Fix results: ${result.fixed} fixed, ${result.failed} failed`);
  } else if (fixable.length > 0 && !FIX_BROKEN) {
    console.log(`\n  💡  Run with --fix-broken to auto-fix ${fixable.length} broken links`);
    console.log(`       Run with --fix-broken --dry-run to preview first`);
  }

  // ── Stats ───────────────────────────────────────────────────
  const all        = [...byUrl.values()];
  const orphans    = all.filter(e => e.inlinks.length === 0);
  const lowLink    = all.filter(e => e.inlinks.length === 1);
  const noOutlinks = all.filter(e => e.outlinks.length === 0);

  console.log(`\n  📊  Graph stats:`);
  console.log(`       Posts analysed:       ${all.length}`);
  console.log(`       Total internal links: ${all.reduce((s,e)=>s+e.outlinks.length,0)}`);
  console.log(`       Orphan pages:         ${orphans.length} (0 inlinks)`);
  console.log(`       Single-link pages:    ${lowLink.length} (1 inlink)`);
  console.log(`       Posts with 0 outlinks:${noOutlinks.length}`);

  if (REPORT_ONLY) {
    console.log('\n' + buildReport(byUrl, [], brokenLinks));
    return;
  }

  // ── Generate suggestions ────────────────────────────────────
  console.log('\n  🤔  Generating link injection suggestions...');
  const suggestions = generateSuggestions(byUrl);
  console.log(`  ✅  Generated ${suggestions.length} suggestions for ${[...new Set(suggestions.map(s=>s.targetUrl))].length} pages`);

  // ── Auto-approve high-confidence suggestions if flag is set ──
  if (AUTO_APPROVE) {
    const highConf = suggestions.filter(s => s.confidence === 'high');
    highConf.forEach(s => s.status = 'approved');
    console.log(`  🟢  Auto-approved ${highConf.length}/${suggestions.length} high-confidence suggestions`);
  }

  // ── Write report ────────────────────────────────────────────
  const report = buildReport(byUrl, suggestions, brokenLinks);
  console.log('\n' + report);
  fs.writeFileSync(REPORT_FILE, report);
  console.log(`  📄  Report saved → ${REPORT_FILE}`);

  // ── Write CSV ───────────────────────────────────────────────
  const csv = writeCsv(suggestions);
  fs.writeFileSync(CSV_FILE, csv);

  // ── Clean summary for status monitor ───────────────────────
  const targetPages = [...new Set(suggestions.map(s => s.targetUrl))].length;
  const totalLinks  = all.reduce((s, e) => s + e.outlinks.length, 0);
  const autoApproved = suggestions.filter(s => s.status === 'approved').length;
  console.log('\n' + '═'.repeat(50));
  console.log('  LINK GRAPH: WEEKLY SUMMARY');
  console.log('═'.repeat(50));
  console.log(`  Scanned:         ${all.length} blog posts + ${productPages.length} product pages`);
  console.log(`  Internal links:  ${totalLinks} (avg ${(totalLinks / all.length).toFixed(1)}/post)`);
  console.log(`  Broken links:    ${brokenLinks.length} (${fixable.length} fixable)`);
  console.log(`  Orphan pages:    ${orphans.length} (no other post links to them)`);
  console.log(`  Low-link pages:  ${lowLink.length} (only 1 inbound link)`);
  console.log(`  Fix suggestions: ${suggestions.length} links for ${targetPages} pages`);
  if (AUTO_APPROVE) {
    console.log(`  Auto-approved:   ${autoApproved}/${suggestions.length} high-confidence`);
  }
  console.log('═'.repeat(50));
  if (AUTO_APPROVE && autoApproved > 0) {
    console.log(`\n  → ${autoApproved} links auto-approved. Run: node src/inject-links.js`);
    console.log(`    (${suggestions.length - autoApproved} still pending manual review in approved-links.csv)\n`);
  } else {
    console.log(`\n  → Review approved-links.csv, change "pending" to "approved", then run: node src/inject-links.js\n`);
  }

  // ── Email weekly summary ───────────────────────────────────
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  const notifyTo  = process.env.EMAIL_NOTIFY || gmailUser;
  if (gmailUser && gmailPass && (suggestions.length > 0 || brokenLinks.length > 0)) {
    try {
      const nodemailer = require('nodemailer');
      const transport  = nodemailer.createTransport({
        host: 'smtp.gmail.com', port: 587, secure: false,
        auth: { user: gmailUser, pass: gmailPass },
      });
      const brokenSection = brokenLinks.length > 0 ? `
          <h3 style="color:#c00">🔴 Broken Internal Links: ${brokenLinks.length}</h3>
          <table style="border-collapse:collapse;font-family:sans-serif;margin:12px 0">
            <tr><td style="padding:4px 12px;font-weight:bold">Auto-fixable:</td><td style="color:#2e7d32;font-weight:bold">${fixable.length}</td></tr>
            <tr><td style="padding:4px 12px;font-weight:bold">Manual review:</td><td style="color:#c00">${unfixable.length}</td></tr>
          </table>
          ${fixable.length > 0 ? `<p>Run <code>node src/link-graph.js --fix-broken</code> to auto-fix ${fixable.length} broken links.</p>` : ''}
          ${unfixable.length > 0 ? `<p>See <code>broken-internal-links.json</code> for details on ${unfixable.length} links needing manual review.</p>` : ''}
        ` : '<p style="color:#2e7d32;font-weight:bold">✅ No broken internal links found!</p>';

      await transport.sendMail({
        from: `"${COMPANY_NAME} Link Graph" <${gmailUser}>`,
        to: notifyTo,
        subject: `[${COMPANY_NAME}] Link graph: ${brokenLinks.length} broken links, ${orphans.length} orphan pages`,
        html: `
          <h2>Weekly Internal Link Report</h2>
          ${brokenSection}
          <h3>Link Graph Stats</h3>
          <table style="border-collapse:collapse;font-family:sans-serif;margin:12px 0">
            <tr><td style="padding:4px 12px;font-weight:bold">Pages scanned:</td><td>${all.length} (${all.filter(e=>e.type==='blog'||!e.type).length} blog + ${productPages.length} product)</td></tr>
            <tr><td style="padding:4px 12px;font-weight:bold">Total internal links:</td><td>${totalLinks}</td></tr>
            <tr><td style="padding:4px 12px;font-weight:bold;color:#c00">Orphan pages (0 inlinks):</td><td style="color:#c00;font-weight:bold">${orphans.length}</td></tr>
            <tr><td style="padding:4px 12px;font-weight:bold;color:#e6a800">Low-link pages (1 inlink):</td><td style="color:#e6a800">${lowLink.length}</td></tr>
            <tr><td style="padding:4px 12px;font-weight:bold;color:#2e7d32">Fix suggestions generated:</td><td style="color:#2e7d32;font-weight:bold">${suggestions.length} links for ${targetPages} pages</td></tr>
            ${autoApproved > 0 ? `<tr><td style="padding:4px 12px;font-weight:bold;color:#1976d2">Auto-approved (high-confidence):</td><td style="color:#1976d2;font-weight:bold">${autoApproved}</td></tr>` : ''}
          </table>
          <h3>What to do:</h3>
          <ol>
            ${brokenLinks.length > 0 ? '<li><strong>Fix broken links:</strong> <code>node src/link-graph.js --fix-broken --dry-run</code> (preview) then <code>--fix-broken</code> (apply)</li>' : ''}
            ${autoApproved > 0 ? `<li><strong>${autoApproved} links already auto-approved</strong>: run <code>node src/inject-links.js</code> to inject them</li>` : ''}
            <li>Open <code>approved-links.csv</code> from the run's output</li>
            <li>Change "pending" → "approved" for links you want injected</li>
            <li>Run: <code>node src/inject-links.js</code></li>
          </ol>
          <p style="color:#888;font-size:12px">This runs every Monday. Use <code>--auto-approve</code> to auto-approve high-confidence suggestions.</p>
        `,
      });
      console.log(`  📧  Weekly summary emailed to ${notifyTo}`);
    } catch (err) {
      console.warn(`  ⚠️  Email failed: ${err.message}`);
    }
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error('❌  Fatal:', e.message);
    process.exit(1);
  });
}

module.exports = {
  getCluster, scoreRelevanceV2, extractInternalBlogLinks, classifyBrokenLink, findClosestSlug,
  detectBrokenLinks, findAnchorInSource, buildGraph, generateSuggestions, writeCsv, SITE, BLOG_BASE,
};
