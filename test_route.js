const { chromium } = require('patchright');

async function testRoute() {
    console.log('Connecting...');
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    console.log('Setting up route...');
    try {
        await context.route('**/*', (route) => {
            console.log('Route hit:', route.request().url());
            route.continue().catch(() => { });
        });
        console.log('Route set successfully.');
    } catch (e) {
        console.error('FAILED TO SET ROUTE:', e);
    }

    await new Promise(r => setTimeout(r, 5000));
    await browser.close();
}

testRoute();
