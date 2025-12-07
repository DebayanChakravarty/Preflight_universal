import { toGrayscale, stddev, laplacianVariance, detectDelimiter, mode, refCols, loadImage } from '../../core/utils.js';

const POLICY = {
  pdf: { text: 35, dpi_hi: 20, dpi_mid: 12, skew_penalty: -8, contrast_hi: 20, contrast_mid: 12, contrast_low: 6, completeness: 15 },
  image: { resolution_hi: 35, resolution_mid: 20, resolution_low: 8, sharp_hi: 25, sharp_mid: 15, sharp_low: 6, contrast_hi: 20, contrast_mid: 12, contrast_low: 6 },
  csv: { rows_hi: 30, rows_low: 15, consistency_hi: 35, consistency_mid: 22, consistency_low: 10, empties_hi: 20, empties_mid: 10, empties_low: 5, units_bonus: 10 },
  xlsx: { rows_hi: 30, rows_low: 15, cols_hi: 25, cols_low: 12, empties_hi: 20, empties_mid: 10, empties_low: 5, units_bonus: 10 },
  hl7: { segments: 60, observations: 25, codes: 15 },
  fhir: { structure: 60, observations: 25, units: 15 },
  thresholds: { accept: 85, borderline: 70 }
};

export default {
  name: 'labs',
  thresholds: POLICY.thresholds,
  async analyze(file, ui){
    const name = (file.name||'').toLowerCase();
    if (/pdf$/.test(name)) return analyzePdf(file, ui);
    if (/(jpe?g|png|bmp|webp)$/.test(name)) return analyzeImage(file, ui);
    if (/csv$/.test(name)) return analyzeCsv(file);
    if (/xlsx$/.test(name)) return analyzeXlsx(file);
    if (/json$/.test(name)) return analyzeFhirJson(file);
    if (/hl7$/.test(name) || /x-hl7/.test(file.type||'')) return analyzeHl7(file);
    return { score: 55, messages: ['Unknown lab file format'], details: [] };
  }
};

async function analyzePdf(file, {status, notes}){
  const W=POLICY.pdf;
  try{
    status.textContent = 'Loading PDF.js…';
    const ab=await file.arrayBuffer();
    const pdf=await pdfjsLib.getDocument({data:ab}).promise;
    const page=await pdf.getPage(1);
    const text=await page.getTextContent();
    const hasText=((text.items||[]).map(it=>it.str||'').join(' ').trim().length>20);
    const viewport=page.getViewport({scale:2.0});
    const canvas=document.createElement('canvas'); canvas.width=viewport.width|0; canvas.height=viewport.height|0;
    const ctx=canvas.getContext('2d',{willReadFrequently:true}); await page.render({canvasContext:ctx,viewport}).promise;
    const img=ctx.getImageData(0,0,canvas.width,canvas.height); const gray=toGrayscale(img);
    const contrast=stddev(gray); const lapVar=laplacianVariance(gray,canvas.width,canvas.height);
    let score=0,msg=[],det=[];
    if (hasText){ score+=W.text; det.push('Text layer: yes'); } else { det.push('Text layer: no'); msg.push('Scanned PDF — OCR will be required.'); }
    const megapx=(canvas.width*canvas.height)/1e6; det.push(`Render MP: ${megapx.toFixed(2)}`);
    if (megapx>=2.0) score+=W.dpi_hi; else if (megapx>=1.0){ score+=W.dpi_mid; msg.push('Low resolution — prefer ≥ 300 DPI.'); }
    det.push(`Sharpness(LapVar/100): ${lapVar.toFixed(1)}`);
    det.push(`Contrast(stddev): ${contrast.toFixed(1)}`);
    if (contrast>=30) score+=W.contrast_hi; else if (contrast>=20) score+=W.contrast_mid; else score+=W.contrast_low;
    score+=W.completeness; msg.push('Check patient name, date, test panel, and reference ranges present.');
    notes.textContent = det.join('\n');
    return { score: Math.min(100,score), messages: dedupe(msg), details: det };
  }catch(e){
    return { score: 50, messages: ['PDF parse error — limited checks.'], details: ['PDF.js error: '+e.message] };
  }
}

async function analyzeImage(file, {status, notes}){
  const W=POLICY.image;
  status.textContent='Decoding lab image…';
  const imgEl=await loadImage(file);
  const w=imgEl.naturalWidth,h=imgEl.naturalHeight;
  const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h;
  const ctx=canvas.getContext('2d',{willReadFrequently:true}); ctx.drawImage(imgEl,0,0);
  const img=ctx.getImageData(0,0,w,h); const gray=toGrayscale(img);
  const contrast=stddev(gray); const lapVar=laplacianVariance(gray,w,h);
  const megapx=(w*h)/1e6;
  let score=0,msg=[],det=[];
  det.push(`MP: ${megapx.toFixed(2)}`);
  if (megapx>=2.0) score+=W.resolution_hi; else if (megapx>=1.0){ score+=W.resolution_mid; msg.push('Low resolution — aim for higher DPI.'); } else { score+=W.resolution_low; msg.push('Very low resolution.'); }
  det.push(`Sharpness(LapVar/100): ${lapVar.toFixed(1)}`);
  if (lapVar>120) score+=W.sharp_hi; else if (lapVar>=60){ score+=W.sharp_mid; msg.push('Slight blur.'); } else { score+=W.sharp_low; msg.push('Blurry — rescan.'); }
  det.push(`Contrast(stddev): ${contrast.toFixed(1)}`);
  if (contrast>=30) score+=W.contrast_hi; else if (contrast>=20){ score+=W.contrast_mid; msg.push('Low contrast.'); } else { score+=W.contrast_low; msg.push('Very low contrast.'); }
  notes.textContent = det.join('\n');
  return { score: Math.min(100,score), messages: dedupe(msg), details: det };
}

async function analyzeCsv(file){
  const W=POLICY.csv;
  const text=await file.text(); const sample=text.slice(0,250000);
  const delim=detectDelimiter(sample);
  const rows=sample.split(/\r?\n/).filter(r=>r.trim().length>0).slice(0,200);
  const colsCount = rows.map(r=>r.split(delim).length);
  const modeCols = mode(colsCount);
  const inconsistent = colsCount.filter(c => Math.abs(c-modeCols)>0).length;
  const empties = rows.reduce((acc,r)=>acc+(r.split(delim).filter(c=>c===''||c===null).length),0);
  const totalCells = rows.reduce((acc,r)=>acc+r.split(delim).length,0);
  const emptyRate = totalCells? (empties/totalCells):1;
  let score=0,msg=[],det=[];
  det.push(`Rows: ${rows.length}, Delim: ${JSON.stringify(delim)}`);
  if (rows.length>=10) score+=W.rows_hi; else { score+=W.rows_low; msg.push('Very few rows — include ≥ 10.'); }
  const inconsistencyRate = rows.length? (inconsistent/rows.length):1;
  det.push(`Inconsistency: ${(inconsistencyRate*100).toFixed(1)}%`);
  if (inconsistencyRate<=0.05) score+=W.consistency_hi; else if (inconsistencyRate<=0.15){ score+=W.consistency_mid; msg.push('Irregular column counts — fix separators/quotes.'); } else { score+=W.consistency_low; msg.push('Highly inconsistent columns — clean CSV export.'); }
  det.push(`Empty cells rate: ${(emptyRate*100).toFixed(1)}%`);
  if (emptyRate<=0.1) score+=W.empties_hi; else if (emptyRate<=0.25){ score+=W.empties_mid; msg.push('Many empty cells — fill key fields.'); } else { score+=W.empties_low; msg.push('Too many empty cells.'); }
  if (/(unit|units|mg\/dl|mmol\/l|g\/l|iu\/l)/i.test(sample)) score+=W.units_bonus;
  msg.push('Ensure patient ID, collection date/time, units, and reference ranges are present.');
  return { score: Math.min(100,score), messages: dedupe(msg), details: det };
}

async function analyzeXlsx(file){
  const W=POLICY.xlsx;
  if(!window.XLSX||typeof XLSX.read!=='function'){await new Promise(r=>setTimeout(r,1200));}
  if(!window.XLSX||typeof XLSX.read!=='function'){return{score:50,messages:['XLSX library not available — try again or save as CSV.'],details:['XLSX not ready']};}
  try{
    const ab=await file.arrayBuffer();
    const wb=XLSX.read(ab,{type:'array'});
    const sheetName=wb.SheetNames[0]; if(!sheetName) return { score:45, messages:['No sheets found'], details:[] };
    const ws=wb.Sheets[sheetName];
    const json=XLSX.utils.sheet_to_json(ws,{defval:''});
    const rows=json.length;
    const cols=ws['!ref']? (ws['!ref'].match(/:([A-Z]+)/)||[])[1] : null;
    let score=0,msg=[],det=[];
    det.push(`Rows: ${rows}`);
    if (rows>=10) score+=W.rows_hi; else { score+=W.rows_low; msg.push('Too few rows — include ≥ 10.'); }
    if (cols) score+=W.cols_hi; else score+=W.cols_low;
    let empties=0,total=0;
    json.slice(0,200).forEach(r=>{const vals=Object.values(r); total+=vals.length; vals.forEach(v=>{ if(v===''||v===null) empties++; });});
    const er = total? empties/total : 1;
    det.push(`Empty cells rate: ${(er*100).toFixed(1)}%`);
    if (er<=0.1) score+=W.empties_hi; else if (er<=0.25){ score+=W.empties_mid; msg.push('Many blanks — fill key fields.'); } else { score+=W.empties_low; msg.push('High blank rate.'); }
    const text = JSON.stringify(json).toLowerCase();
    if (/(unit|units|mg\/dl|mmol\/l|g\/l|iu\/l)/i.test(text)) score+=W.units_bonus;
    msg.push('Check columns: Patient/ID, DateTime, Test, Result, Units, Reference Range.');
    return { score: Math.min(100,score), messages: dedupe(msg), details: det };
  }catch(e){
    return { score: 50, messages:['Could not parse XLSX — save as CSV and retry.'], details: ['Parse error: '+e.message] };
  }
}

async function analyzeFhirJson(file){
  const W=POLICY.fhir;
  try{
    const raw = await file.text();
    const obj = JSON.parse(raw);
    let score=0, det=[], msg=[];
    const resources = Array.isArray(obj.entry) ? obj.entry.map(e=>e.resource) : (obj.resourceType? [obj] : []);
    const hasPatient = resources.some(r=>r && r.resourceType==='Patient');
    const observations = resources.filter(r=>r && r.resourceType==='Observation');
    const withUnits = observations.filter(o=>o && o.valueQuantity && (o.valueQuantity.unit||o.valueQuantity.code));
    if (hasPatient) score += W.structure; else msg.push('No Patient resource found.');
    score += Math.min(25, observations.length? 25: 0);
    if (withUnits.length) score += W.units; else msg.push('Observations missing units.');
    det.push(`Observations: ${observations.length} · With units: ${withUnits.length}`);
    return { score: Math.min(100,score), messages: dedupe(msg), details: det };
  }catch(e){
    return { score: 50, messages:['Invalid JSON or FHIR structure.'], details:['JSON parse error: '+e.message] };
  }
}

async function analyzeHl7(file){
  const W=POLICY.hl7;
  try{
    const text = await file.text();
    let score=0, det=[], msg=[];
    const segs = text.split(/\r?\n/).map(s=>s.split('|')[0]).filter(Boolean);
    const hasMSH = segs.includes('MSH');
    const hasPID = segs.includes('PID');
    const hasOBR = segs.includes('OBR');
    const obxCount = segs.filter(s=>s==='OBX').length;
    if (hasMSH && hasPID) score += 30;
    if (hasOBR) score += 15;
    score += Math.min(25, obxCount? 25:0);
    det.push(`Segments: ${segs.length} (OBX: ${obxCount})`);
    if (!(hasMSH && hasPID)) msg.push('Missing MSH/PID segments.');
    return { score: Math.min(100, score + 15), messages: dedupe(msg), details: det };
  }catch(e){
    return { score: 50, messages:['HL7 parse error.'], details:['HL7 error: '+e.message] };
  }
}

function dedupe(arr){ const s=new Set(), out=[]; for(const x of arr){ const k=String(x).trim(); if(k && !s.has(k)){ s.add(k); out.push(k); } } return out; }
