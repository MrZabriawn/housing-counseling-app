// CHCI billing — parse Rx Office reports and generate PHFA invoice Excel files

const _parsed = { f2f: null, md: null, dd: null };

export function initChciReports() {
  document.getElementById('f2fUpload').addEventListener('change', e => handleUpload('f2f', e));
  document.getElementById('mdUpload').addEventListener('change',  e => handleUpload('md',  e));
  document.getElementById('ddUpload').addEventListener('change',  e => handleUpload('dd',  e));
  document.getElementById('generateChciBtn').addEventListener('click', generateAll);
}

// ── Parse uploaded report ─────────────────────────────────────────────────────

async function handleUpload(type, e) {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById(`${type}Status`);
  statusEl.textContent = 'Parsing…';

  try {
    const buf = await file.arrayBuffer();
    const wb  = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];

    const rows = extractRows(ws, type);
    _parsed[type] = rows;
    showPreview(type, rows);
    statusEl.textContent = `${rows.length} session${rows.length !== 1 ? 's' : ''} loaded`;
    statusEl.style.color = 'var(--primary)';
  } catch (err) {
    statusEl.textContent = 'Parse failed: ' + err.message;
    statusEl.style.color = 'var(--danger)';
  }

  updateGenerateBtn();
}

function extractRows(ws, type) {
  // Build header → 0-based column index map from row 1
  const hdrMap = {};
  ws.getRow(1).eachCell((cell, col) => {
    if (cell.value != null) hdrMap[String(cell.value).trim()] = col - 1;
  });

  const rows = [];

  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) return;

    // Read all cell values into a 0-based array
    const vals = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      vals[col - 1] = cell.value;
    });

    const col = (name) => vals[hdrMap[name] ?? hdrMap[name + ' '] ?? -1];

    const date           = col('Date');
    const caseNo         = col('Case No.') ?? col('Case No. ');
    const lastName       = col('Last Name');
    const firstName      = col('First Name');
    const caseStatus     = col('Case Status');
    const counselingType = col('Counseling Type');
    const duration       = col('Duration(min)');

    if (!date || !caseNo || !lastName) return;

    rows.push({
      date,
      caseNo:         String(Math.round(parseFloat(caseNo))),
      lastName:       String(lastName ?? ''),
      firstName:      String(firstName ?? ''),
      caseStatus:     String(caseStatus ?? ''),
      counselingType: String(counselingType ?? ''),
      duration:       parseFloat(duration) || 0,
    });
  });

  rows.sort((a, b) => toDate(a.date) - toDate(b.date));
  return rows;
}

function toDate(val) {
  if (!val) return 0;
  if (val instanceof Date) return val.getTime();
  if (typeof val === 'string') {
    const [m, d, y] = val.split('/');
    return new Date(+y, +m - 1, +d).getTime();
  }
  return new Date(val).getTime();
}

function fmtDate(val) {
  const d = new Date(toDate(val));
  if (isNaN(d)) return '';
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

// ── Preview table ─────────────────────────────────────────────────────────────

function showPreview(type, rows) {
  const el = document.getElementById(`${type}Preview`);
  if (!rows.length) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;">No data rows found.</p>';
    return;
  }

  const th = (t, align = '') =>
    `<th style="border:1px solid var(--border);padding:0.3rem 0.4rem;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);${align ? `text-align:${align};` : ''}">${t}</th>`;
  const td = (v, align = '') =>
    `<td style="border:1px solid var(--border);padding:0.25rem 0.5rem;font-size:0.8125rem;${align ? `text-align:${align};` : ''}">${v ?? ''}</td>`;

  let totalMin = 0, totalAmt = 0;
  const bodyRows = rows.map(r => {
    const amt = Math.round(r.duration / 60 * 100);
    totalMin += r.duration;
    totalAmt += amt;
    return `<tr>
      ${td(fmtDate(r.date))}
      ${td(r.caseNo)}
      ${td(r.lastName)}
      ${td(r.firstName)}
      ${td(r.caseStatus)}
      ${td(r.counselingType)}
      ${td(r.duration, 'right')}
      ${td('$' + amt, 'right')}
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div style="overflow-x:auto;">
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#f8f9fb;">
        ${th('Date')}${th('Case #')}${th('Last Name')}${th('First Name')}
        ${th('Case Status')}${th('Counseling Type')}${th('Min','right')}${th('Amt','right')}
      </tr></thead>
      <tbody>${bodyRows}</tbody>
      <tfoot>
        <tr style="background:#e8f0fe;font-weight:700;">
          <td colspan="6" style="border:1px solid var(--border);padding:0.28rem 0.5rem;font-size:0.8125rem;">Total — ${rows.length} session${rows.length !== 1 ? 's' : ''}</td>
          <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;text-align:right;font-size:0.8125rem;">${totalMin}</td>
          <td style="border:1px solid var(--border);padding:0.28rem 0.5rem;text-align:right;font-size:0.8125rem;">$${totalAmt}</td>
        </tr>
      </tfoot>
    </table>
    </div>`;
}

function updateGenerateBtn() {
  const btn = document.getElementById('generateChciBtn');
  btn.disabled = !Object.values(_parsed).some(v => v && v.length > 0);
}

// ── Generate invoices ─────────────────────────────────────────────────────────

async function generateAll() {
  const btn = document.getElementById('generateChciBtn');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    const configs = [
      { key: 'f2f', tag: 'Face-to-Face', typeLabel: 'F2F' },
      { key: 'md',  tag: 'M&D',          typeLabel: 'M&D' },
      { key: 'dd',  tag: 'D&D',          typeLabel: 'D&D' },
    ];
    for (const cfg of configs) {
      const rows = _parsed[cfg.key];
      if (rows && rows.length) await generateInvoice(rows, cfg);
    }
  } catch (err) {
    alert('Generation failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Invoices';
    updateGenerateBtn();
  }
}

async function generateInvoice(rows, { key, tag, typeLabel }) {
  const wb = new ExcelJS.Workbook();

  const firstDate  = new Date(toDate(rows[0].date));
  const monthName  = firstDate.toLocaleString('en-US', { month: 'long' });
  const year       = firstDate.getFullYear();

  const ws         = wb.addWorksheet(monthName);
  const isF2F      = key === 'f2f';
  const headerRow  = isF2F ? 19 : 15;
  const dataStart  = isF2F ? 20 : 16;

  // ── Agency header block ──
  cell(ws, 4, 1, 'Agency #');
  cell(ws, 4, 3, 101);
  cell(ws, 5, 1, 'Agency Name');
  cell(ws, 5, 3, 'Housing Opportunities Inc.');
  cell(ws, 6, 1, 'Agency Contact');
  cell(ws, 6, 3, 'Zabriawn Smith');
  if (tag === 'D&D') cell(ws, 6, 7, 'D&D');
  if (tag === 'M&D') cell(ws, 6, 7, 'M&D');
  cell(ws, 7, 1, 'Agency Contact Phone #');
  cell(ws, 7, 3, '(724) 728-7511');
  cell(ws, 9, 1, 'SEND TO:   CHCIBilling@PHFA.org');

  if (isF2F) {
    cell(ws, 13, 1, 'Questions? Call Shanice Moul 717-480-5334');
  } else {
    cell(ws, 13, 1, 'Questions?  ');
    cell(ws, 13, 2, 'Call Shanice');
    cell(ws, 13, 3, 'Moul   717-');
    cell(ws, 13, 4, '480-5334');
  }

  // ── Column headers ──
  const hdr = ws.getRow(headerRow);
  ['Date', 'Case #', 'Last Name', 'First Name', 'Case Status', 'Counseling Type', 'Minutes', isF2F ? ' Amount ' : 'Amount']
    .forEach((v, i) => { hdr.getCell(i + 1).value = v; });
  hdr.font = { bold: true };

  // ── Data rows ──
  let totalMin = 0, totalAmt = 0;
  rows.forEach((r, i) => {
    const rowNum = dataStart + i;
    const amt    = Math.round(r.duration / 60 * 100);
    totalMin    += r.duration;
    totalAmt    += amt;

    const dateVal  = new Date(toDate(r.date));
    const dateCell = ws.getCell(rowNum, 1);
    dateCell.value  = dateVal;
    dateCell.numFmt = 'mm/dd/yyyy';

    cell(ws, rowNum, 2, parseInt(r.caseNo));
    cell(ws, rowNum, 3, r.lastName);
    cell(ws, rowNum, 4, r.firstName);
    cell(ws, rowNum, 5, r.caseStatus);
    cell(ws, rowNum, 6, r.counselingType);
    cell(ws, rowNum, 7, r.duration);
    cell(ws, rowNum, 8, amt);
  });

  // ── Totals row ──
  const totRow = dataStart + rows.length + 1;
  if (isF2F) {
    cell(ws, totRow, 6, 'TOTAL');
    cell(ws, totRow, 8, totalAmt);
  } else {
    cell(ws, totRow, 6, 'Totals');
    cell(ws, totRow, 7, totalMin);
    cell(ws, totRow, 8, totalAmt);
  }
  ws.getRow(totRow).font = { bold: true };

  // ── Column widths ──
  ws.getColumn(1).width = 14;
  ws.getColumn(2).width = 12;
  ws.getColumn(3).width = 18;
  ws.getColumn(4).width = 14;
  ws.getColumn(5).width = 28;
  ws.getColumn(6).width = 34;
  ws.getColumn(7).width = 10;
  ws.getColumn(8).width = 10;

  // ── Download ──
  const buf  = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `CHCI ${typeLabel} Invoice - ${monthName} ${year}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function cell(ws, row, col, value) {
  ws.getCell(row, col).value = value;
}
