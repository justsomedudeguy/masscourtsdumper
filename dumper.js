const { chromium } = require('patchright');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const {
  detectPortal,
  extractCaseMetadata,
  extractDocketEntries,
  sanitizeCaseTitle,
} = require('./dumper-utils');

// Allow fetching PDFs even when the host uses a mismatched cert (masscourts.org vs www.masscourts.org)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function dumpCase() {
  console.log('Attaching to browser at http://localhost:9222...');

  let browser;
  try {
    console.log('Connecting...');
    browser = await chromium.connectOverCDP('http://localhost:9222', { timeout: 15000 });
    console.log('Connected!');
  } catch (error) {
    console.error(`Failed to connect to browser: ${error.message}`);
    process.exit(1);
  }

  try {
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      console.error('No contexts found in browser.');
      return;
    }
    const context = contexts[0];
    const pages = context.pages();

    let page = null;
    let portal = null;
    console.log('Searching pages for supported court case tabs...');
    for (const p of pages) {
      const title = await p.title().catch(() => '');
      const url = p.url();
      const detected = detectPortal({ url, title });
      console.log(` - Page: "${title}" at ${url}${detected ? ` [${detected.label}]` : ''}`);
      if (detected && !page) {
        page = p;
        portal = detected;
      }
    }

    if (!page) {
      console.error('Could not find an open supported case tab. Open a MassCourts Case Details page or Nevada Case View page first.');
      return;
    }

    // CHECK FOR LOGIN / SESSION EXPIRED
    const isLoggedOut = await page.evaluate(() => {
      const text = document.body.innerText;
      return text.includes('Login') || text.includes('Session Expired') || text.includes('please log in');
    });

    if (isLoggedOut) {
      console.error('ERROR: You appear to be LOGGED OUT or your session has EXPIRED.');
      console.error('Please log back in and navigate to the case details page in your browser.');
      return;
    }

    const pageTitleStr = await page.title();
    console.log(`Found ${portal.label} page: "${pageTitleStr}" at ${page.url()}`);

    const docketHtmlTemplate = await page.content().catch(() => '');
    const pageDom = new JSDOM(docketHtmlTemplate, { url: page.url() });
    const { caseId, caseTitle } = extractCaseMetadata(pageDom.window.document, portal);

    const safeTitle = sanitizeCaseTitle(caseTitle);
    const outputDirName = `${caseId}-${safeTitle}`;
    const outputDir = path.join(__dirname, 'output', outputDirName);

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    console.log(`Saving results to: ${outputDir}`);

    // PDF INTERCEPTION
    let currentPdfBuffer = null;
    let verboseRequestLogging = true;
    let routeInterceptionEnabled = true;
    let lastPdfUrl = null;
    let debugStubCount = 0;
    // Keep waits aggressive so the session doesn't expire; override via env if needed
    const MAX_DOC_WAIT_MS = parseInt(process.env.MAX_DOC_WAIT_MS || '40000', 10); // default 90s per doc
    const CLICK_RETRY_MS = parseInt(process.env.CLICK_RETRY_MS || '20000', 10);
    const WAIT_BETWEEN_DOCS_MS = parseInt(process.env.WAIT_BETWEEN_DOCS_MS || '0', 10);
    const PDF_POLL_MS = parseInt(process.env.PDF_POLL_MS || '200', 10);
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const refererUrl = page.url();

    function isPdfResponse(response) {
      const headers = response.headers();
      const ct = (headers['content-type'] || '').toLowerCase();
      const cd = (headers['content-disposition'] || '').toLowerCase();
      const url = response.url().toLowerCase();
      const isPdfType = ct.includes('pdf');
      const isOctet = ct.includes('application/octet-stream');
      const hasPdfName = cd.includes('.pdf') || url.includes('.pdf');
      return isPdfType || (isOctet && hasPdfName) || cd.includes('pdf');
    }

    async function fetchPdfWithCookies(url) {
      try {
        const targetUrl = new URL(url);
        if (targetUrl.hostname === 'masscourts.org') targetUrl.hostname = 'www.masscourts.org';
        const cookies = await context.cookies(targetUrl.toString());
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        const res = await fetch(targetUrl.toString(), {
          redirect: 'follow',
          headers: {
            'accept': 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            'cookie': cookieHeader,
            'user-agent': userAgent,
            'referer': refererUrl,
            'upgrade-insecure-requests': '1'
          }
        });
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        const buf = Buffer.from(await res.arrayBuffer());
        const prefix = buf.slice(0, 30).toString();
        console.log(`    [Refetch] ${res.status} ${ct || ''} len=${buf.length} prefix=${JSON.stringify(prefix)}`);
        if (res.ok && buf.length > 5 && prefix.startsWith('%PDF-')) return buf;
        return null;
      } catch (e) {
        return null;
      }
    }

    function extractPdfUrlsFromHtml(htmlStr, baseUrl) {
      const found = new Set();
      const addUrl = (u) => {
        try {
          const abs = new URL(u, baseUrl).toString();
          found.add(abs);
        } catch (_) { }
      };

      const refreshMatch = htmlStr.match(/http-equiv=["']refresh["'][^>]*content=["'][^;]+;url=([^"'>]+)/i);
      if (refreshMatch) addUrl(refreshMatch[1]);

      const locMatch = htmlStr.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
      if (locMatch) addUrl(locMatch[1]);

      const hrefSrcRegex = /(href|src)=["']([^"']+)["']/gi;
      let m;
      while ((m = hrefSrcRegex.exec(htmlStr)) !== null) {
        const candidate = m[2];
        if (candidate.toLowerCase().includes('pdf') || candidate.toLowerCase().includes('binary')) {
          addUrl(candidate);
        }
      }

      return Array.from(found);
    }

    async function tryExtractAndFetchFromHtml(bodyBuf, baseUrl, sourceTag) {
      try {
        const text = bodyBuf.toString();
        const candidates = extractPdfUrlsFromHtml(text, baseUrl);
        if (!candidates.length) return false;
        for (const candidate of candidates) {
          const fetched = await fetchPdfWithCookies(candidate);
          if (fetched && fetched.length > 5 && fetched.slice(0, 5).toString() === '%PDF-') {
            currentPdfBuffer = fetched;
            lastPdfUrl = candidate;
            console.log(`    [HTML->PDF] Captured via ${sourceTag}: ${candidate} (${fetched.length} bytes)`);
            return true;
          } else if (fetched) {
            const prefix = fetched.slice(0, 40).toString();
            console.log(`    [HTML->PDF] Refetch not PDF (${fetched.length} bytes). Prefix: ${prefix}`);
          }
        }
      } catch (_) { }
      return false;
    }

    async function clickViewerDownloadButton(popup, label = '') {
      try {
        const clicked = await popup.evaluate(() => {
          function dive(root, selectors) {
            let cur = root;
            for (const sel of selectors) {
              if (!cur) return null;
              const scope = cur.shadowRoot || cur;
              cur = scope.querySelector(sel);
            }
            return cur;
          }

          const roots = [
            document.querySelector('viewer-app'),
            document.querySelector('pdf-viewer'),
            document.body
          ].filter(Boolean);

          const selectorChains = [
            ['viewer-toolbar', 'cr-toolbar', '#centerSlot', 'cr-icon-button#download'],
            ['viewer-toolbar', 'cr-icon-button#download'],
            ['cr-icon-button#download'],
            ['#download'],
          ];

          for (const root of roots) {
            for (const chain of selectorChains) {
              const btn = dive(root, chain);
              if (btn) { btn.click(); return true; }
            }
          }

          const anchor = document.querySelector('a[download], a[href$=\".pdf\"]');
          if (anchor) { anchor.click(); return true; }

          return false;
        });

        if (clicked) {
          console.log(`    [Popup] Clicked viewer download${label ? ` (${label})` : ''}`);
        }
        return clicked;
      } catch (e) {
        console.log(`    [Popup] Download click failed${label ? ` (${label})` : ''}: ${e.message}`);
        return false;
      }
    }

    // 0. Request interception fallback (reliable for CDP-attached sessions)
    await context.route('**/*', async (route) => {
      if (!routeInterceptionEnabled) {
        await route.continue().catch(() => { });
        return;
      }

      const request = route.request();
      const url = request.url();
      const lowerUrl = url.toLowerCase();

      if (lowerUrl.includes('results.page') || lowerUrl.includes('wicket') || lowerUrl.includes('pdf')) {
        try {
          const response = await route.fetch({ timeout: 60000 });
          const headers = response.headers();
          const ct = (headers['content-type'] || '').toLowerCase();
          const cd = (headers['content-disposition'] || '').toLowerCase();
          const looksLikePdf = ct.includes('pdf') || cd.includes('pdf') || lowerUrl.includes('.pdf');

          if (looksLikePdf) {
            lastPdfUrl = url;
            const body = await response.body().catch(() => null);
            if (body && body.length > 5) {
              const prefix = body.slice(0, 15).toString();
              if (body.length > 500 && prefix.startsWith('%PDF-')) {
                currentPdfBuffer = body;
              } else {
                // Likely HTML wrapper; attempt extraction
                if (debugStubCount < 5) {
                  debugStubCount++;
                  const stubPath = path.join(outputDir, `stub_route_${debugStubCount}.html`);
                  fs.writeFileSync(stubPath, body);
                  console.log(`    [Debug] Saved small route body to ${stubPath} (${body.length} bytes)`);
                }
                await tryExtractAndFetchFromHtml(body, url, 'route');
              }
            }
          }

          if (!route.isHandled?.()) {
            await route.fulfill({ response }).catch(() => { });
          }
        } catch (e) {
          if (!route.isHandled?.()) {
            await route.continue().catch(() => { });
          }
        }
        return;
      }

      await route.continue().catch(() => { });
    });

    // 1. Download Listener
    page.on('download', async (download) => {
      console.log(`    [Download] Started: ${download.suggestedFilename()}`);
      try {
        const stream = await download.createReadStream();
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        if (body.length > 1000) {
          console.log(`    [Download] Captured: ${body.length} bytes`);
          currentPdfBuffer = body;
        }
      } catch (e) { }
    });

    // 2. Response Listener (Context-level, Passive)
    context.on('response', async (response) => {
      try {
        const url = response.url();
        const headers = response.headers();
        const ct = (headers['content-type'] || '').toLowerCase();
        const cd = (headers['content-disposition'] || '').toLowerCase();

        if (verboseRequestLogging && (ct.includes('pdf') || ct.includes('xml') || url.includes('wicket') || cd.includes('pdf'))) {
          console.log(`    [Network] ${response.status()} ${ct} ${cd ? '| ' + cd : ''} - ${url.substring(0, 80)}`);
        }

        if (isPdfResponse(response)) {
          lastPdfUrl = url;
          const body = await response.body().catch(() => null);
            if (body) {
              if (body.length > 1000) {
                console.log(`    [Response] Captured PDF: ${body.length} bytes from ${url.substring(0, 40)}...`);
                currentPdfBuffer = body;
              } else {
                const prefix = body.slice(0, 50).toString();
                console.log(`    [Response] Small PDF-like response (${body.length} bytes). Header: ${prefix}`);
                if (prefix.startsWith('%PDF-')) {
                  currentPdfBuffer = body;
                } else {
                  if (debugStubCount < 5) {
                    debugStubCount++;
                    const stubPath = path.join(outputDir, `stub_resp_${debugStubCount}.html`);
                    fs.writeFileSync(stubPath, body);
                    console.log(`    [Debug] Saved small response body to ${stubPath} (${body.length} bytes)`);
                  }
                  await tryExtractAndFetchFromHtml(body, url, 'response');
                }
              }
            }
        } else if (ct.includes('xml') || url.includes('wicket')) {
          const body = await response.body().catch(() => null);
          if (body) {
            const text = body.toString();
            if (debugStubCount < 5) {
              debugStubCount++;
              const stubPath = path.join(outputDir, `stub_wicket_${debugStubCount}.xml`);
              fs.writeFileSync(stubPath, body);
              console.log(`    [Debug] Saved Wicket XML to ${stubPath} (${body.length} bytes)`);
            }
            if (text.includes('application/pdf')) {
              console.log('    [Response] Found PDF reference in Wicket XML');
              const urlRegex = /(https?:[^\\s"'<>]+|\\?wicket:[^\\s"'<>]+)/gi;
              const matches = text.match(urlRegex) || [];
              for (const m of matches) {
                if (m.toLowerCase().includes('pdf') || m.toLowerCase().includes('binary') || m.toLowerCase().includes('wicket:interface')) {
                  const candidate = m.startsWith('http') ? m : new URL(m, url).toString();
                  const fetched = await fetchPdfWithCookies(candidate);
                  if (fetched && fetched.length > 5 && fetched.slice(0, 5).toString() === '%PDF-') {
                    currentPdfBuffer = fetched;
                    lastPdfUrl = candidate;
                    console.log(`    [Wicket] Captured PDF via candidate ${candidate} (${fetched.length} bytes)`);
                    break;
                  }
                }
              }
            }
          }
        }
      } catch (e) { }
    });

    // 3. Popup Listener
    page.on('popup', async (popup) => {
      console.log(`    [Popup] Detected: ${popup.url()}`);
      if (popup.url()) lastPdfUrl = popup.url();
      const handlePopupResponse = async (resp) => {
        try {
          if (isPdfResponse(resp)) {
            lastPdfUrl = resp.url();
            const body = await resp.body().catch(() => null);
            if (!currentPdfBuffer && body && body.length > 500 && body.slice(0, 5).toString() === '%PDF-') {
              currentPdfBuffer = body;
              console.log(`    [Popup] Captured PDF from response (${body.length} bytes)`);
            }
          }
        } catch (e) { }
      };

      popup.on('response', handlePopupResponse);
      popup.on('download', async (download) => {
        try {
          const stream = await download.createReadStream();
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          const body = Buffer.concat(chunks);
          if (!currentPdfBuffer && body.length > 500 && body.slice(0, 5).toString() === '%PDF-') {
            currentPdfBuffer = body;
            lastPdfUrl = popup.url() || lastPdfUrl;
            console.log(`    [Popup] Captured PDF from download (${body.length} bytes)`);
          }
        } catch (e) { }
      });

      // Attempt to click the viewer download button proactively
      clickViewerDownloadButton(popup, 'immediate');

      popup.waitForLoadState('domcontentloaded').then(() => {
        clickViewerDownloadButton(popup, 'domcontentloaded');
      }).catch(() => { });

      popup.waitForLoadState('networkidle').then(async () => {
        try {
          await clickViewerDownloadButton(popup, 'networkidle');

          const popupUrl = popup.url();
          if (!currentPdfBuffer && popupUrl) {
            const fetched = await fetchPdfWithCookies(popupUrl);
            if (fetched && fetched.length > 5 && fetched.slice(0, 5).toString() === '%PDF-') {
              currentPdfBuffer = fetched;
              lastPdfUrl = popupUrl;
              console.log(`    [Popup] Captured PDF via refetch (${fetched.length} bytes)`);
            } else if (fetched) {
              await tryExtractAndFetchFromHtml(fetched, popupUrl, 'popup-refetch');
            } else {
              // As a final attempt, inspect popup HTML directly
              const html = await popup.content();
              const handled = await tryExtractAndFetchFromHtml(Buffer.from(html || ''), popupUrl, 'popup-html');
              if (handled) return;
            }
          }
        } catch (e) { }
      }).catch(() => { });
    });

    const documentLinkSelector = portal.documentMode === 'direct'
      ? 'a[href*="document/view.do"], a[href*="/document/view.do"]'
      : 'a.dktImage';

    console.log('Waiting for docket links to appear...');
    try {
      await page.waitForSelector(documentLinkSelector, { timeout: 10000 });
    } catch (e) {
      console.warn(`  Warning: ${documentLinkSelector} selector not found. Checking if page content is correct.`);
      const content = await page.content();
      if (content.includes('Case Details') || content.includes('Docket Entries')) {
        console.log('  Page content seems correct, but no document links found.');
      } else {
        console.log('  Page content snippet (first 500 chars):', content.substring(0, 500));
      }
    }

    let entries;
    try {
      const entriesDom = new JSDOM(docketHtmlTemplate, { url: page.url() });
      entries = extractDocketEntries(entriesDom.window.document, portal);
    } catch (e) {
      console.error(`  Extraction Error: ${e.message}`);
      return;
    }

    console.log(`Found ${entries.length} document links.`);

    const successfullyDownloaded = [];

    async function checkErrorDialog() {
      return await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll('.ui-dialog'));
        for (const dialog of dialogs) {
          if (window.getComputedStyle(dialog).display !== 'none') {
            const text = dialog.innerText;
            if (text.includes('No Document Available') || text.includes('Error') || text.includes('restricted')) {
              const closeBtn = dialog.querySelector('.ui-dialog-titlebar-close');
              if (closeBtn) closeBtn.click();
              return text.trim();
            }
          }
        }
        return null;
      });
    }

    async function waitForOverlay() {
      let visible = true;
      while (visible) {
        const errorMsg = await checkErrorDialog();
        if (errorMsg) return errorMsg;

        visible = await page.evaluate(() => {
          const overlay = document.querySelector('.ui-widget-overlay') || document.querySelector('#processingDialog');
          if (!overlay) return false;
          const style = window.getComputedStyle(overlay);
          return style.display !== 'none' && style.visibility !== 'hidden' && overlay.offsetParent !== null;
        });
        if (visible) { await new Promise(r => setTimeout(r, 1000)); } else { break; }
      }
      return null;
    }

    async function patchAndSave(downloads) {
      try {
        if (!docketHtmlTemplate) {
          console.warn('    Warning: No docket HTML captured; skipping docket.html patch.');
          return;
        }
        const dom = new JSDOM(docketHtmlTemplate, { url: refererUrl });
        const doc = dom.window.document;
        downloads.forEach(dl => {
          let el = dl.id ? doc.getElementById(dl.id) : null;
          if (!el && dl.href) {
            const targetHref = new URL(dl.href, refererUrl).toString();
            el = Array.from(doc.querySelectorAll('a[href]')).find(anchor => {
              try {
                return new URL(anchor.getAttribute('href'), refererUrl).toString() === targetHref;
              } catch (_) {
                return false;
              }
            });
          }
          if (el) {
            el.setAttribute('href', dl.fileName);
            el.removeAttribute('onclick');
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noreferrer noopener');
            el.style.fontWeight = 'bold';
            el.style.color = '#0066cc';
          }
        });
        fs.writeFileSync(path.join(outputDir, 'docket.html'), dom.serialize());
      } catch (e) {
        console.error(`    Warning: Failed to patch docket.html: ${e.message}`);
      }
    }

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const fileName = `${entry.docNum}_${entry.text}.pdf`;
      const filePath = path.join(outputDir, fileName);
      const entryLabel = entry.id || entry.href || entry.docNum;

      if (fs.existsSync(filePath)) {
        console.log(`    Skipping [${i + 1}/${entries.length}]: ${fileName}`);
        successfullyDownloaded.push({ id: entry.id, href: entry.href, fileName: fileName });
        continue;
      }

      console.log(`Processing [${i + 1}/${entries.length}]: ${entryLabel} - #${entry.docNum} - ${entry.text}`);

      try {
        routeInterceptionEnabled = true;
        const preError = await waitForOverlay();
        if (preError) {
          console.log(`    Skipping ${entryLabel}: Error dialog detected before click: ${preError}`);
          continue;
        }

        currentPdfBuffer = null;
        lastPdfUrl = null;
        let schedulePdfTabClose = () => { };
        let pdfResponsePromise = Promise.resolve(null);

        if (portal.documentMode === 'direct' && entry.href) {
          console.log(`  Fetching ${entry.href}...`);
          lastPdfUrl = entry.href;
          currentPdfBuffer = await fetchPdfWithCookies(entry.href);
        } else {
          const pagePromise = context.waitForEvent('page', { timeout: MAX_DOC_WAIT_MS }).catch(() => null);
          let pdfTabCloseScheduled = false;
          schedulePdfTabClose = () => {
            if (pdfTabCloseScheduled) return;
            pdfTabCloseScheduled = true;
            pagePromise.then((pdfPage) => {
              if (pdfPage && !pdfPage.isClosed()) {
                pdfPage.close().catch(() => { });
              }
            }).catch(() => { });
          };
          pdfResponsePromise = page.waitForResponse(res => isPdfResponse(res), { timeout: MAX_DOC_WAIT_MS }).catch(() => null);

          console.log(`  Clicking ${entryLabel}...`);
          await page.evaluate((target) => {
            let el = target.id ? document.getElementById(target.id) : null;
            if (!el && target.href) {
              const targetHref = new URL(target.href, location.href).toString();
              el = Array.from(document.querySelectorAll('a[href]')).find(anchor => {
                try {
                  return new URL(anchor.getAttribute('href'), location.href).toString() === targetHref;
                } catch (_) {
                  return false;
                }
              });
            }
            if (el) el.click();
          }, { id: entry.id, href: entry.href });

          const start = Date.now();
          let lastClickTs = start;
          let loopError = null;
          while (!currentPdfBuffer) {
            loopError = await checkErrorDialog();
            if (loopError) {
              console.log(`    Skipping ${entryLabel}: Error dialog detected: ${loopError}`);
              currentPdfBuffer = 'ERROR';
              break;
            }

            const elapsed = Date.now() - start;
            if (elapsed > MAX_DOC_WAIT_MS) {
              console.log(`    Timeout after ${Math.round(elapsed / 1000)}s waiting for ${entryLabel}`);
              break;
            }

            if (Date.now() - lastClickTs > CLICK_RETRY_MS) {
              console.log(`    Re-clicking ${entryLabel} after ${Math.round(elapsed / 1000)}s...`);
              await page.evaluate((target) => {
                let el = target.id ? document.getElementById(target.id) : null;
                if (!el && target.href) {
                  const targetHref = new URL(target.href, location.href).toString();
                  el = Array.from(document.querySelectorAll('a[href]')).find(anchor => {
                    try {
                      return new URL(anchor.getAttribute('href'), location.href).toString() === targetHref;
                    } catch (_) {
                      return false;
                    }
                  });
                }
                if (el) el.click();
              }, { id: entry.id, href: entry.href });
              lastClickTs = Date.now();
            }

            await new Promise(r => setTimeout(r, PDF_POLL_MS));
          }
        }

        const directPdfResponse = await pdfResponsePromise;
        if (!currentPdfBuffer && directPdfResponse) {
          lastPdfUrl = directPdfResponse.url();
          const body = await directPdfResponse.body().catch(() => null);
          if (body && body.length > 1000) currentPdfBuffer = body;
        }

        if (!currentPdfBuffer && lastPdfUrl) {
          const fetched = await fetchPdfWithCookies(lastPdfUrl);
          if (fetched && fetched.length > 5) {
            const prefix = fetched.slice(0, 15).toString();
            if (prefix.startsWith('%PDF-')) {
              currentPdfBuffer = fetched;
            } else {
              console.log(`    Refetch returned non-PDF (${fetched.length} bytes). Prefix: ${prefix}`);
            }
          }
        }

        if (currentPdfBuffer && currentPdfBuffer !== 'ERROR') {
          if (currentPdfBuffer.length > 5 && currentPdfBuffer.slice(0, 5).toString() === '%PDF-') {
            fs.writeFileSync(filePath, currentPdfBuffer);
            console.log(`    Saved: ${fileName} (${currentPdfBuffer.length} bytes)`);
            successfullyDownloaded.push({ id: entry.id, href: entry.href, fileName: fileName });
            await patchAndSave(successfullyDownloaded);
            schedulePdfTabClose();
          } else {
            console.log(`    Error: Downloaded data for ${entryLabel} is not a valid PDF.`);
            if (lastPdfUrl) {
              const fetched = await fetchPdfWithCookies(lastPdfUrl);
              if (fetched && fetched.length > 5 && fetched.slice(0, 5).toString() === '%PDF-') {
                fs.writeFileSync(filePath, fetched);
                console.log(`    Saved via refetch: ${fileName} (${fetched.length} bytes)`);
                successfullyDownloaded.push({ id: entry.id, href: entry.href, fileName: fileName });
                await patchAndSave(successfullyDownloaded);
                schedulePdfTabClose();
              } else if (fetched) {
                const prefix = fetched.slice(0, 30).toString();
                console.log(`    Refetch still not PDF (${fetched.length} bytes). Prefix: ${prefix}`);
              }
            }
          }
        } else {
          console.log(`    Failed to capture PDF for ${entryLabel}.`);
        }
      } catch (e) {
        console.error(`  Error: ${e.message}`);
      }

      routeInterceptionEnabled = false;
      if (WAIT_BETWEEN_DOCS_MS > 0) {
        await new Promise(r => setTimeout(r, WAIT_BETWEEN_DOCS_MS));
      }
    }

    console.log(`Dump completed. Processed ${successfullyDownloaded.length} documents.`);
    await browser.close();

  } catch (globalError) {
    console.error(`FATAL ERROR: ${globalError.message}`);
    console.error(globalError.stack);
  }
}

dumpCase();
