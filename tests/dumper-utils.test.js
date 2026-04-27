const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const {
  detectPortal,
  extractCaseMetadata,
  extractDocketEntries,
} = require('../dumper-utils');

test('detects Nevada public case portal pages', () => {
  const portal = detectPortal({
    url: 'https://caseinfo.nvsupremecourt.us/public/caseView.do?csIID=74011',
    title: '92066: Case View',
  });

  assert.equal(portal.id, 'nevada');
});

test('extracts Nevada case metadata from C-Track case pages', () => {
  const dom = new JSDOM(`
    <table class="FormTable">
      <tr class="TableHeading"><td colspan="4">Case Information: 92066</td></tr>
      <tr>
        <td class="label">Short Caption:</td>
        <td>ESTATE OF FRANCISCO PENA VS. CITY OF SPARKS (CIVIL)</td>
        <td class="label">Court:</td>
        <td>Supreme Court</td>
      </tr>
    </table>
  `);

  const metadata = extractCaseMetadata(dom.window.document, { id: 'nevada' });

  assert.deepEqual(metadata, {
    caseId: '92066',
    caseTitle: 'ESTATE OF FRANCISCO PENA VS. CITY OF SPARKS (CIVIL)',
  });
});

test('extracts Nevada docket document links from Docket Entries table', () => {
  const dom = new JSDOM(`
    <table class="FormTable">
      <tr class="TableHeading"><td colspan="5">Docket Entries</td></tr>
      <tr class="TableSubHeading">
        <td>Date</td><td>Type</td><td>Description</td><td>Pending?</td><td>Document</td>
      </tr>
      <tr class="EvenRow">
        <td>02/04/2026</td>
        <td>Notice of Appeal Documents</td>
        <td>Filed Notice of Appeal. Appeal docketed in the Supreme Court this day. (SC)</td>
        <td></td>
        <td><a href="/document/view.do?csIID=74011&amp;onBaseDocumentNumber=26-05587">26-05587</a></td>
      </tr>
      <tr class="OddRow">
        <td>02/25/2026</td>
        <td>Docketing Statement</td>
        <td>Filed Appellant's Docketing Statement (SC)</td>
        <td></td>
        <td><a href="/document/view.do?csIID=74011&amp;onBaseDocumentNumber=26-08833">26-08833</a></td>
      </tr>
    </table>
  `, { url: 'https://caseinfo.nvsupremecourt.us/public/caseView.do?csIID=74011' });

  const entries = extractDocketEntries(dom.window.document, { id: 'nevada' });

  assert.deepEqual(entries, [
    {
      id: null,
      href: 'https://caseinfo.nvsupremecourt.us/document/view.do?csIID=74011&onBaseDocumentNumber=26-05587',
      docNum: '26-05587',
      text: 'Filed_Notice_of_Appeal_Appeal_docketed_in_the_Supreme_Court_this_day',
    },
    {
      id: null,
      href: 'https://caseinfo.nvsupremecourt.us/document/view.do?csIID=74011&onBaseDocumentNumber=26-08833',
      docNum: '26-08833',
      text: 'Filed_Appellant_s_Docketing_Statement_SC',
    },
  ]);
});
