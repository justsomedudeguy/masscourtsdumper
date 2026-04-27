# masscourtdumper Specification

This document is both a human-facing project specification and durable agent-facing context. It complements `README.md`, which is the quickstart and operator guide.

- `README.md` explains how to install and run the tools.
- `SPEC.md` records intended behavior, boundaries, risks, and future work.
- Source files remain the final authority for implementation details. Update this spec when behavior, commands, output shape, or supported scripts change.

Requirement language:

- **must** means required for the supported workflow.
- **should** means intended behavior, with room for best-effort handling around MassCourts variability.
- **may** means optional behavior, fallback behavior, or debug output.

## 1. Purpose

`masscourtdumper` exports docket HTML and linked PDFs from a supported court case page that the operator has already opened in a browser. It currently supports Massachusetts Trial Court MassCourts pages and Nevada Appellate Courts Case View pages.

The dumper attaches to an existing Chromium-based browser session over CDP. It does not automate CAPTCHA completion, court-portal search, case navigation, account login, or access-control bypasses.

Public MassCourts search does not require a normal authenticated account session for this workflow, except for attorney access. The operator must manually pass the initial CAPTCHA and navigate to the specific `Case Details` page before running the dumper.

## 2. Supported Surface

| Workflow | Script | Status | Inputs | Outputs |
| --- | --- | --- | --- | --- |
| Supported case dump | `dumper.js` | Primary workflow | Chromium at `http://localhost:9222`, completed CAPTCHA/manual navigation when required, open MassCourts `Case Details` or Nevada `Case View` tab | `output/<case-id>-<case-title>/docket.html`, one PDF per downloadable docket entry, optional `stub_*.html` or `stub_*.xml` debug artifacts |
| Dump cleanup / normalization | `datacleanup.js` | Post-processing utility | Existing case folders under `output/` with `docket.html` | Patched local docket links, normalized PDF names, optional case-folder rename |
| Generic site-to-PDF snapshot | `simplescrape.js` | Separate utility | User-supplied starting URL | One combined PDF under `output/` |

The remaining scripts are ad hoc debugging helpers, not supported interfaces:

- `debug_case.js`
- `debug_links.js`
- `test_route.js`
- `tmp_fetch.js`
- `test_pw.js`

## 3. Non-Goals

- Automated CAPTCHA completion
- Automated MassCourts case search or case navigation
- MassCourts account/session management
- Bypassing document restrictions or access controls
- Distributed scraping or queue orchestration
- Cross-platform packaging or installer support
- Stable API guarantees for helper/debug scripts
- Comprehensive test coverage

## 4. Assumptions and Dependencies

- The operator can access the target MassCourts case through public search or another permitted MassCourts path.
- The operator manually completes the initial CAPTCHA and opens the target `Case Details` page before running the dumper.
- The browser is Chromium-compatible and was launched with remote debugging enabled on `http://localhost:9222`.
- The site remains sufficiently similar to the current selectors and dialog behavior.
- The runtime is Node.js 20+ or another modern Node.js version compatible with `patchright` and `jsdom@27`.
- Local filesystem storage is available for potentially large PDF batches.
- The operator accepts the security tradeoff of direct PDF refetches with disabled TLS validation fallback.

The Node.js scripts are intended to be operating-system agnostic. The OS-specific part is how the operator launches a Chromium-based browser with the remote debugging flag.

## 5. Supported Case Dump Functional Spec

### 5.1 Browser Attachment

`dumper.js` must:

- connect to `http://localhost:9222` over CDP
- fail fast if the browser cannot be reached
- inspect existing contexts and pages
- avoid launching its own CAPTCHA, search, login, or navigation flow

### 5.2 Target Page Discovery

The dumper should select the best available supported case page by:

- preferring a URL containing both `CaseDetails` and `masscourts.org`
- accepting Nevada Appellate Courts URLs containing `caseinfo.nvsupremecourt.us/public/caseView.do`
- falling back to page-title heuristics for supported portals
- rejecting CAPTCHA, search, login, and expired-session pages

If no usable supported case tab is open, the dumper should stop with an operator-actionable error.

### 5.3 Case Metadata Extraction

The dumper should derive:

- `caseId`
- `caseTitle`
- `outputDir = output/<caseId>-<sanitized title>`

If extraction fails, the dumper should still create a usable fallback folder name.

### 5.4 Docket Table Discovery

For MassCourts, the dumper should:

- scan page tables
- identify the docket table by headers containing `docket text` and an image column
- enumerate only rows containing `a.dktImage`

For Nevada, the dumper should:

- identify the `table.FormTable` headed `Docket Entries`
- enumerate rows with `document/view.do` links in the `Document` column
- use the document link text, such as `26-05587`, as the document number

For each document row, it should compute:

- a document number from `file ref nbr.`, `ref nbr`, or similar docket-reference headers when present
- a row-index fallback when no document number is available
- a sanitized text fragment from the docket text column
- a target filename in the form `NNN_<text>.pdf`

### 5.5 PDF Capture Pipeline

MassCourts may expose documents through several delivery paths. The dumper should preserve multiple capture mechanisms, even if their order changes:

1. request routing / interception
2. page download events
3. network response listeners
4. popup listeners
5. refetching the last known PDF URL using browser-session cookies
6. extracting PDF targets from HTML wrappers or Wicket XML responses

Nevada exposes public docket documents as direct `document/view.do` links. The dumper should fetch those links with the headed browser session cookies and verify the resulting buffer begins with `%PDF-`.

Success criteria:

- a non-trivial buffer is captured
- the buffer begins with `%PDF-`

Failure criteria:

- timeout expires
- a modal error dialog indicates no document, restriction, or related failure
- a retrieved buffer is not a PDF and cannot be recovered through fallback refetch

### 5.6 Resumability

If the target filename already exists, the dumper should skip that docket item and continue.

Skipped files should still be treated as known local outputs for later docket-link rewriting when possible.

### 5.7 Local Docket Rewriting

After successful downloads, the dumper should patch the saved docket HTML so downloaded entries:

- point to the local filename via `href`
- no longer rely on `onclick`
- open as normal local links

The saved `docket.html` should remain a usable local entry point for the dumped case.

### 5.8 Completion Behavior

At the end of a run, the dumper reports how many documents were successfully processed.

## 6. Cleanup Functional Spec

`datacleanup.js` should:

- iterate subdirectories under `output/`
- ignore folders without `docket.html`
- parse docket HTML with `jsdom`
- rediscover docket rows and document metadata
- rewrite local docket links
- rename PDFs when a better normalized name is available
- rename the containing folder when the docket title implies a better canonical directory name

The cleanup utility should use structured DOM parsing rather than broad string replacement.

## 7. Simple Scrape Functional Spec

`simplescrape.js` is separate from the MassCourts workflow. It should:

- prompt for a starting URL
- normalize bare host input into `https://...` when possible
- load the main page in a headless browser
- extract HTML links
- optionally restrict discovered links to the same origin
- exclude common non-HTML file types
- normalize fetched HTML for static embedding by removing scripts, styles, base tags, and refresh behavior
- rewrite relative URLs to absolute URLs
- generate one combined HTML document with a table of contents
- print the combined result to a single PDF in `output/`

## 8. Configuration Surface

| Script | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `dumper.js` | `MAX_DOC_WAIT_MS` | `40000` | Maximum time to wait for a document before timing out |
| `dumper.js` | `CLICK_RETRY_MS` | `20000` | Time before re-clicking a docket item while waiting |
| `dumper.js` | `WAIT_BETWEEN_DOCS_MS` | `0` | Optional delay between document attempts |
| `dumper.js` | `PDF_POLL_MS` | `200` | Poll interval while waiting for a captured PDF buffer |
| `simplescrape.js` | `INCLUDE_EXTERNAL` | unset / same-origin only | Set to `1` to include cross-origin links |
| `simplescrape.js` | `NAV_TIMEOUT_MS` | `45000` | Navigation timeout for page loads |
| `simplescrape.js` | `MAX_LINKS` | unset / unlimited | Maximum number of discovered links included after the main page |

## 9. Operational Risks

- Selector drift in the MassCourts UI can break docket discovery.
- Manual CAPTCHA completion and case navigation remain required.
- Alternate document delivery flows may bypass one or more capture paths.
- `dumper.js` disables TLS certificate validation for its direct-fetch fallback.
- Stored output may contain sensitive legal material; treat `output/` as sensitive local data.
- The tool does not decide whether a record may be downloaded, retained, shared, or filed elsewhere.
- The repo does not currently include automated tests beyond the placeholder `npm test` script.
- `test_pw.js` imports `playwright`, which is not declared in `package.json`.

## 10. Future Improvements

- Add optional helper scripts or clearer examples for launching Chromium-based browsers with remote debugging.
- Replace global TLS-disable behavior with narrower certificate handling.
- Add a supported CLI with explicit commands and help output.
- Separate production scripts from ad hoc debug utilities.
- Add fixture-based tests around docket parsing and HTML patching.
- Add structured logging and per-document result manifests.
- Add a dry-run mode for page discovery and docket enumeration only.

## 11. Maintenance Notes

When future agents or maintainers change behavior:

- keep `README.md` and `SPEC.md` consistent
- keep operator quickstart material in `README.md`
- keep behavioral contracts, risks, and source boundaries in `SPEC.md`
- do not promote debug helpers to supported workflows unless the README and spec both say so
- verify script names, environment variables, output paths, and dependency claims against the source before updating docs
