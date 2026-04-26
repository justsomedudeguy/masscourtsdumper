const { chromium } = require('patchright');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

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

    let page = pages.find(p => p.url().includes('CaseDetails') && p.url().includes('masscourts.org'));
    if (!page) {
      console.log('Searching pages for "Case Details" title...');
      for (const p of pages) {
        const title = await p.title().catch(() => '');
        const url = p.url();
        console.log(` - Page: "${title}" at ${url}`);
        if (title.includes('Case Details') || title.includes('Massachusetts Trial Court')) {
          if (url.includes('masscourts.org')) {
            page = p;
            break;
          }
        }
      }
    }

    if (!page) page = pages.find(p => p.url().includes('masscourts.org') && !p.url().includes('login'));

    if (!page) {
      console.error('Could not find an open masscourts.org Case Details tab.');
      return;
    }

    // CHECK FOR LOGIN / SESSION EXPIRED
    const isLoggedOut = await page.evaluate(() => {
      const text = document.body.innerText;
      return text.includes('Login') || text.includes('Session Expired') || text.includes('please log in');
    });

    if (isLoggedOut) {
      console.error('ERROR: You appear to be LOGGED OUT or your session has EXPIRED.');
      console.error('Please log back in and navigate to the Case Details page in your browser.');
      return;
    }

    const pageTitleStr = await page.title();
    console.log(`Found page: "${pageTitleStr}" at ${page.url()}`);

    const { caseId, caseTitle } = await page.evaluate(() => {
      let titleEl = document.querySelector('li.displayData') || document.querySelector('.case-header-info') || document.querySelector('h1 .displayData');
      if (!titleEl) {
        const h1s = Array.from(document.querySelectorAll('h1'));
        titleEl = h1s.find(h => h.innerText.length > 5 && !h.innerText.includes('N2') && !h.innerText.includes('N5'));
      }
      const fullText = titleEl ? titleEl.innerText.trim() : '';
      const match = fullText.match(/^([A-Z0-9-]+)\b\s*[-]?[ \t]*(.*)$/i);
      if (match) {
        return { caseId: match[1], caseTitle: match[2]?.trim() || fullText };
      }
      return { caseId: 'case_dump', caseTitle: fullText || 'Unknown' };
    });

    const safeTitle = caseTitle.replace(/[^a-z0-9, vs. ]/gi, '').substring(0, 50).trim();
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

    console.log('Waiting for docket links to appear...');
    try {
      await page.waitForSelector('a.dktImage', { timeout: 10000 });
    } catch (e) {
      console.warn('  Warning: .dktImage selector not found. Checking if page content is correct.');
      const content = await page.content();
      if (content.includes('Case Details')) {
        console.log('  Page content seems correct, but no document links found.');
      } else {
        console.log('  Page content snippet (first 500 chars):', content.substring(0, 500));
      }
    }

    const entriesRes = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table'));
      const docketTable = tables.find(t => {
        const headers = Array.from(t.querySelectorAll('th')).map(th => th.innerText.toLowerCase());
        return headers.some(h => h.includes('docket text')) && headers.some(h => h.includes('image'));
      });
      if (!docketTable) return { error: 'Docket table not found.' };

      const headers = Array.from(docketTable.querySelectorAll('th')).map(th => th.innerText.toLowerCase().trim());
      const textIdx = headers.findIndex(h => h.includes('docket text'));
      const refIdx = headers.findIndex(h => h.includes('ref nbr') || h.includes('ref #'));

      const rows = Array.from(docketTable.querySelectorAll('tbody tr'));
      const data = rows.map((row, index) => {
        const imgLink = row.querySelector('a.dktImage');
        if (imgLink) {
          const cells = Array.from(row.querySelectorAll('td'));
          let docNumStr = (refIdx !== -1) ? (cells[refIdx]?.innerText?.trim() || '') : '';
          if (!docNumStr || isNaN(parseInt(docNumStr))) docNumStr = (index + 1).toString();
          const docNum = docNumStr.padStart(3, '0');
          const textStr = cells[textIdx]?.innerText?.trim().substring(0, 70).replace(/[^a-z0-9]/gi, '_') || 'NoText';
          return { id: imgLink.id, docNum: docNum, text: textStr };
        }
        return null;
      }).filter(e => e !== null);
      return { data };
    });

    if (entriesRes.error) {
      console.error(`  Extraction Error: ${entriesRes.error}`);
      return;
    }

    const docketHtmlTemplate = await page.content().catch(() => '');
    const entries = entriesRes.data || [];
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
        const dom = new JSDOM(docketHtmlTemplate);
        const doc = dom.window.document;
        downloads.forEach(dl => {
          const el = doc.getElementById(dl.id);
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

      if (fs.existsSync(filePath)) {
        console.log(`    Skipping [${i + 1}/${entries.length}]: ${fileName}`);
        successfullyDownloaded.push({ id: entry.id, fileName: fileName });
        continue;
      }

      console.log(`Processing [${i + 1}/${entries.length}]: ${entry.id} - #${entry.docNum} - ${entry.text}`);

      try {
        routeInterceptionEnabled = true;
        const preError = await waitForOverlay();
        if (preError) {
          console.log(`    Skipping ${entry.id}: Error dialog detected before click: ${preError}`);
          continue;
        }

        currentPdfBuffer = null;
        lastPdfUrl = null;
        const pagePromise = context.waitForEvent('page', { timeout: MAX_DOC_WAIT_MS }).catch(() => null);
        let pdfTabCloseScheduled = false;
        const schedulePdfTabClose = () => {
          if (pdfTabCloseScheduled) return;
          pdfTabCloseScheduled = true;
          pagePromise.then((pdfPage) => {
            if (pdfPage && !pdfPage.isClosed()) {
              pdfPage.close().catch(() => { });
            }
          }).catch(() => { });
        };
        const pdfResponsePromise = page.waitForResponse(res => isPdfResponse(res), { timeout: MAX_DOC_WAIT_MS }).catch(() => null);

        console.log(`  Clicking ${entry.id}...`);
        await page.evaluate((id) => {
          const el = document.getElementById(id);
          if (el) el.click();
        }, entry.id);

        const start = Date.now();
        let lastClickTs = start;
        let loopError = null;
        while (!currentPdfBuffer) {
          loopError = await checkErrorDialog();
          if (loopError) {
            console.log(`    Skipping ${entry.id}: Error dialog detected: ${loopError}`);
            currentPdfBuffer = 'ERROR';
            break;
          }

           const elapsed = Date.now() - start;
           if (elapsed > MAX_DOC_WAIT_MS) {
             console.log(`    Timeout after ${Math.round(elapsed / 1000)}s waiting for ${entry.id}`);
             break;
           }

           if (Date.now() - lastClickTs > CLICK_RETRY_MS) {
             console.log(`    Re-clicking ${entry.id} after ${Math.round(elapsed / 1000)}s...`);
             await page.evaluate((id) => {
               const el = document.getElementById(id);
               if (el) el.click();
             }, entry.id);
             lastClickTs = Date.now();
           }

          await new Promise(r => setTimeout(r, PDF_POLL_MS));
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
            successfullyDownloaded.push({ id: entry.id, fileName: fileName });
            await patchAndSave(successfullyDownloaded);
            schedulePdfTabClose();
          } else {
            console.log(`    Error: Downloaded data for ${entry.id} is not a valid PDF.`);
            if (lastPdfUrl) {
              const fetched = await fetchPdfWithCookies(lastPdfUrl);
              if (fetched && fetched.length > 5 && fetched.slice(0, 5).toString() === '%PDF-') {
                fs.writeFileSync(filePath, fetched);
                console.log(`    Saved via refetch: ${fileName} (${fetched.length} bytes)`);
                successfullyDownloaded.push({ id: entry.id, fileName: fileName });
                await patchAndSave(successfullyDownloaded);
                schedulePdfTabClose();
              } else if (fetched) {
                const prefix = fetched.slice(0, 30).toString();
                console.log(`    Refetch still not PDF (${fetched.length} bytes). Prefix: ${prefix}`);
              }
            }
          }
        } else {
          console.log(`    Failed to capture PDF for ${entry.id}.`);
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
