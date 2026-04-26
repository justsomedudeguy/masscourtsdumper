const { chromium } = require('patchright');

async function debugLinks() {
    console.log('Connecting to browser...');
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const context = browser.contexts()[0];
    const pages = context.pages();
    const page = pages.find(p => p.url().includes('masscourts.org'));

    if (!page) {
        console.log('Could not find masscourts page.');
        await browser.close();
        return;
    }

    console.log(`Checking links on ${page.url()}...`);
    const links = await page.evaluate(() => {
        const dktLinks = Array.from(document.querySelectorAll('a.dktImage'));
        return dktLinks.map(a => ({
            id: a.id,
            href: a.href,
            onclick: a.getAttribute('onclick')
        })).slice(0, 5);
    });

    console.log('Sample links:', JSON.stringify(links, null, 2));

    // Also listen to all requests for a moment
    console.log('Listening for requests... (click a document link now if you can)');
    page.on('request', request => {
        console.log(`>> Request: ${request.url()} (${request.resourceType()})`);
    });

    await new Promise(r => setTimeout(r, 10000));
    await browser.close();
}

debugLinks();
