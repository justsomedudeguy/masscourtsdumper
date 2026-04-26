# masscourtdumper Specification

## 1. Purpose

Provide a practical, operator-driven way to export docket HTML and linked PDFs from a live Massachusetts Trial Court `masscourts.org` case page, using an already authenticated browser session instead of reimplementing login or site state.

## 2. Supported Workflows

### 2.1 MassCourts Case Dump

Implemented by `dumper.js`.

Inputs:

- An existing Chromium-compatible browser listening on `http://localhost:9222`
- A logged-in MassCourts session
- An open `Case Details` tab

Outputs:

- `output\<case-id>-<case-title>\docket.html`
- One local PDF per downloadable docket entry
- Optional debug stubs for intercepted HTML/XML wrappers

### 2.2 Dump Cleanup / Normalization

Implemented by `datacleanup.js`.

Inputs:

- Existing case folders under `output\`
- A previously saved `docket.html` in each case folder

Outputs:

- Renamed PDFs based on docket metadata
- Patched local links in `docket.html`
- Optionally renamed case directories

### 2.3 Generic Site-to-PDF Snapshot

Implemented by `simplescrape.js`.

Inputs:

- A user-supplied starting URL

Outputs:

- A single PDF containing the main page plus discovered links

## 3. Non-Goals

- Automated MassCourts login
- Account/session management
- Distributed scraping or queue orchestration
- Cross-platform packaging or installer support
- Stable API guarantees for helper/debug scripts
- Comprehensive test coverage

## 4. System Assumptions

- The target MassCourts session is manually authenticated by the operator.
- The site remains sufficiently similar to the current selectors and dialog behavior.
- The runtime has a modern Node.js version compatible with both `patchright` and `jsdom`.
- Local filesystem storage is available for potentially large PDF batches.
- The operator accepts the security tradeoff of direct PDF refetches with disabled TLS validation fallback.

## 5. MassCourts Dump Functional Spec

### 5.1 Browser Attachment

`dumper.js` must:

- connect to `http://localhost:9222` over CDP
- fail fast if the browser cannot be reached
- inspect existing contexts and pages rather than launching its own login flow

### 5.2 Target Page Discovery

The dumper should select the best available MassCourts page by:

- preferring a URL containing `CaseDetails` and `masscourts.org`
- falling back to page-title heuristics
- rejecting login or expired-session pages

### 5.3 Case Metadata Extraction

The dumper should derive:

- `caseId`
- `caseTitle`
- `outputDir = output\<caseId>-<sanitized title>`

If extraction fails, it should still create a usable fallback folder name.

### 5.4 Docket Table Discovery

The dumper should:

- scan page tables
- identify the docket table by headers containing `docket text` and an `image` column
- enumerate only rows containing `a.dktImage`

For each row, it should compute:

- a document number from `file ref nbr.` when present, otherwise row index
- a sanitized text fragment from the docket text column
- a target filename in the form `NNN_<text>.pdf`

### 5.5 PDF Capture Pipeline

Because MassCourts may expose documents through several delivery paths, the dumper should attempt multiple mechanisms:

1. request routing / interception
2. page download events
3. network response listeners
4. popup listeners
5. refetching the last known PDF URL using session cookies
6. extracting PDF targets from HTML wrappers or Wicket XML responses

Success criteria:

- a non-trivial buffer is captured
- the buffer begins with `%PDF-`

Failure criteria:

- timeout expires
- a modal error dialog indicates no document, restriction, or related failure
- a retrieved buffer is not a PDF and cannot be recovered through fallback refetch

### 5.6 Resumability

If the target filename already exists, the dumper should skip that docket item and continue.

### 5.7 Local Docket Rewriting

After each successful download, the dumper should patch the saved docket HTML so that downloaded entries:

- point to the local filename via `href`
- no longer rely on `onclick`
- open as normal local links

### 5.8 Completion Behavior

At the end of a run, the dumper reports how many documents were successfully processed.

## 6. Cleanup Functional Spec

`datacleanup.js` should:

- iterate subdirectories under `output\`
- ignore folders without `docket.html`
- parse the docket HTML with `jsdom`
- rediscover docket rows and document metadata
- rewrite local docket links
- rename PDFs when a better normalized name is available
- rename the containing folder when the docket title implies a better canonical directory name

## 7. Simple Scrape Functional Spec

`simplescrape.js` should:

- prompt for a starting URL
- normalize bare host input into `https://...` when possible
- load the main page in a headless browser
- extract HTML links
- optionally restrict to same-origin links
- exclude common non-HTML file types
- normalize fetched HTML for static embedding by removing scripts/styles/refresh behavior
- rewrite relative URLs to absolute URLs
- generate one combined HTML document with a table of contents
- print the combined result to a single PDF in `output\`

## 8. Configuration Surface

### 8.1 `dumper.js`

- `MAX_DOC_WAIT_MS` default `40000`
- `CLICK_RETRY_MS` default `20000`
- `WAIT_BETWEEN_DOCS_MS` default `0`
- `PDF_POLL_MS` default `200`

### 8.2 `simplescrape.js`

- `INCLUDE_EXTERNAL`
- `NAV_TIMEOUT_MS` default `45000`
- `MAX_LINKS`

## 9. Operational Risks

- Selector drift in the MassCourts UI can break docket discovery.
- Alternate document delivery flows may bypass one or more capture paths.
- Disabling TLS validation for direct refetch is a security risk.
- Stored output may contain personally sensitive legal material.
- `launch_chrome.ps1` is environment-specific and may not work unchanged on another machine.
- `test_pw.js` is out of sync with declared dependencies.

## 10. Future Improvements

- Replace hard-coded browser paths with configuration.
- Add a supported CLI with explicit commands and help output.
- Separate production scripts from ad hoc debug utilities.
- Add fixture-based tests around docket parsing and HTML patching.
- Add structured logging and per-document result manifests.
- Add a dry-run mode for page discovery and docket enumeration only.
