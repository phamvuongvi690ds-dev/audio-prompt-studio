const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const installerFfmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const isDev = !app.isPackaged;
const BASE = path.join(os.homedir(), '.audio-prompt-studio');
const OUT = path.join(BASE, 'output');
const CFG = path.join(BASE, 'config.json');
function ensure(){ fs.mkdirSync(OUT, { recursive: true }); }
function createWindow(){
  const w = new BrowserWindow({ width: 1220, height: 820, backgroundColor: '#08111f', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }});
  if (isDev) w.loadURL('http://127.0.0.1:5173'); else w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}
app.whenReady().then(()=>{ ensure(); createWindow(); });
app.on('window-all-closed',()=>{ if(process.platform !== 'darwin') app.quit(); });

ipcMain.handle('dialog:openFile', async (_e, opts={}) => {
  const r = await dialog.showOpenDialog({ properties: opts.properties || ['openFile'], filters: opts.filters || [] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dialog:saveText', async (_e, p={}) => {
  const r = await dialog.showSaveDialog({ title:p.title||'Lưu prompt TXT', defaultPath:p.defaultPath||'audio-prompts.txt', filters:[{name:'Text',extensions:['txt']} ] });
  if(r.canceled || !r.filePath) return {ok:false,canceled:true};
  fs.writeFileSync(r.filePath, String(p.text||''), 'utf8');
  return {ok:true,filePath:r.filePath};
});
ipcMain.handle('dialog:readText', async (_e, p={}) => {
  try {
    if(!p.filePath) return {ok:false,error:'missing_file'};
    return {ok:true,text:fs.readFileSync(p.filePath,'utf8'),filePath:p.filePath};
  } catch(e) {
    return {ok:false,error:String(e.message||e)};
  }
});
ipcMain.handle('config:load', async()=>{ try { return { ok:true, ...JSON.parse(fs.readFileSync(CFG,'utf8')) }; } catch { return { ok:true }; } });
ipcMain.handle('config:save', async(_e,p)=>{ ensure(); fs.writeFileSync(CFG, JSON.stringify(p||{}, null, 2)); return { ok:true }; });
function ffmpegBin(){
  const platformDir = process.platform === 'win32' ? 'win32-x64' : process.platform === 'darwin' ? 'darwin-x64' : 'linux-x64';
  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const unpackedInstaller = installerFfmpegPath.replace('app.asar', 'app.asar.unpacked');
  const candidates = [
    unpackedInstaller,
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', platformDir, exeName),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', 'ffmpeg', exeName),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', 'ffmpeg', platformDir, exeName),
    installerFfmpegPath,
  ];
  for (const c of candidates) { try { if (c && fs.existsSync(c)) return c; } catch {} }
  return installerFfmpegPath;
}
function runFfmpeg(args){ return spawnSync(ffmpegBin(), args, { encoding:'utf8', windowsHide:true }); }
function mime(f){ const e=String(f).toLowerCase().split('.').pop(); if(e==='wav')return 'audio/wav'; if(e==='m4a')return 'audio/mp4'; return 'audio/mpeg'; }
function parseKeys(input){ return String(input||'').split(/[\n,;]+/).map(x=>x.trim()).filter(Boolean); }
function waitMs(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function gemini(apiKeys, parts, system, json=false, startIndex=0){
  const keys=parseKeys(apiKeys); if(!keys.length) throw new Error('missing_api_key');
  const models=['gemini-2.5-flash','gemini-2.0-flash']; let last='';
  for(let k=0;k<keys.length;k++){ const apiKey=keys[(startIndex+k)%keys.length];
  for(const m of models){
    try{
      const body={ contents:[{role:'user',parts}], systemInstruction:{parts:[{text:system}]}, generationConfig:{temperature:.55} };
      if(json) body.generationConfig.responseMimeType='application/json';
      const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      const o=await r.json().catch(()=>({}));
      if(!r.ok){ const msg=o.error?.message || `http_${r.status}`; if(msg.includes('Quota exceeded') || msg.includes('quota')){ const retry=o.error?.details?.flatMap(d=>d.retryDelay?[d.retryDelay]:[])?.[0]; if(retry && keys.length===1){ const sec=Number(String(retry).replace('s',''))||0; if(sec>0 && sec<=65) await waitMs((sec+1)*1000); } last='quota_exceeded: API key/model quota exceeded. Add another Gemini API key, wait for quota reset, or paste Văn bản gốc so the app can skip audio transcription and use fewer requests.'; continue; } last=msg; continue; }
      return (o.candidates?.[0]?.content?.parts || []).map(p=>p.text||'').join('\n').trim();
    }catch(e){ last=String(e); }
  }}
  throw new Error(last || 'gemini_failed');
}


function mp3DurationFallback(file){
  try{
    const buf=fs.readFileSync(file);
    let off=0;
    if(buf.length>10 && buf.toString('ascii',0,3)==='ID3'){
      off=10 + ((buf[6]&0x7f)<<21) + ((buf[7]&0x7f)<<14) + ((buf[8]&0x7f)<<7) + (buf[9]&0x7f);
    }
    const bitrates={
      'V1L1':[0,32,64,96,128,160,192,224,256,288,320,352,384,416,448],
      'V1L2':[0,32,48,56,64,80,96,112,128,160,192,224,256,320,384],
      'V1L3':[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320],
      'V2L1':[0,32,48,56,64,80,96,112,128,144,160,176,192,224,256],
      'V2L2':[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160],
      'V2L3':[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160]
    };
    for(let i=off;i<Math.min(buf.length-4,off+200000);i++){
      if(buf[i]===0xff && (buf[i+1]&0xe0)===0xe0){
        const verBits=(buf[i+1]>>3)&3; const layerBits=(buf[i+1]>>1)&3; const brIdx=(buf[i+2]>>4)&15;
        const ver=verBits===3?'V1':(verBits===2||verBits===0?'V2':''); const layer=layerBits===3?'L1':layerBits===2?'L2':layerBits===1?'L3':'';
        const kbps=(bitrates[ver+layer]||[])[brIdx]||0;
        if(kbps>0){ return Math.max(1, Math.round((buf.length-i)*8/(kbps*1000))); }
      }
    }
  }catch{}
  return 0;
}

function mediaDurationSeconds(file){
  try{
    const r=runFfmpeg(['-hide_banner','-i',file]);
    const text=(r.stderr||'')+'\n'+(r.stdout||'');
    const m=text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if(m) return Number(m[1])*3600 + Number(m[2])*60 + Number(m[3]);
  }catch{}
  if(String(file).toLowerCase().endsWith('.mp3')) return mp3DurationFallback(file);
  return 0;
}

function vendorWhisperDir(){
  const candidates=[
    path.join(process.resourcesPath || '', 'vendor', 'whisper'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'vendor', 'whisper'),
    path.join(__dirname, '..', 'vendor', 'whisper'),
    path.join(__dirname, '..', 'app.asar.unpacked', 'vendor', 'whisper'),
    path.join(process.cwd(), 'vendor', 'whisper'),
  ];
  for(const c of candidates){ try{ if(c && fs.existsSync(c)) return c; }catch{} }
  return candidates[0];
}
function findWhisperExe(){
  const dir=vendorWhisperDir();
  const names=process.platform==='win32' ? ['whisper-cli.exe','main.exe','whisper.exe'] : ['whisper-cli','main','whisper'];
  const nested=[path.join(dir,'Release'), path.join(dir,'bin'), dir];
  for(const d of nested) for(const n of names){ const f=path.join(d,n); try{ if(fs.existsSync(f)) return f; }catch{} }
  return names[0];
}
function findWhisperModel(){
  const dir=vendorWhisperDir();
  const candidates=[
    path.join(dir,'models','ggml-tiny.bin'),
    path.join(dir,'models','ggml-base.bin'),
    path.join(dir,'models','ggml-small.bin'),
    path.join(dir,'ggml-tiny.bin'),
    path.join(dir,'ggml-base.bin'),
    path.join(dir,'ggml-small.bin'),
  ];
  for(const c of candidates){ try{ if(fs.existsSync(c)) return c; }catch{} }
  throw new Error('missing_bundled_whisper_model');
}
function prepareWhisperWav(file){
  if(String(file).toLowerCase().endsWith('.wav')) return file;
  const wav=path.join(OUT, 'whisper-input-' + Date.now() + '.wav');
  const ff=ffmpegBin();
  const r=spawnSync(ff, ['-y','-hide_banner','-i',file,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',wav], { encoding:'utf8', windowsHide:true, timeout: 20*60*1000 });
  if(r.status!==0 || !fs.existsSync(wav)){
    const detail=(r.error ? String(r.error.message||r.error)+' | ' : '') + (r.signal ? 'signal_'+r.signal+' | ' : '') + (r.stderr||r.stdout||('exit_'+r.status));
    throw new Error('whisper_wav_convert_failed: ffmpeg=' + ff + ' input=' + file + ' output=' + wav + ' detail=' + detail.slice(0,1500));
  }
  return wav;
}
function runProcessAsync(cmd,args,opts={}){
  return new Promise((resolve)=>{
    let stdout='', stderr='';
    const child=spawn(cmd,args,{...opts, windowsHide:true});
    child.stdout?.on('data',d=>{ stdout+=String(d); });
    child.stderr?.on('data',d=>{ stderr+=String(d); });
    child.on('error',error=>resolve({status:null,error,stdout,stderr}));
    child.on('close',(status,signal)=>resolve({status,signal,stdout,stderr}));
  });
}
async function localWhisperTranscribe(file){
  const exe=findWhisperExe();
  const model=findWhisperModel();
  const wav=prepareWhisperWav(file);
  const prefix=path.join(OUT, 'whisper-' + Date.now());
  const threads=Math.max(1, Math.min(8, (os.cpus()?.length||4)-1));
  const args=['-m', model, '-f', wav, '-otxt', '-of', prefix, '-l', 'auto', '-tr', '-t', String(threads)];
  const r=await runProcessAsync(exe, args, { cwd:path.dirname(exe), env:{...process.env, PATH:path.dirname(exe)+path.delimiter+(process.env.PATH||'')} });
  const txtFile=prefix + '.txt';
  if(r.status!==0 || !fs.existsSync(txtFile)){
    const detail=(r.error ? String(r.error.message||r.error)+' | ' : '') + (r.signal ? 'signal_'+r.signal+' | ' : '') + (r.stderr||r.stdout||('exit_'+r.status));
    throw new Error('local_whisper_failed: exe=' + exe + ' model=' + model + ' wav=' + wav + ' detail=' + detail.slice(0,1200));
  }
  return fs.readFileSync(txtFile,'utf8').trim();
}

function promptCountFromDuration(file, seconds){
  const duration=mediaDurationSeconds(file);
  const cut=Math.max(1, Number(seconds||8)||8);
  return {durationSeconds:duration, cutSeconds:cut, promptCount:duration?Math.ceil(duration/cut):0};
}

function splitAudio(file, seconds){
  ensure();
  const dir = path.join(OUT, 'chunks_' + Date.now());
  fs.mkdirSync(dir, { recursive:true });
  const ext = String(file).toLowerCase().endsWith('.wav') ? 'wav' : String(file).toLowerCase().endsWith('.m4a') ? 'm4a' : 'mp3';
  let pattern = path.join(dir, `chunk_%03d.${ext}`);
  let r = runFfmpeg(['-y','-i',file,'-f','segment','-segment_time',String(seconds||30),'-reset_timestamps','1','-c','copy',pattern]);
  let files = fs.readdirSync(dir).filter(x => x.startsWith('chunk_')).map(x => path.join(dir, x));
  if (r.status !== 0 || !files.length) {
    pattern = path.join(dir, 'chunk_%03d.mp3');
    r = runFfmpeg(['-y','-i',file,'-f','segment','-segment_time',String(seconds||30),'-reset_timestamps','1','-vn','-ar','44100','-ac','2','-b:a','128k',pattern]);
    files = fs.readdirSync(dir).filter(x => x.startsWith('chunk_') && x.endsWith('.mp3')).map(x => path.join(dir, x));
  }
  if (r.status !== 0 || !files.length) {
    const log = path.join(OUT, 'ffmpeg-split-error-' + Date.now() + '.log');
    fs.writeFileSync(log, `ffmpeg=${ffmpegBin()}\nstatus=${r.status}\nstdout=${r.stdout||''}\nstderr=${r.stderr||''}`, 'utf8');
    throw new Error('ffmpeg_split_failed: ' + log);
  }
  return files.sort();
}

function objectToPromptText(x){
  if (!x) return '';
  if (typeof x === 'string') return x;
  if (x.prompt) return String(x.prompt);
  const parts=[];
  if (x.sceneNumber) parts.push(`Scene ${String(x.sceneNumber).padStart(2,'0')}`);
  if (x.title) parts.push(`Title: ${x.title}`);
  if (x.description) parts.push(`Description: ${x.description}`);
  for (const [k,v] of Object.entries(x)) {
    if (['sceneNumber','title','description','prompt'].includes(k)) continue;
    if (v !== undefined && v !== null && typeof v !== 'object') parts.push(`${k}: ${v}`);
  }
  return parts.join(' | ');
}
function cleanPromptText(t){ return String(t||'').replace(/[{}\\/]/g,'').replace(/\s+/g,' ').trim(); }
function normalizePromptArray(parsed){
  let arr=[];
  if (Array.isArray(parsed)) arr=parsed.map(objectToPromptText);
  else if (parsed && Array.isArray(parsed.scenes)) arr=parsed.scenes.map(objectToPromptText);
  else if (parsed && Array.isArray(parsed.prompts)) arr=parsed.prompts.map(objectToPromptText);
  else if (parsed && typeof parsed === 'object') arr=[objectToPromptText(parsed)];
  else arr=[String(parsed || '')];
  return arr.map(cleanPromptText).filter(Boolean);
}
function splitLongPromptText(text, count, dialog, subtitles){
  const clean=String(text||'').replace(/\s+/g,' ').trim();
  const parts=[];
  if(!clean) return parts;
  const sentences=clean.match(/[^.!?]+[.!?]*/g)||[clean];
  const per=Math.max(1, Math.ceil(sentences.length/count));
  for(let i=0;i<count;i++){
    const chunk=sentences.slice(i*per,(i+1)*per).join(' ').trim() || clean;
    parts.push(`Scene ${String(i+1).padStart(2,'0')} – Story Beat | Character 1: based on the original text | Character 2: based on the original text | Style: follow the provided style JSON | Character voices: match the original audio | Camera: cinematic shot for this beat | Setting: faithful to the original story | Mood: consistent with this moment | Audio cues: match the narration | Dialog: ${dialog?'include if present in original':'none'} | ${subtitles?'Subtitles ON':'Subtitles OFF'} | Content: ${chunk}`);
  }
  return parts;
}

ipcMain.handle('audio:info', async(_e,p={})=>{ try{ if(!p.file)return {ok:false,error:'missing_file'}; return {ok:true,...promptCountFromDuration(p.file,p.chunkSeconds)}; }catch(e){ return {ok:false,error:String(e.message||e)}; } });

ipcMain.handle('audio:process', async(_e,p={})=>{
  try{
    ensure(); if(!parseKeys(p.apiKeys||p.apiKey).length) return {ok:false,error:'missing_api_key'}; if(!p.audioFile) return {ok:false,error:'missing_audio'};
    const autoCountInfo=promptCountFromDuration(p.audioFile, Number(p.chunkSeconds||8));
    let chunks=[];
    let splitWarning='';
    try {
      chunks=splitAudio(p.audioFile, Number(p.chunkSeconds||30));
    } catch (splitErr) {
      splitWarning=String(splitErr.message||splitErr);
      chunks=[p.audioFile];
    }
    const transcripts=[];
    const mode=String(p.transcriptionMode||'gemini');
    if(mode==='localWhisper'){
      const t=await localWhisperTranscribe(p.audioFile);
      transcripts.push(t);
      splitWarning = splitWarning ? splitWarning + ' | local_whisper_used' : 'local_whisper_used';
    }else{
      try{
        const data=fs.readFileSync(p.audioFile).toString('base64');
        const t=await gemini(p.apiKeys||p.apiKey, [{inlineData:{mimeType:mime(p.audioFile),data}}, {text:'Transcribe and translate this full audio file into clean English text. The audio may be in any language. Preserve meaning, names, numbers, tone, and scene order. Return clean translated text only.'}], 'You are a multilingual speech transcription and translation system. Transcribe the audio and translate it to English faithfully. Return only the translated transcript, no explanations.', false, 0);
        transcripts.push(t);
      }catch(fullErr){
        splitWarning = splitWarning ? splitWarning + ' | full_audio_transcribe_failed: ' + String(fullErr.message||fullErr) : 'full_audio_transcribe_failed: ' + String(fullErr.message||fullErr);
        for(let i=0;i<chunks.length;i++){
          const data=fs.readFileSync(chunks[i]).toString('base64');
          const t=await gemini(p.apiKeys||p.apiKey, [{inlineData:{mimeType:mime(chunks[i]),data}}, {text:`Transcribe and translate this audio chunk ${i+1}/${chunks.length} into clean English text. Preserve meaning and scene order. Return clean translated text only.`}], 'You are a multilingual speech transcription and translation system. Transcribe the audio and translate it to English faithfully. Return only the translated transcript, no explanations.', false, i);
          transcripts.push(t);
        }
      }
    }
    const raw=transcripts.join('\n');
    const desiredCount=Math.max(1, Number(p.targetPromptCount||autoCountInfo.promptCount||chunks.length)||chunks.length);
    console.log('[audio-prompt] desiredCount=', desiredCount, 'target=', p.targetPromptCount, 'auto=', autoCountInfo.promptCount, 'chunks=', chunks.length, 'duration=', autoCountInfo.durationSeconds);
    const sys=`You are a professional video prompt engineer. Your output MUST be a JSON array containing EXACTLY ${desiredCount} scene strings. ALL output text, including titles, descriptions, labels, camera notes, dialog notes, and subtitle notes, MUST be in ENGLISH only. Create exactly ${desiredCount} prompts/scenes. Do not create fewer or more. Each scene must strictly follow this exact string format: Scene 01 – Short Title | Character 1: full visual description and action pose | Character 2: [None] or full visual description | Style: full style description | Character voices: [None] or voice description | Camera: shot type | Setting: visual background and props | Mood: mood words | Audio cues: sound effects | Dialog: [None] or exact English dialog | Subtitles OFF or Subtitles ON. Use the exact labels: Character 1, Character 2, Style, Character voices, Camera, Setting, Mood, Audio cues, Dialog. Do not output JSON objects. Do not output braces. Each array item must be one clean scene string. Preserve the SAME SYSTEM, storyline, structure, characters, scene order, events, meaning, and emotional intent from the original text. Do not invent a different story. Do not change the topic, character roles, sequence of events, or core message. If the original text is Vietnamese, translate the meaning faithfully into natural English prompts. Respect the user Style JSON. Dialog enabled: ${p.dialog?'yes':'no'}. Subtitles enabled: ${p.subtitles?'yes':'no'}. Apply extra prompt requirements if provided, but never override the original content. Compare the translated audio transcript with the original text if provided. The audio may be in a different language from the original text. Use BOTH sources: preserve the audio timing/order and preserve the original text meaning. If they differ, keep the core meaning of the original text but respect important details heard in the audio. Then generate final English prompts faithful to both sources.`;
    const prompt=`STYLE JSON:\n${p.styleJson||''}\n\nORIGINAL TEXT:\n${p.originalText||''}\n\nEXTRA PROMPT REQUIREMENTS:\n${p.extraRequirement||''}\n\nAUDIO TRANSCRIPT TRANSLATED TO ENGLISH:\n${raw}\n\nGenerate final prompts in ENGLISH only. Output must be a JSON array of strings only, not objects. Each string must match this format exactly: Scene 01 – Short Title | Character 1: ... | Character 2: [None] | Style: ... | Character voices: [None] | Camera: ... | Setting: ... | Mood: ... | Audio cues: ... | Dialog: [None] | Subtitles OFF. Preserve the same system, storyline, scene order, meaning, characters, and emotional intent as the original text. Do not rewrite into a different concept.`;
    const out=await gemini(p.apiKeys||p.apiKey, [{text:prompt}], sys, true, chunks.length);
    let parsed; try { parsed=JSON.parse(out.replace(/^```json\s*|```$/g,'')); } catch { parsed=out; }
    let arr=normalizePromptArray(parsed).filter(Boolean);
    if(arr.length===1 && desiredCount>1) arr=splitLongPromptText(arr[0], desiredCount, p.dialog, p.subtitles);
    if(arr.length>desiredCount) arr=arr.slice(0,desiredCount);
    while(arr.length<desiredCount){
      const source=raw || p.originalText || 'the original story';
      arr.push(...splitLongPromptText(source, desiredCount-arr.length, p.dialog, p.subtitles));
      if(arr.length>desiredCount) arr=arr.slice(0,desiredCount);
    }
    const resultFile=path.join(OUT,'audio-prompts-'+Date.now()+'.json'); arr=arr.map(cleanPromptText);
    fs.writeFileSync(resultFile, JSON.stringify(arr,null,2), 'utf8');
    const transcriptFile=path.join(OUT,'transcript-'+Date.now()+'.txt'); fs.writeFileSync(transcriptFile, raw, 'utf8');
    return {ok:true,count:Array.isArray(arr)?arr.length:1,prompts:arr,resultFile,transcriptFile,splitWarning,durationSeconds:autoCountInfo.durationSeconds,cutSeconds:autoCountInfo.cutSeconds,autoPromptCount:autoCountInfo.promptCount};
  }catch(e){ return {ok:false,error:String(e.message||e)}; }
});
