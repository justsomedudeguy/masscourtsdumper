const { chromium } = require("patchright");
(async () => {
  const target = "https://masscourts.org/eservices/searchresults.page?x=R*mXZrrCTBAby2SPybyZmzv8*2VD7sC-taKmLwnzRf8-XPqMOQCGBVc9HE2dbCuawij8nRs96SgF4nW-5CPbYgV6mznOQ1c0HYrn*j*0EbnSUvVBF32E1uLodfQRktJZrAoyRyto9DS-YPMBqD-xmC*mpFw8DPDRlgAegqDAVrfOwvi8RRkD*XDiQcEOgyScqWCJ9tKziVjwaRGz*LYlfw&antiCache=1766840731092";
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];
  const cookies = await ctx.cookies(target);
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const ua = await page.evaluate(() => navigator.userAgent);
  const res = await fetch(target, {
    redirect: 'manual',
    headers: {
      'accept': 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
      'user-agent': ua,
      'referer': page.url(),
      'cookie': cookieHeader
    }
  });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(res.status, res.headers.get('content-type'), buf.length, buf.slice(0,80).toString());
})();
