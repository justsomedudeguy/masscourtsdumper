const { chromium } = require('patchright');
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function promptForUrl() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Enter main URL to scrape: ', (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', () => {});

function normalizeInputUrl(raw) {
  if (!raw) return null;
  try {
    return new URL(raw).toString();
  } catch (_) {
    try {
      return new URL(`https://${raw}`).toString();
    } catch (e) {
      return null;
    }
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function absolutizeUrl(raw, baseUrl) {
  try {
    const u = new URL(raw, baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch (_) {
    return null;
  }
}

const BLOCKED_EXTENSIONS = new Set([
  'pdf', 'djvu', 'ps', 'eps',
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'ico', 'webp',
  'mp3', 'wav', 'flac', 'm4a',
  'mp4', 'm4v', 'mov', 'avi', 'wmv', 'webm', 'mkv',
  'css', 'js', 'json', 'xml', 'rss', 'atom', 'txt'
]);

function isBlockedByExtension(urlStr) {
  try {
    const u = new URL(urlStr);
    const last = u.pathname.split('/').pop() || '';
    const dot = last.lastIndexOf('.');
    if (dot <= 0) return false;
    const ext = last.slice(dot + 1).toLowerCase();
    if (!ext) return false;
    return BLOCKED_EXTENSIONS.has(ext);
  } catch (_) {
    return false;
  }
}

function rewriteAttr(el, attr, baseUrl) {
  const val = el.getAttribute(attr);
  if (!val) return;
  const abs = absolutizeUrl(val, baseUrl);
  if (abs) el.setAttribute(attr, abs);
}

function rewriteSrcset(el, baseUrl) {
  const val = el.getAttribute('srcset');
  if (!val) return;
  const parts = val.split(',').map((chunk) => {
    const trimmed = chunk.trim();
    if (!trimmed) return chunk;
    const segs = trimmed.split(/\s+/);
    const abs = absolutizeUrl(segs[0], baseUrl);
    if (!abs) return chunk;
    return [abs, ...segs.slice(1)].join(' ');
  });
  el.setAttribute('srcset', parts.join(', '));
}

function extractLinksFromHtml(html, baseUrl, sameOriginOnly) {
  const dom = new JSDOM(html, { url: baseUrl, virtualConsole });
  const doc = dom.window.document;
  const baseOrigin = new URL(baseUrl).origin;
  const links = new Set();

  const anchors = Array.from(doc.querySelectorAll('a[href]'));
  for (const a of anchors) {
    const href = a.getAttribute('href');
    if (!href) continue;
    const lower = href.toLowerCase();
    if (lower.startsWith('#') || lower.startsWith('mailto:') || lower.startsWith('javascript:') || lower.startsWith('tel:')) {
      continue;
    }
    const abs = absolutizeUrl(href, baseUrl);
    if (!abs) continue;
    if (isBlockedByExtension(abs)) continue;
    const u = new URL(abs);
    u.hash = '';
    if (sameOriginOnly && u.origin !== baseOrigin) continue;
    links.add(u.toString());
  }

  return Array.from(links);
}

function normalizeHtmlForEmbedding(html, baseUrl) {
  const dom = new JSDOM(html, { url: baseUrl, virtualConsole });
  const doc = dom.window.document;

  doc.querySelectorAll('script, noscript, base, style').forEach((el) => el.remove());
  doc.querySelectorAll('link[rel="stylesheet"]').forEach((el) => el.remove());
  doc.querySelectorAll('meta[http-equiv="refresh"]').forEach((el) => el.remove());

  doc.querySelectorAll('[href]').forEach((el) => rewriteAttr(el, 'href', baseUrl));
  doc.querySelectorAll('[src]').forEach((el) => rewriteAttr(el, 'src', baseUrl));
  doc.querySelectorAll('[srcset]').forEach((el) => rewriteSrcset(el, baseUrl));

  const title = doc.title || '';
  const bodyHtml = doc.body ? doc.body.innerHTML : doc.documentElement.outerHTML;
  return { title, bodyHtml };
}

async function fetchPageHtml(page, url, timeoutMs) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const idleTimeout = Math.max(2000, Math.min(8000, Math.floor(timeoutMs / 4)));
  await page.waitForLoadState('networkidle', { timeout: idleTimeout }).catch(() => {});
  const title = await page.title().catch(() => '');
  let html = '';
  try {
    html = await page.content();
  } catch (_) {
    html = '';
  }
  const headers = response ? response.headers() : {};
  const contentType = (headers['content-type'] || '').toLowerCase();
  return {
    title,
    html,
    contentType,
    status: response ? response.status() : null,
    ok: response ? response.ok() : null
  };
}

function buildFetchErrorBody(url, meta) {
  const lines = [];
  lines.push(`Failed to read HTML for: ${url}`);
  if (meta && meta.status !== null) lines.push(`Status: ${meta.status}`);
  if (meta && meta.contentType) lines.push(`Content-Type: ${meta.contentType}`);
  return `<pre class="fetch-error">${escapeHtml(lines.join('\n'))}</pre>`;
}

function buildCombinedHtml(sections) {
  const tocEntries = sections.map((s, i) => {
    const idx = i + 1;
    return `<h2 class="toc-item"><a href="#section-${idx}">${escapeHtml(s.title || s.url)}</a></h2>
<div class="toc-url">${escapeHtml(s.url)}</div>`;
  }).join('\n');

  const sectionBlocks = sections.map((s, i) => {
    const idx = i + 1;
    const pageBreakClass = i === 0 ? '' : 'page-break';
    return `<section id="section-${idx}" class="doc-section ${pageBreakClass}">
  <h1>${escapeHtml(s.title || s.url)}</h1>
  <div class="section-url">${escapeHtml(s.url)}</div>
  ${s.bodyHtml}
</section>`;
  }).join('\n');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Simple Scrape PDF</title>
  <style>
    @page { margin: 0.75in; }
    body { font-family: "Georgia", "Times New Roman", serif; color: #1b1b1b; line-height: 1.4; }
    h1 { font-size: 22px; margin: 0 0 8px 0; }
    h2 { font-size: 16px; margin: 12px 0 2px 0; }
    a { color: #0645ad; text-decoration: none; }
    .toc { margin-bottom: 24px; }
    .toc-title { font-size: 26px; margin-bottom: 8px; }
    .toc-item { margin: 8px 0 0 0; }
    .toc-url { font-size: 11px; color: #444; margin-bottom: 6px; }
    .section-url { font-size: 11px; color: #444; margin: 0 0 12px 0; }
    .doc-section { page-break-inside: avoid; break-inside: avoid; }
    .page-break { page-break-before: always; break-before: page; }
    img { max-width: 100%; height: auto; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 6px; vertical-align: top; }
    pre { white-space: pre-wrap; word-break: break-word; }
    .fetch-error { background: #f7f7f7; border: 1px solid #ddd; padding: 10px; }
  </style>
</head>
<body>
  <section class="toc">
    <div class="toc-title">Table of Contents</div>
    ${tocEntries}
  </section>
  ${sectionBlocks}
</body>
</html>`;
}

async function run() {
  const inputUrl = await promptForUrl();
  const mainUrl = normalizeInputUrl(inputUrl);
  if (!mainUrl) {
    console.error('Invalid URL. Please provide a valid http(s) URL.');
    process.exit(1);
  }

  const sameOriginOnly = process.env.INCLUDE_EXTERNAL === '1' ? false : true;
  const navTimeoutMs = parseInt(process.env.NAV_TIMEOUT_MS || '45000', 10);
  const maxLinks = process.env.MAX_LINKS ? parseInt(process.env.MAX_LINKS, 10) : null;

  console.log(`Launching headless browser...`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log(`Fetching main page: ${mainUrl}`);
    let main;
    try {
      main = await fetchPageHtml(page, mainUrl, navTimeoutMs);
    } catch (e) {
      console.error(`Failed to fetch main URL: ${e.message}`);
      process.exit(1);
    }
    const links = main.html ? extractLinksFromHtml(main.html, mainUrl, sameOriginOnly) : [];
    let urls = [mainUrl, ...links.filter((u) => u !== mainUrl)];
    if (maxLinks && Number.isFinite(maxLinks) && maxLinks > 0 && urls.length > maxLinks + 1) {
      urls = urls.slice(0, maxLinks + 1);
      console.log(`Limiting to ${urls.length - 1} link(s) via MAX_LINKS=${maxLinks}.`);
    }

    console.log(`Found ${links.length} link(s) from main page.`);
    if (sameOriginOnly) {
      console.log(`Including only same-origin links (set INCLUDE_EXTERNAL=1 to include all).`);
    }

    const sections = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`Scraping [${i + 1}/${urls.length}]: ${url}`);
      let fetched;
      try {
        fetched = await fetchPageHtml(page, url, navTimeoutMs);
      } catch (e) {
        console.warn(`  Warning: failed to fetch ${url}: ${e.message}`);
        sections.push({
          url,
          title: url,
          bodyHtml: buildFetchErrorBody(url, { status: null, contentType: '' })
        });
        continue;
      }
      const { title, html, contentType, status } = fetched;
      let normalized;
      if (!html || (contentType && !contentType.includes('text/html'))) {
        normalized = {
          title: title || url,
          bodyHtml: buildFetchErrorBody(url, { status, contentType })
        };
      } else {
        normalized = normalizeHtmlForEmbedding(html, url);
      }
      sections.push({
        url,
        title: title || normalized.title || url,
        bodyHtml: normalized.bodyHtml
      });
    }

    const combinedHtml = buildCombinedHtml(sections);
    try {
      await page.setContent(combinedHtml, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      console.warn(`  Warning: setContent timed out: ${e.message}`);
    }

    const outDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const host = new URL(mainUrl).hostname.replace(/[^a-z0-9.-]/gi, '_');
    const outPath = path.join(outDir, `simplescrape_${host}_${stamp}.pdf`);

    await page.pdf({
      path: outPath,
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true
    });

    console.log(`PDF saved to: ${outPath}`);
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error(`FATAL ERROR: ${err.message}`);
  process.exit(1);
});
