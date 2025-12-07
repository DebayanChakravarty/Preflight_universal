import { fmtSize, escapeHtml } from './utils.js';

function facts(file){
  const name = (file.name||'').toLowerCase();
  const type = (file.type||'').toLowerCase();
  const isPdf = /\.pdf$/i.test(name) || type === 'application/pdf';
  const isImage = /^image\//.test(type) || /\.(jpe?g|png|bmp|webp)$/i.test(name);
  const isCsv = /\.csv$/i.test(name) || type === 'text/csv';
  const isXlsx = /\.xlsx$/i.test(name) || type.includes('spreadsheet') || type.includes('excel') || type.includes('officedocument.spreadsheetml');
  const isDocx = /\.docx$/i.test(name) || type.includes('officedocument.wordprocessingml');
  const isDicom = /\.dcm$/i.test(name) || /dicom/.test(type);
  return {name,type,isPdf,isImage,isCsv,isXlsx,isDocx,isDicom};
}

function looksLikeXray(file){
  const f = facts(file);
  const xrKeywords = /(x[- ]?ray|xray|radiograph|hand|wrist|chest|bone)/i;
  if (f.isDicom) return true;
  if (f.isImage && xrKeywords.test(f.name)) return true;
  return false;
}
function looksLikeMedImaging(file){
  const f = facts(file);
  const imKeywords = /(ct|mri|mr|ultrasound|us|axial|sagittal|coronal|radiology|dicom|series)/i;
  if (f.isDicom) return true;
  if (f.isImage && imKeywords.test(f.name)) return true;
  return false;
}
function looksLikeLab(file){
  const f = facts(file);
  const labWords = /(lab|report|cbc|cmp|lipid|thyroid|blood|hl7|fhir|chemistry|haem|hematology|biochem|pathology)/i;
  if (f.isCsv || f.isXlsx) return true;
  if (/(json|hl7)$/i.test(f.name) || /application\/json/.test(f.type)) return true;
  if (labWords.test(f.name)) return true;
  return false;
}
function looksLikeGenericDoc(file){
  const f = facts(file);
  return f.isPdf || f.isImage || f.isCsv || f.isXlsx || f.isDocx;
}

const routes = [
  { name: 'xray-plus', test: f => looksLikeXray(f), load: () => import('../plugins/xray/index.js') },
  { name: 'med-imaging', test: f => looksLikeMedImaging(f), load: () => import('../plugins/med-imaging/index.js') },
  { name: 'labs', test: f => looksLikeLab(f), load: () => import('../plugins/labs/index.js') },
  { name: 'doc-ocr', test: f => looksLikeGenericDoc(f), load: () => import('../plugins/doc-ocr/index.js') },
];

const apiUpload = document.getElementById('apiUpload');
const apiConfirm = document.getElementById('apiConfirm');
const drop = document.getElementById('drop');
const fileInput = document.getElementById('file');
const filesDiv = document.getElementById('files');

drop.addEventListener('click', ()=>fileInput.click());
drop.addEventListener('dragover', e=>{ e.preventDefault(); drop.style.borderColor='#4c86ff'; });
drop.addEventListener('dragleave', ()=>{ drop.style.borderColor='#2a3343'; });
drop.addEventListener('drop', async e=>{ e.preventDefault(); drop.style.borderColor='#2a3343'; await handleFiles(e.dataTransfer.files); });
fileInput.addEventListener('change', async e=>{ await handleFiles(e.target.files); });

async function handleFiles(fl){ for(const f of fl){ await addFileCard(f); } }

async function addFileCard(file){
  const card = document.createElement('div');
  card.className='result';
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      <div><b>${escapeHtml(file.name)}</b> <span class="pill">${file.type||'unknown'}</span> <span class="pill">${fmtSize(file.size)}</span></div>
      <div><button class="btn" id="btnUpload" disabled>Upload</button></div>
    </div>
    <div id="status" class="progress">Routing to plugin…</div>
    <div class="grid">
      <div class="panel"><div class="k">Quality Summary</div><div class="tips" id="tips"></div></div>
      <div class="panel"><div class="k">Details</div><div class="mono" id="notes"></div></div>
    </div>`;
  filesDiv.prepend(card);
  const status = card.querySelector('#status'); const tips = card.querySelector('#tips'); const notes = card.querySelector('#notes'); const btnUpload  = card.querySelector('#btnUpload');

  let plugin;
  for (const r of routes){
    try{
      if (r.test(file)){ plugin = await r.load(); plugin = plugin.default; break; }
    }catch(_){ /* ignore */ }
  }

  // FINAL FAILSAFE: default to doc-ocr for common types
  if (!plugin){
    if (looksLikeGenericDoc(file)){
      plugin = await import('../plugins/doc-ocr/index.js').then(m=>m.default);
    }
  }

  if (!plugin){
    status.innerHTML = `<span class="bad">No plugin matched file type.</span> (Tip: ensure proper file extension or MIME type.)`;
    return;
  }

  status.textContent = `Analyzing via plugin: ${plugin.name}…`;
  let res;
  try{ res = await plugin.analyze(file, { status, notes }); }
  catch(err){ status.innerHTML = `<span class="bad">Analysis error:</span> ${escapeHtml(err.message||String(err))}`; return; }
  const color = res.score>=plugin.thresholds.accept?'good':res.score>=plugin.thresholds.borderline?'warn':'bad';
  const verdict = res.score>=plugin.thresholds.accept ? '✅ Good to process' : res.score>=plugin.thresholds.borderline ? '⚠️ Borderline — consider fixes' : '❌ Poor — please rescan or fix';
  status.innerHTML = `<span class="score ${color}">Score: ${Math.round(res.score)}/100</span> — ${verdict} <span class="pill">${plugin.name}</span>`;
  const lines = (res.messages||[]).map(s=>'• '+escapeHtml(s)).join('<br>'); tips.innerHTML = lines; notes.textContent = (res.details||[]).join('\n');
  btnUpload.disabled = !(res.score>=plugin.thresholds.accept);
  btnUpload.onclick = async ()=>{
    btnUpload.disabled = true; status.textContent = 'Requesting upload URL…';
    try{
      const upRes = await fetch(apiUpload.value, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ fileName:file.name, contentType:file.type||'application/octet-stream', size:file.size, score:Math.round(res.score) }) }).then(r=>{ if(!r.ok) throw new Error('Upload-URL request failed'); return r.json(); });
      const { url, key } = upRes || {}; if(!url) throw new Error('No presigned URL returned');
      status.textContent = 'Uploading to storage…';
      const put = await fetch(url, { method:'PUT', body:file, headers:{ 'Content-Type': file.type||'application/octet-stream' } }); if(!put.ok) throw new Error('PUT upload failed');
      if (apiConfirm.value){ status.textContent = 'Finalizing…'; await fetch(apiConfirm.value, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key, fileName:file.name, size:file.size, score:Math.round(res.score) }) }); }
      status.innerHTML = `<span class="good">✅ Uploaded</span> — key: <code>${escapeHtml(key||'n/a')}</code>`;
    }catch(err){ status.innerHTML = `<span class="bad">Upload error:</span> ${escapeHtml(err.message||String(err))}`; btnUpload.disabled = false; }
  };
}
