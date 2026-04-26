const { chromium } = require('playwright');

async function testConnection() {
    console.log('Connecting with Playwright...');
    try {
        const browser = await chromium.connectOverCDP('http://localhost:9222');
        console.log('Connected successfully with Playwright!');
        const contexts = browser.contexts();
        console.log(`Contexts: ${contexts.length}`);
        const pages = contexts[0].pages();
        console.log(`Pages: ${pages.length}`);
        for (const p of pages) {
            console.log(` - ${await p.title()} (${p.url()})`);
        }
        await browser.close();
        console.log('Done.');
    } catch (e) {
        console.error('PLAYWRIGHT CONNECTION FAILED:', e);
    }
}

testConnection();
