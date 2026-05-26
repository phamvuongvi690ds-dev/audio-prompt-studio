import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Copy, Download, FileText, Upload } from 'lucide-react';
import './style.css';

declare global { interface Window { studioAPI: any } }

const api = () => window.studioAPI || {
  openFile: async () => [],
  process: async () => ({ ok:false, error:'api_not_ready' }),
  info: async () => ({ ok:false, error:'api_not_ready' }),
  saveConfig: async () => ({}),
  loadConfig: async () => ({}),
  saveText: async () => ({ ok:false, error:'api_not_ready' }),
  readText: async () => ({ ok:false, error:'api_not_ready' }),
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function onlyDigits(value: string) {
  return value.replace(new RegExp('[^0-9]', 'g'), '');
}

function App() {
  const [apiKey, setApiKey] = useState('');
  const [styleJson, setStyleJson] = useState('');
  const [audioFile, setAudioFile] = useState('');
  const [transcriptionMode, setTranscriptionMode] = useState('localWhisper');
  const [chunkSeconds, setChunkSeconds] = useState('8');
  const [targetPromptCount, setTargetPromptCount] = useState('');
  const [originalText, setOriginalText] = useState('');
  const [extraRequirement, setExtraRequirement] = useState('');
  const [dialog, setDialog] = useState(false);
  const [subtitles, setSubtitles] = useState(false);
  const [status, setStatus] = useState('Sẵn sàng');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<any[]>([]);
  const [autoInfo, setAutoInfo] = useState<any>(null);

  useEffect(() => {
    api().loadConfig().then((c: any) => {
      setApiKey(c.apiKeys || c.apiKey || '');
      setStyleJson(c.styleJson || '');
      setTranscriptionMode(c.transcriptionMode || 'localWhisper');
    });
  }, []);

  async function refreshInfo(file = audioFile, seconds = chunkSeconds) {
    if (!file) return;
    const info = await api().info({ file, chunkSeconds: seconds });
    if (info?.ok) { setAutoInfo(info); if (info.promptCount) setTargetPromptCount(String(info.promptCount)); }
  }

  async function loadOriginalTxt() {
    const r = await api().openFile({
      properties: ['openFile'],
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    if (r?.[0]) {
      const loaded = await api().readText({ filePath: r[0] });
      if (loaded?.ok) {
        setOriginalText(loaded.text || '');
        setStatus(`Đã tải văn bản gốc: ${loaded.filePath}`);
      } else {
        setStatus(`Lỗi tải TXT: ${loaded?.error || 'unknown_error'}`);
      }
    }
  }

  async function pickAudio() {
    const r = await api().openFile({
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a'] }],
    });
    if (r?.[0]) {
      setAudioFile(r[0]);
      await refreshInfo(r[0], chunkSeconds);
    }
  }


  async function save() {
    await api().saveConfig({ apiKeys: apiKey, styleJson, transcriptionMode });
    setStatus('Đã lưu cấu hình');
  }


  function promptText() {
    if (!Array.isArray(result) || !result.length) return '';
    return result.map((x: any, i: number) => typeof x === 'string' ? x : (x?.prompt || x?.text || JSON.stringify(x))).join('\n');
  }

  async function copyPrompts() {
    const text = promptText();
    if (!text) { setStatus('Chưa có prompt để copy'); return; }
    await navigator.clipboard.writeText(text);
    setStatus(`Đã copy ${result.length} prompt`);
  }

  async function downloadTxt() {
    const text = promptText();
    if (!text) { setStatus('Chưa có prompt để tải'); return; }
    const r = await api().saveText({ defaultPath: `audio-prompts-${Date.now()}.txt`, text });
    setStatus(r?.ok ? `Đã lưu TXT: ${r.filePath}` : 'Đã huỷ lưu TXT');
  }

  async function run() {
    setStatus('Đang khởi tạo...');
    setProgress(5);
    
    // Nếu không có audio, mặc định tạo 1 prompt từ văn bản gốc
    let promptCount = targetPromptCount;
    if (!promptCount) {
      if (audioFile) {
        const info = await api().info({ file: audioFile, chunkSeconds });
        if (info?.ok && info.promptCount) {
          promptCount = String(info.promptCount);
          setTargetPromptCount(promptCount);
        }
      } else {
        promptCount = "1";
        setTargetPromptCount("1");
      }
    }
    
    setStatus('Đang xử lý âm thanh và văn bản (có thể mất vài phút)...');
    setProgress(30);

    const r = await api().process({
      apiKeys: apiKey,
      styleJson,
      audioFile,
      transcriptionMode,
      chunkSeconds,
      targetPromptCount,
      originalText,
      extraRequirement,
      dialog,
      subtitles,
    });
    
    if (r?.prompts) {
      setResult(r.prompts);
      setProgress(100);
    }
    
    if (r?.ok) {
      setStatus(`Hoàn tất: ${r.count} scene • ${r.resultFile}`);
      setAutoInfo({ durationSeconds: r.durationSeconds, cutSeconds: r.cutSeconds, promptCount: r.autoPromptCount });
    } else {
      setProgress(0);
      setStatus(`LỖI CHI TIẾT: ${r?.error}`);
    }
  }

  return (
    <div className="app modern">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>Audio Prompt Studio</h1>
          <p>Dịch Audio & Tạo Prompt AI</p>
        </div>
        
        <div className="sidebar-content">
          <Field label="Loại API">
            <select value={transcriptionMode} onChange={e => setTranscriptionMode(e.target.value)}>
              <option value="gateway">Gateway AI</option>
              <option value="gemini">Gemini Direct</option>
              <option value="vertex">Vertex OAuth</option>
              <option value="openai">OpenAI</option>
              <option value="localWhisper">Local Whisper</option>
            </select>
          </Field>

          {transcriptionMode === 'gateway' && (
            <Field label="Gateway Keys">
              <textarea className="smallarea" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Nhập API Keys..." />
            </Field>
          )}

          {transcriptionMode === 'gemini' && (
            <Field label="Gemini Keys">
              <textarea className="smallarea" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Nhập Gemini Keys..." />
            </Field>
          )}

          {transcriptionMode === 'openai' && (
            <Field label="OpenAI Keys">
              <textarea className="smallarea" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Nhập OpenAI Keys..." />
            </Field>
          )}
          
          <div className="inline-fields">
            <Field label="Lời thoại">
              <select value={dialog ? 'yes' : 'no'} onChange={e => setDialog(e.target.value === 'yes')}>
                <option value="no">Không</option><option value="yes">Có</option>
              </select>
            </Field>
            <Field label="Phụ đề">
              <select value={subtitles ? 'yes' : 'no'} onChange={e => setSubtitles(e.target.value === 'yes')}>
                <option value="no">Không</option><option value="yes">Có</option>
              </select>
            </Field>
          </div>

          <Field label="Phong cách JSON">
            <textarea className="mediumarea" value={styleJson} onChange={e => setStyleJson(e.target.value)} placeholder="Dán style_analysis JSON..." />
          </Field>

          <Field label="Yêu cầu thêm">
            <textarea className="mediumarea" value={extraRequirement} onChange={e => setExtraRequirement(e.target.value)} placeholder="Ví dụ: điện ảnh, không chữ..." />
          </Field>
        </div>

        <div className="sidebar-footer">
          <button className="primary-btn" onClick={run}>✨ Bắt đầu tạo prompt</button>
          <button className="soft-btn" onClick={save}>💾 Lưu cấu hình</button>
        </div>
      </aside>

      <main className="main-content">
        <div className="main-grid">
          <section className="card audio-card">
            <div className="card-header">
              <h2><Upload size={16}/> Audio đầu vào</h2>
              <button className="action-btn" onClick={pickAudio}>Chọn file</button>
            </div>
            <div className="audio-info">
              <p className="file-path">{audioFile || 'Chưa có file audio...'}</p>
              <div className="info-badges">
                <span className="badge">⏱️ {autoInfo?.durationSeconds ? Math.round(autoInfo.durationSeconds) + 's' : '--'}</span>
                <span className="badge">📋 {targetPromptCount || (autoInfo?.promptCount ? String(autoInfo.promptCount) : '--')} prompt</span>
                <div className="badge-input">
                  <span>Cắt:</span>
                  <input value={chunkSeconds} onChange={async e => { const v = onlyDigits(e.target.value); setChunkSeconds(v); await refreshInfo(audioFile, v); }} />
                  <span>s</span>
                </div>
              </div>
            </div>
          </section>

          <section className="card text-card">
            <div className="card-header"><h2>📝 Văn bản gốc</h2><button className="action-btn" onClick={loadOriginalTxt}><FileText size={14}/> Tải TXT</button></div>
            <textarea value={originalText} onChange={e => setOriginalText(e.target.value)} placeholder="Dán văn bản gốc ở đây để AI bám sát nội dung..." />
          </section>

          <section className="card result-card">
            <div className="card-header">
              <h2>🚀 Kết quả prompt</h2>
              <div className="header-actions">
                <button className="icon-btn" onClick={copyPrompts} title="Copy"><Copy size={16}/></button>
                <button className="icon-btn" onClick={downloadTxt} title="Tải về"><Download size={16}/></button>
              </div>
            </div>
            <div className="status-bar">
              <div className="status-text">{status}</div>
              {progress > 0 && progress < 100 && (
                <div className="progress-container">
                  <div className="progress-bar" style={{ width: `${progress}%` }}></div>
                </div>
              )}
            </div>
            <pre className="result-display">{promptText() || 'Chưa có kết quả...'}</pre>
          </section>
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App/>);
