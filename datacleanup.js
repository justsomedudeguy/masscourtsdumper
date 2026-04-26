const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const outputDir = path.join(__dirname, 'output');

async function cleanup() {
    if (!fs.existsSync(outputDir)) {
        console.log('No output directory found.');
        return;
    }

    const folders = fs.readdirSync(outputDir).filter(f => fs.statSync(path.join(outputDir, f)).isDirectory());

    for (const folder of folders) {
        console.log(`Checking folder: ${folder}`);
        const folderPath = path.join(outputDir, folder);
        const docketPath = path.join(folderPath, 'docket.html');

        if (!fs.existsSync(docketPath)) {
            console.log(`  No docket.html found in ${folder}, skipping.`);
            continue;
        }

        const html = fs.readFileSync(docketPath, 'utf8');
        const dom = new JSDOM(html);
        const document = dom.window.document;

        // 1. Determine Correct Directory Name
        const titleEl = document.querySelector('li.displayData');
        const fullText = titleEl ? titleEl.textContent.trim() : '';
        const match = fullText.match(/^([A-Z0-9-]+)\s*(.*)$/i);
        let caseId = 'Unknown';
        let caseTitle = fullText;

        if (match) {
            caseId = match[1];
            caseTitle = match[2]?.trim() || fullText;
        }

        const safeTitle = caseTitle.replace(/[^a-z0-9, vs. ]/gi, '').substring(0, 100);
        const targetDirName = `${caseId}-${safeTitle}`;

        // 2. DYNAMIC DOCKET TABLE DETECTION
        const tables = Array.from(document.querySelectorAll('table'));
        const docketTable = tables.find(t => {
            const headers = Array.from(t.querySelectorAll('th')).map(th => th.textContent.toLowerCase());
            return headers.includes('docket text') && (headers.includes('image avail.') || headers.includes('image'));
        });

        if (!docketTable) {
            console.log(`  Could not identify docket table in ${folder}.`);
            continue;
        }

        const headers = Array.from(docketTable.querySelectorAll('th')).map(th => th.textContent.toLowerCase().trim());
        const textIdx = headers.indexOf('docket text');
        const refIdx = headers.indexOf('file ref nbr.');
        const imgIdx = headers.findIndex(h => h.includes('image'));

        const rows = Array.from(docketTable.querySelectorAll('tbody tr'));
        const linkMap = {};

        rows.forEach((row, index) => {
            const imgLink = row.querySelector('a.dktImage');
            if (imgLink) {
                const cells = Array.from(row.querySelectorAll('td'));

                // Smart Numbering
                let docNumStr = '';
                if (refIdx !== -1) {
                    docNumStr = cells[refIdx]?.textContent?.trim() || '';
                }
                if (!docNumStr || isNaN(parseInt(docNumStr))) {
                    docNumStr = (index + 1).toString();
                }
                const docNum = docNumStr.padStart(3, '0');

                const textStr = cells[textIdx]?.textContent?.trim().substring(0, 70).replace(/[^a-z0-9]/gi, '_') || 'NoText';
                const newFileName = `${docNum}_${textStr}.pdf`;

                const currentHref = imgLink.getAttribute('href');
                linkMap[currentHref] = newFileName;

                imgLink.setAttribute('href', newFileName);
                imgLink.removeAttribute('onclick');
                imgLink.style.fontWeight = 'bold';
                imgLink.style.color = '#0066cc';
            }
        });

        // 3. Rename existing PDF files in the folder
        const filesInFolder = fs.readdirSync(folderPath);
        filesInFolder.forEach(file => {
            // We match against both the old potential href and the filename itself
            const targetFilename = linkMap[file] || Object.values(linkMap).find(v => v === file);
            if (file.endsWith('.pdf') && targetFilename && file !== targetFilename) {
                const oldPath = path.join(folderPath, file);
                const newPath = path.join(folderPath, targetFilename);
                console.log(`  Renaming file: ${file} -> ${targetFilename}`);
                if (fs.existsSync(oldPath)) {
                    fs.renameSync(oldPath, newPath);
                }
            }
        });

        // 4. Save the corrected docket.html
        fs.writeFileSync(docketPath, dom.serialize());
        console.log(`  Updated docket.html.`);

        // 5. Rename the directory if needed
        if (folder !== targetDirName) {
            const newFolderPath = path.join(outputDir, targetDirName);
            if (!fs.existsSync(newFolderPath)) {
                console.log(`  Renaming directory: ${folder} -> ${targetDirName}`);
                try {
                    fs.renameSync(folderPath, newFolderPath);
                } catch (e) {
                    console.error(`  Failed to rename directory: ${e.message}`);
                }
            }
        }
    }

    console.log('Cleanup finished.');
}

cleanup();
