const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const installerFfmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { GoogleAuth } = require('google-auth-library');

const isDev = !app.isPackaged;
const BASE = path.join(os.homedir(), '.audio-prompt-studio');
const OUT = path.join(BASE, 'output');
const CFG = path.join(BASE, 'config.json');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function isRetryableError(data) {
  const code = data?.error?.code;
  const status = data?.error?.status;
  return code === 429 || code === 500 || code === 502 || code === 503 || code === 504 || status === 'UNAVAILABLE' || status === 'RESOURCE_EXHAUSTED';
}

function fallbackModels(apiType, model) {
  const list = apiType === 'openai'
    ? ['gpt-4o-mini', 'gpt-4o']
    : ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-2.0-flash'];
  return [model, ...list.filter(m => m !== model)];
}

async function getVertexToken(keyPath) {
  const auth = new GoogleAuth({
    keyFile: keyPath,
    scopes: 'https://www.googleapis.com/auth/cloud-platform',
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

async function callApiGeneric({ bot, prompt }) {
  const { apiType, baseUrl, apiKeys, keyIndex, serviceAccountPath, geminiBaseUrl, openaiBaseUrl, systemInstruction } = bot;
  const keys = Array.isArray(apiKeys) && apiKeys.length ? apiKeys : (typeof apiKeys === 'string' ? apiKeys.split(/[\n,;]+/).map(x=>x.trim()).filter(Boolean) : ['']);
  const models = fallbackModels(apiType, bot.model || (apiType === 'openai' ? 'gpt-4o-mini' : 'gemini-2.0-flash'));
  let lastData = null;

  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const apiKey = keys[((keyIndex || 0) + attempt) % keys.length];
      try {
        let url, headers, body;
        
        if (apiType === 'gemini') {
          const base = (geminiBaseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
          url = `${base}/v1beta/models/${model}:generateContent?key=${apiKey}`;
          headers = { 'Content-Type': 'application/json' };
          body = JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: (systemInstruction || '') + "\n\n" + prompt }] }],
            generationConfig: { temperature: 0.1, topP: 0.1, topK: 1 }
          });
        } else if (apiType === 'gateway') {
          const base = (baseUrl || 'https://fisher-fare-wiley-travelling.trycloudflare.com').replace(/\/$/, '');
          url = `${base}/v1beta/models/${model}:generateContent?key=${apiKey}`;
          headers = { 'Content-Type': 'application/json' };
          body = JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: (systemInstruction || '') + "\n\n" + prompt }] }],
            generationConfig: { temperature: 0.1, topP: 0.1, topK: 1 }
          });
        } else if (apiType === 'vertex') {
          const token = await getVertexToken(serviceAccountPath);
          const keyData = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
          url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${keyData.project_id}/locations/us-central1/publishers/google/models/${model}:generateContent`;
          headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
          body = JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: (systemInstruction || '') + "\n\n" + prompt }] }],
            generationConfig: { temperature: 0.1, topP: 0.1, topK: 1 }
          });
        } else if (apiType === 'openai') {
          url = `${(openaiBaseUrl || 'https://api.openai.com').replace(/\/$/, '')}/v1/chat/completions`;
          headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
          body = JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemInstruction || '' },
              { role: 'user', content: prompt }
            ],
            temperature: 0.1
          });
        }

        const response = await fetch(url, { method: 'POST', headers, body });
        const data = await response.json();
        lastData = data;
        if (!data?.error) {
          if (model !== bot.model) data._fallbackModelUsed = model;
          return data;
        }
        if (!isRetryableError(data)) return data;
        await sleep(1500 * (attempt + 1));
      } catch (error) {
        lastData = { error: error.message };
        await sleep(1000 * (attempt + 1));
      }
    }
  }
  return lastData || { error: 'All retries failed.' };
}

ipcMain.handle('audio:call-api', async (event, { bot, prompt }) => {
  return await callApiGeneric({ bot, prompt });
});

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
    console.error('[audio:process] Error:', e); return {ok:false,error: String(e.stack || e.message || e)};
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
function validateBotIdentity(bot){
  const apiType = bot.apiType || 'gemini';
  if (apiType === 'localWhisper') return null;
  if (apiType === 'vertex') {
    if (!bot.serviceAccountPath) return 'Thiếu Service Account JSON cho Vertex OAuth. Hãy chọn file JSON rồi bấm Lưu cấu hình.';
    if (!fs.existsSync(bot.serviceAccountPath)) return `Không tìm thấy Service Account JSON: ${bot.serviceAccountPath}`;
    return null;
  }
  const keys = parseKeys(bot.apiKeys || bot.apiKey);
  if (!keys.length) {
    if (apiType === 'gemini') return 'Thiếu Gemini API Key. Hãy nhập key ở mục Gemini Keys rồi bấm Lưu cấu hình.';
    if (apiType === 'gateway') return 'Thiếu Gateway API Key. Hãy nhập key ở mục Gateway Keys rồi bấm Lưu cấu hình.';
    if (apiType === 'openai') return 'Thiếu OpenAI API Key. Hãy nhập key ở mục OpenAI Keys rồi bấm Lưu cấu hình.';
    return 'Thiếu API Key.';
  }
  return null;
}

function mediaDurationSeconds(file){
  try{
    const r=runFfmpeg(['-hide_banner','-i',file]);
    const text=(r.stderr||'')+'\n'+(r.stdout||'');
    const m=text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if(m) return Number(m[1])*3600 + Number(m[2])*60 + Number(m[3]);
  }catch{}
  return 0;
}

function promptCountFromDuration(file, seconds){
  if(!file) return {durationSeconds:0, cutSeconds:Number(seconds||8), promptCount:1};
  const duration=mediaDurationSeconds(file);
  const cut=Math.max(1, Number(seconds||8)||8);
  return {durationSeconds:duration, cutSeconds:cut, promptCount:duration?Math.ceil(duration/cut):0};
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
    parts.push(`Scene ${String(i+1).padStart(2,'0')} – Part ${i+1} | Setting: ${chunk} | Style: Cinematic | Character: Main Subject | Action: Unique visual moment based on this scene segment | Subtitles ${subtitles?'ON':'OFF'} | Dialog: ${dialog?chunk:'[None]'}`);
  }
  return parts;
}

ipcMain.handle('audio:info', async(_e,p={})=>{ try{ if(!p.file)return {ok:false,error:'missing_file'}; return {ok:true,...promptCountFromDuration(p.file,p.chunkSeconds)}; }catch(e){ return {ok:false,error: String(e.message)}; } });

ipcMain.handle('audio:process', async(_e,p={})=>{
  try{
    ensure();
    const bot = {
      apiType: p.apiType || p.transcriptionMode || 'gemini',
      baseUrl: p.baseUrl,
      apiKeys: p.apiKeys || p.apiKey,
      serviceAccountPath: p.serviceAccountPath,
      geminiBaseUrl: p.geminiBaseUrl,
      openaiBaseUrl: p.openaiBaseUrl,
      model: p.model
    };
    const identityError = validateBotIdentity(bot);
    if (identityError) throw new Error(identityError);

    const autoCountInfo=promptCountFromDuration(p.audioFile, Number(p.chunkSeconds||8));
    let transcripts=[];
    if(p.audioFile) {
      if (bot.apiType === 'localWhisper') throw new Error('Local Whisper chưa được đóng gói trong bản setup này. Hãy chọn Gemini Direct, Gateway AI hoặc Vertex OAuth và nhập key/service account hợp lệ.');
      const tData = await callApiGeneric({ 
        bot: { ...bot, systemInstruction: 'You are a professional transcriber. You MUST translate the audio content to ENGLISH.' }, 
        prompt: `Transcribe and translate this audio content precisely to ENGLISH language.` 
      });
      if (tData.error) throw new Error("Transcription API Error: " + (tData.error.message || JSON.stringify(tData.error)));
      transcripts.push(tData?.choices?.[0]?.message?.content || tData?.candidates?.[0]?.content?.parts?.[0]?.text || "");
    } else {
      transcripts.push("[No audio provided, using original text only]");
    }
    const raw=transcripts.join('\n');
    const desiredCount=Math.max(1, Number(p.targetPromptCount||autoCountInfo.promptCount||1));
    const subtitlesState = p.subtitles ? 'ON' : 'OFF';
    const dialogState = p.dialog ? 'ON' : 'OFF';
    const extraRequirement = String(p.extraRequirement || '').trim();
    const characterSyncEnabled = /character|nhân vật|nhan vat|đồng bộ|dong bo|consistent|sync|same character|character bible/i.test(extraRequirement);
    
    const sys=`You are a high-fidelity AI translator and video prompt engineer.
CRITICAL MANDATE: YOUR ENTIRE OUTPUT MUST BE IN ENGLISH.

CORE TASK:
Transform the source text into professional video prompts using the EXACT structure below:
Scene XX – [Scene Title] | Setting: [Background/Environment] | Style: [Visual Style] | Character: [Character Details] | Action: [Unique Scene Action] | Subtitles ${subtitlesState}: [English subtitle text or [None]] | Dialog: [English Dialog or [None]]

FIDELITY RULES:
1. Preserve all key details, names, and plot points from the source.
2. If the input is non-English, translate it accurately to English first.
3. NO Japanese, Vietnamese, or other non-English characters allowed in output.
4. If a field has no content, use [None].
5. DO NOT repeat the same Setting, Character pose, Action, or Dialog across scenes.
6. Each scene must advance the source content with a distinct visual moment.
7. Apply the user's EXTRA REQUIREMENTS exactly when provided.
8. Subtitles field must be exactly "Subtitles ${subtitlesState}: ...". If subtitles are OFF, use "Subtitles OFF: [None]". If subtitles are ON, create concise English subtitle text matching that scene's source content.
9. Dialog is ${dialogState}. If dialog is OFF, use "Dialog: [None]". If dialog is ON, write English dialog matching the source content.
10. CHARACTER SYNC MODE is ${characterSyncEnabled ? 'ON' : 'OFF'}. When ON, extract the character description from EXTRA REQUIREMENTS and reuse the exact same identity across every scene. Keep age, gender, ethnicity, face, hair, outfit, body type, and signature accessories consistent. Only change pose/action/expression when needed. Do not invent a different character in later scenes.`;

    const promptReq = `[STRICT STRUCTURE MODE]
Transform this text into exactly ${desiredCount} English prompts.

STRUCTURE TO FOLLOW FOR EACH PROMPT:
Scene XX – [Scene Title] | Setting: [Background/Environment] | Style: [Visual Style] | Character: [Character Details] | Action: [Unique Scene Action] | Subtitles ${subtitlesState}: [English subtitle text or [None]] | Dialog: [English Dialog or [None]]

SOURCE TEXT:
"${p.originalText || raw}"

STYLE & CONTEXT:
${p.styleJson||'{}'}

EXTRA REQUIREMENTS FROM USER:
${extraRequirement || '[None]'}

CHARACTER SYNC MODE:
${characterSyncEnabled ? 'ON — Treat EXTRA REQUIREMENTS as the locked character bible. Repeat the same core character identity in the Character field of every scene. Do not change the character unless the source explicitly introduces another character.' : 'OFF — Use characters from the source text normally.'}

SPECIFICATIONS:
- Required order: Setting → Style → Character → Action → Subtitles → Dialog.
- Apply EXTRA REQUIREMENTS exactly if not [None].
- Subtitles must be exactly ${subtitlesState}. ${p.subtitles ? 'Write concise English subtitle text that matches each scene.' : 'Use Subtitles OFF: [None] for every scene.'}
- Dialog must be exactly ${dialogState}. ${p.dialog ? 'Write English dialog that matches the source content.' : 'Use Dialog: [None] for every scene.'}
- If CHARACTER SYNC MODE is ON, every scene's Character field must contain the same locked character identity from EXTRA REQUIREMENTS, with only pose/action/expression allowed to vary.
- No repeated sentences between scenes.
- No repeated visual description between scenes unless the source explicitly requires it.
- Language: 100% English.
- Return a JSON array of strings.`;

    const outData = await callApiGeneric({ bot: { ...bot, systemInstruction: sys }, prompt: promptReq });
    
    if (outData.error) {
      throw new Error(`API Error (${bot.apiType}): ` + (outData.error.message || JSON.stringify(outData.error)));
    }

    const out = outData?.choices?.[0]?.message?.content || outData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!out) throw new Error("API returned empty content.");

    let parsed; try { parsed=JSON.parse(out.replace(/^```json\s*|```$/g,'')); } catch { parsed=out; }
    let arr=normalizePromptArray(parsed).filter(Boolean);
    
    if(arr.length===1 && desiredCount>1) arr=splitLongPromptText(arr[0], desiredCount, p.dialog, p.subtitles);
    if(arr.length>desiredCount) arr=arr.slice(0,desiredCount);
    if (arr.length === 0) throw new Error("Failed to generate any prompts.");

    const resultFile=path.join(OUT,'audio-prompts-'+Date.now()+'.json');
    fs.writeFileSync(resultFile, JSON.stringify(arr,null,2), 'utf8');
    return {ok:true, prompts:arr, resultFile, transcript: raw};
  }catch(e){ 
    console.error("[audio:process] Error:", e);
    return {ok:false,error: String(e.message)}; 
  }
});
