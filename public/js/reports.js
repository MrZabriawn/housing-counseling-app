import { db } from './firebase-config.js';
import { requireAuth, setupNav } from './auth.js';
import { MONTHS, AMI_LEVELS, RE_CODES, RE_CODE_LABELS } from './data.js';
import {
  collection, getDocs, query
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// window.docx is loaded via the <script src="…/docx/build/index.js"> tag in reports.html
const {
  Document, Paragraph, Table, TableRow, TableCell, TextRun,
  WidthType, AlignmentType, BorderStyle, Packer
} = window.docx;

let reportData = null; // { unique, rows } for selected month

requireAuth(async (user, profile) => {
  setupNav(profile, 'reports');

  // Populate month select
  const monthSel = document.getElementById('reportMonth');
  MONTHS.forEach(m => {
    const o = document.createElement('option');
    o.value = m; o.textContent = m;
    monthSel.appendChild(o);
  });
  monthSel.value = MONTHS[new Date().getMonth()];
  document.getElementById('reportYear').value = new Date().getFullYear();

  // Set default person completing form
  document.getElementById('r1Person').value = profile.name || '';
  document.getElementById('r2Person').value = profile.name || '';

  // Load on month/year change
  monthSel.addEventListener('change', loadMonth);
  document.getElementById('reportYear').addEventListener('change', loadMonth);

  await loadMonth();

  document.getElementById('downloadR1').addEventListener('click', () => generateReport1());
  document.getElementById('downloadR2').addEventListener('click', () => generateReport2());
});

async function loadMonth() {
  const month = document.getElementById('reportMonth').value;
  const year  = document.getElementById('reportYear').value;
  if (!month || !year) return;

  const dateLabel = `${new Date().toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'})} (for month of ${month} ${year})`;
  document.getElementById('r1Date').value = dateLabel;
  document.getElementById('r2Date').value = dateLabel;

  document.getElementById('reportStatus').textContent = 'Loading data…';
  document.getElementById('downloadR1').disabled = true;
  document.getElementById('downloadR2').disabled = true;

  const snap = await getDocs(query(collection(db, 'counselingLog')));
  let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  rows = rows.filter(r => r.sourceMonth === month);

  // Unique households
  const seen = new Set();
  const unique = rows.filter(r => {
    const key = (r.caseNo || '').trim() || (r.clientName || '').trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  reportData = { unique, rows };

  document.getElementById('reportStatus').textContent =
    `${unique.length} unique households / ${rows.length} sessions for ${month} ${year}.`;

  renderR1Preview(unique);
  renderR2Preview(unique);

  document.getElementById('downloadR1').disabled = false;
  document.getElementById('downloadR2').disabled = false;
  document.getElementById('r1Preview').style.display = 'block';
  document.getElementById('r2Preview').style.display = 'block';
}

// ── Report 1: Income ─────────────────────────────────────────────────────────

function renderR1Preview(unique) {
  const counts = countByField(unique, 'amiPercent', AMI_LEVELS);
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const tbody = document.getElementById('r1PreviewBody');
  tbody.innerHTML = AMI_LEVELS.map(level => `
    <tr>
      <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;text-align:right;">${counts[level] || 0}</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;">${amiReportLabel(level)}</td>
    </tr>`).join('') + `
    <tr>
      <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;text-align:right;font-weight:700;">${total}</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.6rem;font-weight:700;">Total persons served</td>
    </tr>`;
}

function amiReportLabel(level) {
  const map = {
    'Extremely Low':    'Extremely Low (or Very Low)',
    'Low':              'Low',
    'Moderate':         'Moderate (or Low-Moderate)',
    'Non Low-Moderate': 'Non Low-Moderate'
  };
  return map[level] || level;
}

async function generateReport1() {
  const { unique } = reportData;
  const counts = countByField(unique, 'amiPercent', AMI_LEVELS);
  const total  = Object.values(counts).reduce((s, n) => s + n, 0);

  const projectName = document.getElementById('r1ProjectName').value;
  const projectNum  = document.getElementById('r1ProjectNumber').value;
  const dateStr     = document.getElementById('r1Date').value;
  const person      = document.getElementById('r1Person').value;

  const headerRows = [
    ['Project Name:',   projectName],
    ['Project Number:', projectNum],
    ['Date:',           dateStr],
    ['Completed By:',   person],
  ];

  const tableRows = [
    ...AMI_LEVELS.map(level => [String(counts[level] || 0), amiReportLabel(level)]),
    [String(total), 'Total persons served'],
  ];

  const doc = new Document({
    sections: [{
      children: [
        boldParagraph('CDBG Direct Benefit Report Form — Income (Owner Households)'),
        ...headerRows.map(([label, value]) => labelValueParagraph(label, value)),
        new Paragraph({ text: '' }),
        buildTable2Col(['Count', 'AMI Category'], tableRows),
      ]
    }]
  });

  await downloadDocx(doc, `CDBG_Income_Report_${document.getElementById('reportMonth').value}.docx`);
}

// ── Report 2: Race & Ethnicity ────────────────────────────────────────────────

function renderR2Preview(unique) {
  const reCounts = countByField(unique, 'reCode', RE_CODES);
  const total = Object.values(reCounts).reduce((s, n) => s + n, 0);
  const femaleCt = unique.filter(r => r.femaleHeaded).length;

  const tbody = document.getElementById('r2PreviewBody');
  tbody.innerHTML = RE_CODES.map(code => {
    const hispCt = unique.filter(r => r.reCode === code && r.hispanic).length;
    return `<tr>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;">${reCounts[code] || 0}</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;font-size:0.8rem;">${RE_CODE_LABELS[code] || code}</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;">${hispCt}</td>
    </tr>`;
  }).join('') + `
    <tr>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;font-weight:700;">${total}</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;font-weight:700;">Total Households served</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;"></td>
    </tr>
    <tr>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;text-align:right;font-weight:700;">${femaleCt}</td>
      <td style="border:1px solid var(--border);padding:0.35rem 0.5rem;font-weight:700;" colspan="2">Number of Female-Headed Households</td>
    </tr>`;
}

async function generateReport2() {
  const { unique } = reportData;
  const reCounts = countByField(unique, 'reCode', RE_CODES);
  const total    = Object.values(reCounts).reduce((s, n) => s + n, 0);
  const femaleCt = unique.filter(r => r.femaleHeaded).length;

  const projectName = document.getElementById('r2ProjectName').value;
  const projectNum  = document.getElementById('r2ProjectNumber').value;
  const dateStr     = document.getElementById('r2Date').value;
  const person      = document.getElementById('r2Person').value;

  const headerRows = [
    ['Project Name:',   projectName],
    ['Project Number:', projectNum],
    ['Date:',           dateStr],
    ['Completed By:',   person],
  ];

  const tableRows = RE_CODES.map(code => {
    const hispCt = unique.filter(r => r.reCode === code && r.hispanic).length;
    return [String(reCounts[code] || 0), RE_CODE_LABELS[code] || code, String(hispCt)];
  });
  tableRows.push([String(total), 'Total Households served', '']);
  tableRows.push([String(femaleCt), 'Number of Female-Headed Households', '']);

  const doc = new Document({
    sections: [{
      children: [
        boldParagraph('CDBG Direct Benefit Reporting Form — Race & Ethnicity Owner Households'),
        ...headerRows.map(([label, value]) => labelValueParagraph(label, value)),
        new Paragraph({ text: '' }),
        buildTable3Col(['Count', 'Race / Ethnicity', 'Hispanic Count'], tableRows),
      ]
    }]
  });

  await downloadDocx(doc, `CDBG_RaceEthnicity_Report_${document.getElementById('reportMonth').value}.docx`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function countByField(rows, field, orderedKeys) {
  const counts = {};
  orderedKeys.forEach(k => { counts[k] = 0; });
  rows.forEach(r => {
    const k = r[field];
    if (k in counts) counts[k]++;
  });
  return counts;
}

function boldParagraph(text) {
  return new Paragraph({
    children: [new TextRun({ text, bold: true, size: 28 })],
    spacing: { after: 200 }
  });
}

function labelValueParagraph(label, value) {
  return new Paragraph({
    children: [
      new TextRun({ text: label + ' ', bold: true }),
      new TextRun({ text: value }),
    ],
    spacing: { after: 80 }
  });
}

function cellBorder() {
  const b = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
  return { top: b, bottom: b, left: b, right: b };
}

function makeCell(text, bold = false, width) {
  const opts = {
    children: [new Paragraph({
      children: [new TextRun({ text: String(text), bold })],
      alignment: AlignmentType.LEFT,
    })],
    borders: cellBorder(),
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
  };
  if (width) opts.width = { size: width, type: WidthType.DXA };
  return new TableCell(opts);
}

function buildTable2Col(headers, rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: headers.map(h => makeCell(h, true)), tableHeader: true }),
      ...rows.map(([c1, c2]) => new TableRow({ children: [makeCell(c1), makeCell(c2)] })),
    ]
  });
}

function buildTable3Col(headers, rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: headers.map(h => makeCell(h, true)), tableHeader: true }),
      ...rows.map(([c1, c2, c3]) => new TableRow({ children: [makeCell(c1), makeCell(c2), makeCell(c3)] })),
    ]
  });
}

async function downloadDocx(docObj, filename) {
  const blob = await Packer.toBlob(docObj);
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
