const { chromium } = require('patchright');

async function debug() {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const context = browser.contexts()[0];
    const pages = context.pages();

    console.log(`Found ${pages.length} pages.`);

    for (const page of pages) {
        console.log(`\nPage: ${await page.title()} [${page.url()}]`);

        const tables = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('table')).map(t => ({
                id: t.id,
                summary: t.summary,
                headers: Array.from(t.querySelectorAll('th')).map(th => th.innerText.trim())
            }));
        });

        console.log('Tables found:');
        tables.forEach(t => {
            console.log(` - ID: ${t.id}, Summary: ${t.summary}, Headers: ${t.headers.join(', ')}`);
        });

        const docketLinks = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a.dktImage')).length;
        });
        console.log(`"a.dktImage" links found: ${docketLinks}`);

        const allLinks = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a')).filter(a => a.innerText.includes('Image')).length;
        });
        console.log(`Links with text "Image": ${allLinks}`);
    }
}

debug();
