const PORTALS = {
  masscourts: {
    id: 'masscourts',
    label: 'MassCourts',
    documentMode: 'click',
  },
  nevada: {
    id: 'nevada',
    label: 'Nevada Appellate Courts',
    documentMode: 'direct',
  },
};

function portal(id) {
  return { ...PORTALS[id] };
}

function detectPortal({ url = '', title = '' } = {}) {
  const lowerUrl = String(url).toLowerCase();
  const lowerTitle = String(title).toLowerCase();

  if (
    lowerUrl.includes('caseinfo.nvsupremecourt.us') &&
    (lowerUrl.includes('/public/caseview.do') || lowerTitle.includes('case view'))
  ) {
    return portal('nevada');
  }

  if (
    lowerUrl.includes('masscourts.org') &&
    (
      lowerUrl.includes('casedetails') ||
      lowerTitle.includes('case details') ||
      lowerTitle.includes('massachusetts trial court')
    )
  ) {
    return portal('masscourts');
  }

  if (lowerUrl.includes('masscourts.org') && !lowerUrl.includes('login')) {
    return portal('masscourts');
  }

  return null;
}

function textOf(el) {
  return (el?.innerText || el?.textContent || '').replace(/\u00a0/g, ' ').trim();
}

function sanitizeCaseTitle(value) {
  return String(value || '')
    .replace(/[^a-z0-9, vs. ]/gi, '')
    .substring(0, 50)
    .trim();
}

function sanitizeDocketText(value, portalId) {
  const text = String(value || '').trim().substring(0, 70);
  if (!text) return 'NoText';

  const sanitized = text.replace(/[^a-z0-9]/gi, '_');
  if (portalId === 'masscourts') return sanitized || 'NoText';

  return sanitized.replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'NoText';
}

function extractCaseMetadata(document, portalConfig) {
  if (portalConfig?.id === 'nevada') return extractNevadaCaseMetadata(document);
  return extractMassCourtsCaseMetadata(document);
}

function extractMassCourtsCaseMetadata(document) {
  let titleEl =
    document.querySelector('li.displayData') ||
    document.querySelector('.case-header-info') ||
    document.querySelector('h1 .displayData');

  if (!titleEl) {
    const h1s = Array.from(document.querySelectorAll('h1'));
    titleEl = h1s.find(h => {
      const text = textOf(h);
      return text.length > 5 && !text.includes('N2') && !text.includes('N5');
    });
  }

  const fullText = textOf(titleEl);
  const match = fullText.match(/^([A-Z0-9-]+)\b\s*[-]?[ \t]*(.*)$/i);
  if (match) {
    return { caseId: match[1], caseTitle: match[2]?.trim() || fullText };
  }

  return { caseId: 'case_dump', caseTitle: fullText || 'Unknown' };
}

function extractNevadaCaseMetadata(document) {
  const heading = Array.from(document.querySelectorAll('tr.TableHeading td, tr.TableHeading th'))
    .map(textOf)
    .find(text => /^Case Information:/i.test(text));

  const caseId = heading?.match(/^Case Information:\s*(.+)$/i)?.[1]?.trim() || 'case_dump';
  const captionLabel = Array.from(document.querySelectorAll('td.label, th.label'))
    .find(cell => /^Short Caption:/i.test(textOf(cell)));
  const caseTitle = textOf(captionLabel?.nextElementSibling) || 'Unknown';

  return { caseId, caseTitle };
}

function extractDocketEntries(document, portalConfig) {
  if (portalConfig?.id === 'nevada') return extractNevadaDocketEntries(document);
  return extractMassCourtsDocketEntries(document);
}

function extractMassCourtsDocketEntries(document) {
  const tables = Array.from(document.querySelectorAll('table'));
  const docketTable = tables.find(t => {
    const headers = Array.from(t.querySelectorAll('th')).map(th => textOf(th).toLowerCase());
    return headers.some(h => h.includes('docket text')) && headers.some(h => h.includes('image'));
  });

  if (!docketTable) throw new Error('Docket table not found.');

  const headers = Array.from(docketTable.querySelectorAll('th')).map(th => textOf(th).toLowerCase());
  const textIdx = headers.findIndex(h => h.includes('docket text'));
  const refIdx = headers.findIndex(h => h.includes('ref nbr') || h.includes('ref #'));

  return Array.from(docketTable.querySelectorAll('tbody tr'))
    .map((row, index) => {
      const imgLink = row.querySelector('a.dktImage');
      if (!imgLink) return null;

      const cells = Array.from(row.querySelectorAll('td'));
      let docNumStr = refIdx !== -1 ? textOf(cells[refIdx]) : '';
      if (!docNumStr || Number.isNaN(parseInt(docNumStr, 10))) docNumStr = (index + 1).toString();

      return {
        id: imgLink.id || null,
        href: imgLink.href || null,
        docNum: docNumStr.padStart(3, '0'),
        text: sanitizeDocketText(textOf(cells[textIdx]), 'masscourts'),
      };
    })
    .filter(Boolean);
}

function extractNevadaDocketEntries(document) {
  const tables = Array.from(document.querySelectorAll('table'));
  const docketTable = tables.find(table => {
    if (!table.classList.contains('FormTable')) return false;
    const headingRow = directTableRows(table).find(row => row.classList.contains('TableHeading'));
    return /^Docket Entries$/i.test(textOf(headingRow));
  });

  if (!docketTable) throw new Error('Docket table not found.');

  const rows = directTableRows(docketTable);
  const headerRow = rows.find(row => {
    const labels = Array.from(row.children).map(cell => textOf(cell).toLowerCase());
    return labels.some(label => label.includes('description')) && labels.some(label => label.includes('document'));
  });

  if (!headerRow) throw new Error('Docket table header row not found.');

  const headers = Array.from(headerRow.children).map(cell => textOf(cell).toLowerCase());
  const descriptionIdx = headers.findIndex(label => label.includes('description'));
  const documentIdx = headers.findIndex(label => label.includes('document'));
  const baseUrl = document.URL || 'https://caseinfo.nvsupremecourt.us/';
  const entries = [];

  for (const row of rows.slice(rows.indexOf(headerRow) + 1)) {
    const cells = Array.from(row.children);
    const documentCell = cells[documentIdx] || row;
    const description = textOf(cells[descriptionIdx]);
    const links = Array.from(documentCell.querySelectorAll('a[href*="document/view.do"], a[href*="/document/view.do"]'));

    for (const link of links) {
      const rawHref = link.getAttribute('href') || '';
      if (!rawHref) continue;

      const href = new URL(rawHref, baseUrl).toString();
      const url = new URL(href);
      const docNum = textOf(link) || url.searchParams.get('onBaseDocumentNumber') || String(entries.length + 1).padStart(3, '0');

      entries.push({
        id: link.id || null,
        href,
        docNum,
        text: sanitizeDocketText(description || docNum, 'nevada'),
      });
    }
  }

  return entries;
}

function directTableRows(table) {
  const bodies = Array.from(table.tBodies || []);
  if (bodies.length) {
    return bodies.flatMap(body => Array.from(body.children).filter(child => child.tagName === 'TR'));
  }
  return Array.from(table.children).filter(child => child.tagName === 'TR');
}

module.exports = {
  detectPortal,
  extractCaseMetadata,
  extractDocketEntries,
  sanitizeCaseTitle,
  sanitizeDocketText,
};
