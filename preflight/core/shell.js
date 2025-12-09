import { fmtSize, escapeHtml, loadImage } from './utils.js';

// DOM Elements
const drop = document.getElementById('drop');
const fileInput = document.getElementById('file');
const filesDiv = document.getElementById('files');

// Event Listeners
drop.addEventListener('click', () => fileInput.click()); // Zone click triggers input
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
drop.addEventListener('dragleave', () => { drop.classList.remove('drag-over'); });
drop.addEventListener('drop', async e => {
  e.preventDefault();
  drop.classList.remove('drag-over');
  await handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', async e => { await handleFiles(e.target.files); });

/**
 * Main File Handler
 * Step 1 (Detect): Iterate through files and route them.
 */
async function handleFiles(fileList) {
  for (const file of fileList) {
    await analyzeFile(file);
  }
}

/**
 * FILE ROUTER & ANALYZER
 * Routes to: Image Logic, PDF Logic, or Spreadsheet Logic
 */
async function analyzeFile(file) {
  // 1. UI CARD
  const ui = createCard(file);
  const statusEl = ui.element.querySelector('.status-text');
  const detailsEl = ui.element.querySelector('.details');
  document.getElementById('files').prepend(ui.element);

  try {
    statusEl.innerHTML = `<span style="color:var(--muted)">analyzing with WebAssembly engines...</span>`;

    // 2. ROUTE by file type
    const lowName = file.name.toLowerCase();
    const type = file.type;
    const tag = determinePlugin(file); // Determine tag (xray, labs, etc)

    let result = { valid: false, msg: "Unknown file type" };

    if (type.includes('image/') || /\.(jpg|jpeg|png|webp|bmp)$/i.test(lowName)) {
      result = await checkImage(file, tag);
    }
    else if (type === 'application/pdf' || /\.pdf$/i.test(lowName)) {
      result = await checkPdf(file, tag);
    }
    else if (
      lowName.endsWith('.csv') ||
      lowName.endsWith('.xlsx') ||
      lowName.endsWith('.xls') ||
      type.includes('spreadsheet') || type.includes('excel') || type.includes('csv')
    ) {
      result = await checkSpreadsheet(file, tag);
    }
    else {
      // Fallback
      result = { valid: false, score: 0, msg: "⚠️ File Type Unsupported for analysis", tag };
    }

    // 3. UPDATE FEEDBACK
    renderResult(statusEl, detailsEl, result, ui.btn);

  } catch (err) {
    console.error(err);
    renderResult(statusEl, detailsEl, { valid: false, score: 0, msg: `❌ Crashed: ${err.message}` }, ui.btn);
  }
}

/* -------------------------------------------------------------------------- */
/*                               LOGIC ENGINES                                */
/* -------------------------------------------------------------------------- */

/**
 * UTILS: File Tagging (Restoring "Plugin" Concept)
 */
function determinePlugin(file) {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();

  // 1. X-Ray Plus
  if (/(x[- ]?ray|xray|radiograph|hand|wrist|chest|bone)/i.test(name)) return 'xray-plus';

  // 2. Med Imaging
  if (/(ct|mri|mr|ultrasound|us|axial|sagittal|coronal|radiology|dicom|series)/i.test(name) || type.includes('dicom') || name.endsWith('.dcm')) return 'med-imaging';

  // 3. Labs
  if (/(lab|report|cbc|cmp|lipid|thyroid|blood|hl7|fhir|chemistry|haem|hematology|biochem|pathology)/i.test(name)) return 'labs';
  if (name.endsWith('.csv') || name.endsWith('.xlsx')) return 'labs'; // Spreadsheets likely labs

  // 4. Default
  return 'doc-ocr';
}

/** 
 * IMAGE ENGINE 
 * Score based on Resolution (50pts) + OCR Confidence (50pts)
 */
async function checkImage(file, tag) {
  // A. Load Image
  let img;
  try {
    img = await loadImage(file);
  } catch (e) { return { valid: false, score: 0, msg: "❌ Corrupt Image file", tag }; }

  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const minDim = Math.min(width, height);

  // Scoring Part 1: Resolution (Max 50)
  // < 600px = 0pts, 600-1200px = linear scaled, >1200px = 50pts
  let resScore = 0;
  if (minDim >= 1200) resScore = 50;
  else if (minDim >= 600) resScore = Math.round(((minDim - 600) / 600) * 50);

  // C. OCR Check (Tesseract)
  let confidence = 0;
  let ocrMsg = "OCR Queued";
  try {
    const worker = await Tesseract.createWorker('eng');
    const ret = await worker.recognize(file);
    confidence = ret.data.confidence; // 0-100
    await worker.terminate();
    ocrMsg = `OCR Conf: ${Math.round(confidence)}%`;
  } catch (e) {
    console.warn("OCR Failed", e);
    ocrMsg = "OCR Failed";
  }

  // Scoring Part 2: OCR (Max 50)
  // Confidence is 0-100. We map it to 0-50.
  const ocrScore = Math.round(confidence / 2);

  const totalScore = resScore + ocrScore;
  const valid = totalScore >= 50;

  let msg = valid ? "✅ Good Quality Image" : "⚠️ Low Quality Image";
  if (minDim < 600) msg = "⚠️ Too Blurry / Small";

  return {
    valid,
    score: totalScore,
    msg: `${msg} (${width}x${height}, ${ocrMsg})`,
    tag
  };
}

/**
 * PDF ENGINE (PDF.js)
 * Score based on Renderability and Dimensions/DPI
 */
async function checkPdf(file, tag) {
  const arrayBuffer = await file.arrayBuffer();

  // Load PDF
  let pdf;
  try {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    pdf = await loadingTask.promise;
  } catch (e) {
    return { valid: false, score: 0, msg: "❌ Invalid PDF File", tag };
  }

  if (pdf.numPages === 0) {
    return { valid: false, score: 0, msg: "❌ Empty PDF Document", tag };
  }

  // Get Page 1
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1.0 }); // 72 DPI base

  // Determine Score based on width (assuming 72dpi, standard letter is ~600px width)
  // > 500px width = Good. < 300px = Bad.
  let score = 100;
  if (viewport.width < 300 || viewport.height < 300) {
    score = 40;
  } else if (viewport.width < 500) {
    score = 70;
  }

  return {
    valid: score >= 50,
    score,
    msg: score >= 80 ? `✅ Valid PDF (${pdf.numPages} Pages)` : "⚠️ Low Resolution / Thumbnail PDF",
    tag
  };
}

/**
 * SPREADSHEET ENGINE (SheetJS)
 * Score based on structure presence
 */
async function checkSpreadsheet(file, tag) {
  const data = await file.arrayBuffer();
  let workbook;
  try {
    workbook = XLSX.read(data, { type: 'array' });
  } catch (e) {
    return { valid: false, score: 0, msg: "❌ Corrupt Spreadsheet", tag };
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  if (!sheet) return { valid: false, score: 0, msg: "❌ Empty Workbook", tag };

  // Convert to JSON (header row)
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  if (!rows || rows.length === 0) {
    return { valid: false, score: 0, msg: "❌ Empty File (No structure found)", tag };
  }

  const header = rows[0];
  if (!header || header.length === 0) {
    return { valid: false, score: 20, msg: "⚠️ Empty Structure (Header missing)", tag };
  }

  // Bonus points for more columns? No, just pass.
  return {
    valid: true,
    score: 100,
    msg: `✅ Valid Table (${header.length} Cols Detected)`,
    tag
  };
}


/* -------------------------------------------------------------------------- */
/*                                 UI HELPERS                                 */
/* -------------------------------------------------------------------------- */

function createCard(file) {
  const el = document.createElement('div');
  el.className = 'result';
  // Use a unique ID for the button to query it later within this element scope, 
  // or just querySelector('.btn') since we have the reference to 'el'.
  el.innerHTML = `
    <div class="close-card-btn" onclick="this.parentElement.remove()">&times;</div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      <div>
        <div style="font-weight:bold; margin-bottom:4px;">${escapeHtml(file.name)}</div>
        <div style="font-size:12px; color:var(--muted); margin-bottom:8px;">${fmtSize(file.size)}</div>
      </div>
      <div><button class="btn" disabled>Upload</button></div>
    </div>
    <div class="status-text" style="font-size:14px;">In Queue...</div>
    <div class="details tips" style="margin-top:4px;"></div>
  `;

  // Attach event listener to the upload button
  const btn = el.querySelector('.btn');
  btn.addEventListener('click', () => {
    document.getElementById('api-modal').classList.add('active');
  });

  return { element: el, btn }; // Return btn ref
}

function renderResult(statusEl, detailsEl, result, btnEl) {
  let colorClass = 'bad';
  if (result.score >= 80) colorClass = 'good';
  else if (result.score >= 50) colorClass = 'warn';

  // Enable/Disable Upload Button
  if (btnEl) {
    if (result.valid) {
      btnEl.removeAttribute('disabled');
    } else {
      btnEl.setAttribute('disabled', 'true');
    }
  }

  // Tag Pill
  const tagHtml = result.tag ? `<span class="pill" style="margin-left:8px; color:var(--text); border-color:var(--muted)">${result.tag}</span>` : '';

  statusEl.innerHTML = `<span class="score ${colorClass}">Score: ${result.score}/100</span> — <span class="${colorClass}">${result.msg}</span> ${tagHtml}`;
}
