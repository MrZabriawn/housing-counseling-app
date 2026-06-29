/* tmcrf.js — Upload CoreLogic Credco PDF → extract charges → print TMCRF invoice */

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

export function initTmcrf() {
  const fileInput  = document.getElementById('tmcrfFileInput');
  const fileLabel  = document.getElementById('tmcrfFileName');
  const errorDiv   = document.getElementById('tmcrfError');
  const preview    = document.getElementById('tmcrfPreview');
  const genBtn     = document.getElementById('tmcrfGenerateBtn');

  let _records = [];
  let _month   = '';

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    fileLabel.textContent = file.name;
    errorDiv.classList.add('hidden');
    preview.classList.add('hidden');
    fileLabel.style.color = 'var(--text-muted)';

    try {
      fileLabel.textContent = `${file.name} — extracting…`;
      const result = await extractFromPdf(file);
      _records = result.records;
      _month   = result.month;
      renderPreview(_records, _month);
      preview.classList.remove('hidden');
      fileLabel.textContent = file.name;
    } catch (err) {
      errorDiv.textContent = err.message;
      errorDiv.classList.remove('hidden');
      fileLabel.textContent = file.name;
    }
  });

  genBtn.addEventListener('click', () => {
    if (_records.length) printInvoice(_records, _month);
  });
}

// ── PDF Extraction ────────────────────────────────────────────────────────────

async function extractFromPdf(file) {
  if (!window.pdfjsLib) throw new Error('PDF library not loaded — please refresh the page and try again.');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const lines = await extractLines(pdf);
  return parseRecords(lines);
}

async function extractLines(pdf) {
  const allLines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page    = await pdf.getPage(p);
    const content = await page.getTextContent();

    const rows = new Map();
    for (const item of content.items) {
      const s = item.str;
      if (!s.trim()) continue;
      const y = Math.round(item.transform[5]);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ str: s, x: item.transform[4] });
    }

    [...rows.entries()]
      .sort((a, b) => b[0] - a[0])                        // top → bottom
      .forEach(([, items]) => {
        const text = items.sort((a, b) => a.x - b.x).map(i => i.str).join(' ').trim();
        if (text) allLines.push(text);
      });
  }
  return allLines;
}

function parseRecords(lines) {
  // Detect service period → month label
  let month = '';
  for (const line of lines) {
    const m = line.match(/(\d{2})\/\d{2}\/(\d{2})\s*[-–]\s*\d{2}\/\d{2}\/\d{2}/);
    if (m) {
      month = `${MONTH_NAMES[parseInt(m[1]) - 1]} 20${m[2]}`;
      break;
    }
  }

  const startIdx = lines.findIndex(l => l.includes('CURRENT CHARGES DETAIL'));
  if (startIdx === -1)
    throw new Error('Could not find "CURRENT CHARGES DETAIL" section. Make sure you are uploading the CoreLogic Credco monthly statement.');

  let endIdx = lines.findIndex((l, i) => i > startIdx && /GRAND TOTALS/i.test(l));
  if (endIdx === -1) endIdx = lines.length;

  const SKIP = /^(Name\b|Notes\b|Date\b|RefNum|Product|Flag|Charge|Tax|Total\b|CURRENT|Instant Merge|Total for|Page \d|FLAG LIST|\*\s*Surcharge|†\s*Includes?|Account\s+(Num|Name)|Statement\s+(Num|Date))/i;

  const records = [];
  const pending = { name: null, date: null, charge: null };

  for (let i = startIdx + 1; i < endIdx; i++) {
    const line = lines[i];
    if (!line || SKIP.test(line)) continue;

    // Notes line: 7-digit Rx# adjacent to ISO timestamp
    const notesA = line.match(/(\d{7})\s+\d{4}-\d{2}-\d{2}T/);
    const notesB = line.match(/\d{4}-\d{2}-\d{2}T.+?(\d{7})\s*$/);
    const rx = notesA ? notesA[1] : (notesB ? notesB[1] : null);

    if (rx && pending.name && pending.date && pending.charge !== null) {
      records.push(...makeRecords(pending.name, pending.date, pending.charge, rx));
      pending.name = null; pending.date = null; pending.charge = null;
      continue;
    }

    // Name: "LAST, FIRST" or "LAST, FIRST & FIRST2" (all caps with comma)
    if (/^[A-Z][A-Z\-]+(?:\s+[A-Z\-]+)*,\s+[A-Z]/.test(line)) {
      // Strip everything from first date onward so name is clean
      pending.name = line.replace(/\s+\d{2}\/\d{2}\/\d{2}.*$/, '').trim();
    }

    // Date (first occurrence per record)
    if (!pending.date) {
      const dm = line.match(/\b(\d{2}\/\d{2}\/\d{2})\b/);
      if (dm) pending.date = dm[1];
    }

    // Charge: first dollar amount on the line
    if (pending.charge === null) {
      const cm = line.match(/\$(\d+\.\d{2})/);
      if (cm) pending.charge = parseFloat(cm[1]);
    }
  }

  if (!records.length)
    throw new Error('No charge records were found. The PDF may not contain a Current Charges Detail section with data.');

  return { records, month };
}

function makeRecords(nameStr, dateStr, charge, rxNum) {
  const commaIdx = nameStr.indexOf(',');
  if (commaIdx === -1) return [];

  const lastName  = toTitleCase(nameStr.slice(0, commaIdx).trim());
  const firstPart = nameStr.slice(commaIdx + 1).trim();
  const [m, d, y] = dateStr.split('/');
  const date      = `${m}/${d}/20${y}`;

  if (firstPart.includes('&')) {
    const per = (charge / 2).toFixed(2);
    return firstPart.split('&').map(fn => ({
      rxNum, date,
      firstName: toTitleCase(fn.trim()),
      lastName,
      type: 'Couple',
      amount: per
    }));
  }

  return [{ rxNum, date, firstName: toTitleCase(firstPart), lastName, type: 'Single', amount: charge.toFixed(2) }];
}

// ── Preview table ─────────────────────────────────────────────────────────────

function renderPreview(records, month) {
  document.getElementById('tmcrfMonthLabel').textContent  = month || '(month not detected)';
  document.getElementById('tmcrfCountLabel').textContent  = `${records.length} line item${records.length !== 1 ? 's' : ''}`;

  const total = records.reduce((s, r) => s + parseFloat(r.amount), 0);
  document.getElementById('tmcrfTotal').textContent = `$${total.toFixed(2)}`;

  document.getElementById('tmcrfPreviewBody').innerHTML = records.map(r => `<tr>
    <td>${esc(r.rxNum)}</td>
    <td>${esc(r.date)}</td>
    <td>${esc(r.firstName)}</td>
    <td>${esc(r.lastName)}</td>
    <td>${esc(r.type)}</td>
    <td style="text-align:right;">$${esc(r.amount)}</td>
  </tr>`).join('');
}

// ── Invoice print ─────────────────────────────────────────────────────────────

function printInvoice(records, month) {
  const total     = records.reduce((s, r) => s + parseFloat(r.amount), 0);
  const MIN_ROWS  = 30;
  const blankRows = Math.max(0, MIN_ROWS - records.length);
  const logoUrl   = `${window.location.origin}/img/logo.png`;

  const dataRows = records.map(r => `
    <tr>
      <td>${esc(r.rxNum)}</td>
      <td>${esc(r.date)}</td>
      <td>${esc(r.firstName)}</td>
      <td>${esc(r.lastName)}</td>
      <td>${esc(r.type)}</td>
      <td>$${esc(r.amount)}</td>
    </tr>`).join('');

  const emptyRows = `<tr><td></td><td></td><td></td><td></td><td></td><td></td></tr>`.repeat(blankRows);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>TMCRF Invoice — ${esc(month)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 10.5pt; color: #000; padding: 0.5in; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.25in; }
  .agency p { line-height: 1.55; font-size: 10pt; }
  .agency .label { font-weight: bold; font-size: 10.5pt; margin-top: 2px; }
  .logo img { max-height: 1.1in; }
  table { width: 100%; border-collapse: collapse; }
  th, td {
    border: 1px solid #000; padding: 3px 6px; font-size: 9.5pt;
    vertical-align: middle;
  }
  th { background: #f0f0f0; font-weight: bold; white-space: nowrap; }
  td:first-child { text-align: center; }
  td:last-child  { text-align: right; }
  th:first-child { text-align: center; }
  th:last-child  { text-align: right; }
  tr.data-row td { height: 18px; }
  tr.blank-row td { height: 16px; }
  tr.total-row td {
    font-weight: bold; border-top: 2px solid #000; padding: 4px 6px;
  }
  .footer { margin-top: 0.3in; }
  .sig-block { display: inline-block; }
  .sig-line { border-top: 1px solid #000; width: 2.8in; margin-top: 0.35in; }
  .sig-label { font-size: 9.5pt; margin-top: 3px; }
  .date-line { margin-top: 0.18in; font-size: 9.5pt; }
  .footnote { margin-top: 0.15in; font-size: 8.5pt; color: #444; }
  .print-btn {
    display: block; margin: 0.25in auto 0; padding: 8px 24px;
    font-size: 11pt; cursor: pointer; background: #1a5276; color: #fff;
    border: none; border-radius: 4px;
  }
  @media print {
    .print-btn { display: none; }
    body { padding: 0.4in; }
  }
</style>
</head>
<body>
<div class="header">
  <div class="agency">
    <p>Housing Opportunities Inc.</p>
    <p>293 Pinney Street</p>
    <p>Rochester, PA 15074</p>
    <p class="label">Credit Report Reimbursement</p>
    <p>Month: ${esc(month)}</p>
  </div>
  <div class="logo">
    <img src="${logoUrl}" alt="Housing Opportunities" onerror="this.style.display='none'">
  </div>
</div>

<table>
  <thead>
    <tr>
      <th>RX #</th>
      <th>DATE</th>
      <th>First Name</th>
      <th>Last Name</th>
      <th>Type of Report *</th>
      <th>Amount</th>
    </tr>
  </thead>
  <tbody>
    ${dataRows.replace(/<tr>/g, '<tr class="data-row">')}
    ${emptyRows.replace(/<tr>/g, '<tr class="blank-row">')}
    <tr class="total-row">
      <td colspan="5" style="text-align:right;">Total</td>
      <td>$${total.toFixed(2)}</td>
    </tr>
  </tbody>
</table>

<div class="footer">
  <div class="sig-block">
    <div class="sig-line"></div>
    <div class="sig-label">Executive Director</div>
  </div>
  <div class="date-line">Date _______________</div>
</div>

<p class="footnote">* Single / Couple</p>

<button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) {
    alert('Pop-up blocked. Please allow pop-ups for this site and try again.');
    return;
  }
  win.document.write(html);
  win.document.close();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toTitleCase(str) {
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
