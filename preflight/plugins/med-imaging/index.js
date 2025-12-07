import { toGrayscale, stddev, laplacianVariance, loadImage } from '../../core/utils.js';

const POLICY = {
  jpgpng: {
    size_hi: 20, size_mid: 12, size_low: 6,
    sharp_hi: 20, sharp_mid: 12, sharp_low: 6,
    contrast_hi: 20, contrast_mid: 12, contrast_low: 6,
    banding_penalty: -10, noise_penalty: -8, motion_penalty: -10,
    center_uniform_hi: 20, center_uniform_mid: 12, center_uniform_low: 6,
    bonus: 10
  },
  thresholds: { accept: 85, borderline: 70 }
};

export default {
  name: 'med-imaging',
  thresholds: POLICY.thresholds,
  async analyze(file, ui){
    const ext = (file.name||'').toLowerCase().split('.').pop();
    if (ext === 'dcm' || (file.type && /dicom/i.test(file.type))) return analyzeDICOMStub(file);
    if (/(jpe?g|png|bmp|webp)$/i.test(file.name)) return analyzeScanExport(file, ui);
    return { score: 55, messages: ['Not recognized as CT/MR/US export — fallback.'], details: [] };
  }
};

async function analyzeScanExport(file, {status, notes}){
  const W = POLICY.jpgpng;
  status.textContent = 'Decoding CT/MR/US export…';
  const imgEl = await loadImage(file);
  const w=imgEl.naturalWidth, h=imgEl.naturalHeight;
  const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h;
  const ctx=canvas.getContext('2d',{willReadFrequently:true}); ctx.drawImage(imgEl,0,0);
  const img = ctx.getImageData(0,0,w,h);
  const g = toGrayscale(img);

  const megapx=(w*h)/1e6;
  const contrast = stddev(g);
  const lapVar = laplacianVariance(g,w,h);

  const hist = new Uint32Array(256);
  for (let i=0;i<g.length;i++) hist[g[i]]++;
  let emptyBins=0;
  for (let i=1;i<255;i++) if (hist[i]===0) emptyBins++;
  const banding = emptyBins > 140;

  function meanRect(x0,y0,x1,y1){
    let s=0,n=0;
    for(let y=y0;y<y1;y++){ for(let x=x0;x<x1;x++){ s += g[y*w+x]; n++; } }
    return n? s/n : 0;
  }
  const cMean = meanRect(Math.floor(w*0.4), Math.floor(h*0.4), Math.floor(w*0.6), Math.floor(h*0.6));
  const eMeans = [
    meanRect(0,0,Math.floor(w*0.1),Math.floor(h*0.1)),
    meanRect(w-Math.floor(w*0.1),0,w,Math.floor(h*0.1)),
    meanRect(0,h-Math.floor(h*0.1),Math.floor(w*0.1),h),
    meanRect(w-Math.floor(w*0.1),h-Math.floor(h*0.1),w,h)
  ];
  const edgeMean = eMeans.reduce((a,b)=>a+b,0)/eMeans.length;
  const uniformDelta = Math.abs(cMean - edgeMean);

  const bgMean = meanRect(Math.floor(w*0.05), Math.floor(h*0.45), Math.floor(w*0.15), Math.floor(h*0.55));
  let bgVar=0, bgN=0;
  for(let y=Math.floor(h*0.45); y<Math.floor(h*0.55); y++){
    for(let x=Math.floor(w*0.05); x<Math.floor(w*0.15); x++){
      const val = g[y*w+x];
      bgVar += (val - bgMean)*(val - bgMean); bgN++;
    }
  }
  const bgStd = Math.sqrt(bgN? bgVar/bgN : 0);

  let gx=0, gy=0;
  for(let y=1;y<h-1;y++){ for(let x=1;x<w-1;x++){
    const v = g[y*w+x];
    gx += Math.abs(v - g[y*w+(x-1)]);
    gy += Math.abs(v - g[(y-1)*w+x]);
  }}
  const motionAxis = gx>gy? 'x' : 'y';
  const motionRatio = Math.max(gx,gy) / Math.max(1, Math.min(gx,gy));

  let score=0, det=[], msg=[];
  det.push(`MP: ${megapx.toFixed(2)}`);
  if (megapx>=1.0) score+=W.size_hi; else if (megapx>=0.6){ score+=W.size_mid; msg.push('Low resolution — prefer larger matrix.'); } else { score+=W.size_low; msg.push('Very low resolution export.'); }

  det.push(`Sharpness(LapVar/100): ${lapVar.toFixed(1)}`);
  if (lapVar>120) score+=W.sharp_hi; else if (lapVar>=60){ score+=W.sharp_mid; msg.push('Slight blur — check motion.'); } else { score+=W.sharp_low; msg.push('Blurry — repeat acquisition/export.'); }

  det.push(`Contrast(stddev): ${contrast.toFixed(1)}`);
  if (contrast>=30) score+=W.contrast_hi; else if (contrast>=20){ score+=W.contrast_mid; msg.push('Low dynamic range — window/level suboptimal.'); } else { score+=W.contrast_low; msg.push('Very low dynamic range.'); }

  det.push(`Uniformity Δ(center-edge): ${uniformDelta.toFixed(1)} · BG noise σ: ${bgStd.toFixed(1)} · Motion axis: ${motionAxis} (ratio ${motionRatio.toFixed(2)})`);
  if (uniformDelta <= 8) score+=W.center_uniform_hi;
  else if (uniformDelta <= 20) score+=W.center_uniform_mid;
  else score+=W.center_uniform_low;

  if (banding){ score += W.banding_penalty; msg.push('Posterization/banding detected — avoid 8‑bit re-exports; keep original DICOM.'); }
  if (bgStd >= 18) { score += W.noise_penalty; msg.push('High noise — adjust dose, averaging, or reconstruction.'); }
  if (motionRatio >= 2.5) { score += W.motion_penalty; msg.push('Motion artifacts likely — consider breath-hold or stabilization.'); }

  score += W.bonus;
  msg.push(...[
    'Prefer original DICOM for analysis.',
    'Ensure pixel spacing/orientation metadata is preserved on upload.'
  ]);

  notes.textContent = det.join('\n');
  return { score: Math.max(0, Math.min(100, score)), messages: dedupe(msg), details: det };
}

function dedupe(arr){ const s=new Set(), out=[]; for(const x of arr){ const k=String(x).trim(); if(k && !s.has(k)){ s.add(k); out.push(k); } } return out; }

async function analyzeDICOMStub(file){
  return {
    score: 75,
    messages: [
      'DICOM client stub: full checks should run server-side with a DICOM toolkit.',
      'Validate Modality (CT/MR/US), PixelSpacing, SliceThickness, Orientation, Series completeness.'
    ],
    details: ['Format: DICOM (.dcm)']
  };
}
