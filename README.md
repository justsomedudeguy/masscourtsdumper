# masscourtsdumper

`masscourtsdumper` is a small Node.js toolkit for exporting Massachusetts Trial Court case materials from a MassCourts page that you have already opened in a browser.

The dumper does not use or require an authenticated MassCourts session. Public MassCourts search does not offer normal account login for this workflow, except for attorney access. You must manually pass the initial CAPTCHA and navigate to the specific case page you want before running the dumper.

The repository currently contains two main workflows:
!You might want to use a VPN when running this!

- `dumper.js`: attach to a running Chromium session, detect the open MassCourts Case Details page, and save the docket HTML plus linked PDFs into `output/`.
- `simplescrape.js`: prompt for a URL, crawl the main page plus discovered links, and render the result into a single PDF.

`datacleanup.js` is a post-processing utility for normalizing case folders and local docket links after a dump.

## Requirements

- Node.js 20+ recommended.
  `jsdom@27` requires a modern Node runtime; the current workspace is using Node `v22.17.0`.
- A Chromium-based browser launched with remote debugging on `http://localhost:9222`.
- A manually opened MassCourts Case Details page.
  You need to pass the initial CAPTCHA and navigate to the case yourself before running `dumper.js`.

The Node.js scripts work on Windows, Mac and Linux. The only OS-specific part is how you launch a local Chromium-based browser with the remote debugging flag.

## Install

```sh
npm install
```

## Main Workflow: Dump a MassCourts Case

1. Launch a Chromium-based browser with remote debugging enabled.

   Windows Command Prompt:

   ```bat
   chrome --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%/chrome_dumper_profile"
   ```

   macOS:

   ```sh
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/chrome_dumper_profile"
   ```

   Linux:

   ```sh
   google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/chrome_dumper_profile"
   ```

   If your browser executable is not on `PATH`, use the full local path to Chrome, Chromium, Edge, or another Chromium-based browser.

2. In that browser session:

   - Open MassCourts.
   - Pass the initial CAPTCHA manually.
   - Search for and open the specific `Case Details` page you want to export.

3. Run the dumper:

```sh
node ./dumper.js
```

4. Review the generated folder under `output/`.

Each case is saved into a directory named roughly:

```text
output/<case-id>-<case-title>/
```

Typical contents:

- `docket.html`: a patched local copy of the Case Details page.
- `001_<docket_text>.pdf`, `002_<docket_text>.pdf`, etc.
- optional `stub_*.html` / `stub_*.xml` debug artifacts when the site returns intermediate wrappers instead of direct PDFs.

## Dumper Behavior

`dumper.js` is designed around the current MassCourts UI and browser-session model.

- It connects to `http://localhost:9222` over CDP.
- It searches the existing browser tabs for a MassCourts Case Details page.
- It expects the CAPTCHA and case search steps to have been completed manually before it starts.
- It locates the docket table by header text, then iterates document links with selector `a.dktImage`.
- It uses several capture strategies for each PDF:
  route interception, response listeners, download listeners, popup handling, and cookie-backed refetches.
- It skips files that already exist, so reruns are partially resumable.
- It rewrites downloaded docket links in `docket.html` to point to local PDFs.

## Dumper Configuration

`dumper.js` reads the following environment variables:

- `MAX_DOC_WAIT_MS`
  Default: `40000`
  Maximum time to wait for a document before timing out.
- `CLICK_RETRY_MS`
  Default: `20000`
  How long to wait before re-clicking a docket item.
- `WAIT_BETWEEN_DOCS_MS`
  Default: `0`
  Optional delay between document attempts.
- `PDF_POLL_MS`
  Default: `200`
  Poll interval while waiting for a captured PDF buffer.

Windows Command Prompt example:

```bat
set MAX_DOC_WAIT_MS=60000
set CLICK_RETRY_MS=15000
node ./dumper.js
```

macOS and Linux example:

```sh
MAX_DOC_WAIT_MS=60000 CLICK_RETRY_MS=15000 node ./dumper.js
```

## Post-Processing Existing Dumps
note: Usually this step is not needed

Run `datacleanup.js` to normalize saved docket links and rename files/directories based on the current docket HTML:

```sh
node ./datacleanup.js
```

This script scans each subdirectory under `output/`, updates `docket.html`, renames PDFs to `NNN_<docket_text>.pdf`, and may rename the case folder itself.

## Secondary Workflow: Generic Website to PDF
note: Usefull for dumping the Massachusetts Appeals Court website for example
`simplescrape.js` is separate from the MassCourts workflow.

```sh
node ./simplescrape.js
```

The script prompts for a starting URL, loads the page in a headless browser, discovers links, then generates a single PDF in `output/` named like:

```text
simplescrape_<host>_<timestamp>.pdf
```

Defaults:

- includes only same-origin links
- ignores non-HTML assets and common download/media file types
- produces a table-of-contents style PDF with one section per page

Environment variables:

- `INCLUDE_EXTERNAL=1`
  Include cross-origin links.
- `NAV_TIMEOUT_MS`
  Default: `45000`
- `MAX_LINKS`
  Limit the number of discovered links included after the main page.

Windows Command Prompt example:

```bat
set INCLUDE_EXTERNAL=1
set MAX_LINKS=25
node ./simplescrape.js
```

macOS and Linux example:

```sh
INCLUDE_EXTERNAL=1 MAX_LINKS=25 node ./simplescrape.js
```

## Utility Scripts

These scripts are useful for debugging but are not the supported main interface:

- `debug_case.js`: inspect tables and docket-link counts in the attached browser session.
- `debug_links.js`: print sample MassCourts document-link attributes and network requests.
- `test_route.js`: minimal routing test for a CDP-attached session.
- `tmp_fetch.js`: experimental fetch against a specific MassCourts URL using browser cookies.

## Known Constraints

- The main dumper depends on the live MassCourts page structure and current selectors.
- CAPTCHA completion and case navigation are manual; the repo does not automate them.
- `dumper.js` disables TLS certificate validation for its direct-fetch fallback.
- The repo does not currently include automated tests or a productionized CLI.
- Output files may contain sensitive court records. Treat `output/` as sensitive local data.

## Project Spec

The higher-level technical specification lives in [SPEC.md](./SPEC.md).
