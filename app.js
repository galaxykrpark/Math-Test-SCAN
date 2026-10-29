const MAX_SCANS = 10;
const MAX_SCAN_BYTES = 30 * 1024 * 1024; // 폰 카메라 원본도 받을 수 있게 넉넉히 둡니다. (받은 뒤 줄여서 저장)
const ACADEMY_KEY = 'oneclick-point-academy';
const SCHOOL_GRADES = GRADES.filter((g) => g !== '고등'); // 초1 ~ 중3

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (x) => String(+(+x).toFixed(1));
// 마지막 글자에 받침이 있는지 (이/가 고르기용: 'AI 앱이', '제미나이가'). 한글이 아니면 받침 없음으로 봅니다.
const hasBatchim = (s) => { const c = String(s).trim().slice(-1).charCodeAt(0) - 0xAC00; return c >= 0 && c <= 11171 && c % 28 > 0; };

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// 홈 화면에 설치한 앱이 인터넷 없이도 열리도록 화면 파일을 저장해 둡니다.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

/* ---------- AI 선택 ---------- */
function renderToolPick() {
  $('#toolPick').innerHTML = Object.entries(AI_TOOLS).map(([id, t]) => `
    <label class="tool ${aiSettings.tool === id ? 'on' : ''}">
      <input type="radio" name="aiTool" value="${id}" ${aiSettings.tool === id ? 'checked' : ''}>
      <span class="tool-ico">${t.icon}</span><b>${esc(t.label)}</b>
      <small>${aiSettings.keys[id] ? '🔑 키 있음' : '키 없음'}</small>
    </label>`).join('');
  document.querySelectorAll('input[name="aiMode"]').forEach((r) => { r.checked = r.value === aiSettings.mode; });
  const tool = currentTool();
  $('#keyBox').classList.toggle('hidden', !useApi());
  $('#keyLabel').textContent = `${tool.label} API 키`;
  $('#keyNote').textContent = `(${tool.keyHint})`;
  $('#keyLink').href = tool.keyUrl;
  $('#apiKey').value = aiSettings.keys[aiSettings.tool] || '';
  $('#apiModel').value = aiSettings.models[aiSettings.tool] || '';
  $('#apiModel').placeholder = `기본: ${tool.model}`;
  $('#aiPill').textContent = useApi() ? `🔑 ${tool.label}` : '📲 AI 앱';
}

$('#toolPick').addEventListener('change', (e) => {
  aiSettings.tool = e.target.value;
  saveAiSettings();
  renderToolPick();
  clearHandoffs();
});
document.querySelectorAll('input[name="aiMode"]').forEach((r) => r.addEventListener('change', () => {
  aiSettings.mode = r.value;
  saveAiSettings();
  renderToolPick();
  clearHandoffs();
  prepareGradeFiles();
}));
$('#apiKey').addEventListener('change', (e) => {
  aiSettings.keys[aiSettings.tool] = e.target.value.trim();
  saveAiSettings();
  renderToolPick();
  if (e.target.value.trim()) toast(`${currentTool().label} 키를 이 폰에 저장했어요.`);
});
$('#apiModel').addEventListener('change', (e) => {
  aiSettings.models[aiSettings.tool] = e.target.value.trim();
  saveAiSettings();
  renderToolPick();
});
$('#btnKeyShow').addEventListener('click', () => {
  const input = $('#apiKey');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('#btnKeyShow').textContent = input.type === 'password' ? '보기' : '숨기기';
});
$('#aiPill').addEventListener('click', () => $('#step0').scrollIntoView({ behavior: 'smooth' }));
renderToolPick();

/* ---------- 학생 정보 ---------- */
const DEFAULT_ACADEMY = '양덕롯데캐슬교실';
try { $('#academyName').value = localStorage.getItem(ACADEMY_KEY) || DEFAULT_ACADEMY; } catch {}
$('#academyName').addEventListener('change', (e) => {
  try { localStorage.setItem(ACADEMY_KEY, e.target.value.trim()); } catch {}
});

const studentInfo = () => ({
  academy: $('#academyName').value.trim(),
  student: $('#studentName').value.trim(),
  teacher: $('#teacherName').value.trim(),
  period: $('#reportPeriod').value.trim(),
});

/* ---------- 작업 저장 ----------
   AI 앱에 다녀오거나 AI 답을 공유받으면 폰이 이 앱을 새로 열 수 있어서,
   학생 정보·사진·채점 결과·기다리는 중인 요청을 폰(IndexedDB)에 저장해 두고 다시 열 때 이어 갑니다. */
const SESSION_DB = 'onemath2-session';
const SESSION_HOURS = 12; // 이보다 오래된 작업은 이어 가지 않습니다.
let restoring = true; // 저장해 둔 작업을 되살리는 동안은 저장하지 않습니다.
let saveTimer;

function sessionStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(SESSION_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

function saveSession() {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = { savedAt: Date.now(), info: studentInfo(), scans, keys, origs, examScore, practice, pending };
    sessionStore('readwrite', (s) => s.put(data, 'session')).catch(() => {});
  }, 300);
}
['studentName', 'teacherName', 'reportPeriod'].forEach((id) => $(`#${id}`).addEventListener('change', saveSession));

/* ---------- 학생 시험지 · 답안지(정답) · 시험지 원문 사진 ---------- */
const scans = []; // 학생 시험지 { id, name, dataUrl }
const keys = []; // 답안지(정답) { id, name, dataUrl } — 채점할 때 정답 확인용으로 함께 보냅니다.
const origs = []; // 시험지 원문(빈 시험지) { id, name, dataUrl } — 인쇄된 글과 학생 글씨를 구분하는 데 쓰라고 함께 보냅니다.

function setScanMsg(msg, isError = false) {
  const el = $('#scanMsg');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// 큰 사진은 긴 변 2000px로 줄입니다. (폰 카메라 사진은 4000px 넘게 크고, 그대로 두면 폰 메모리가 모자라요)
// 두 쪽을 한 장에 찍으면 1500px로는 지수(위첨자) 같은 작은 글씨가 뭉개져서 2000px로 둡니다. (원본보다 전송량·비용은 훨씬 적어요)
// 여기서는 품질을 높게(0.9) 두고, 실제로 보낼 때 labelImage에서 한 번만 0.85로 압축합니다. (두 번 낮게 압축하면 글씨가 뭉개져요)
const SHRINK_MAX_SIDE = 2000;
const SEND_JPEG_QUALITY = 0.85;
function shrinkImage(dataUrl, maxSide = SHRINK_MAX_SIDE) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// 사진을 시계 방향으로 90° 돌립니다. (원문·학생 시험지·답안지를 같은 방향으로 세워 보내야 AI가 견주어 보기 쉬워요)
function rotateImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.height;
      canvas.height = img.width;
      const ctx = canvas.getContext('2d');
      ctx.translate(canvas.width, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// AI 앱은 사진의 파일 이름을 못 볼 수 있어서, 사진 위쪽에 "[학생 시험지 1/2]" 같은 띠를 그려 넣습니다.
function labelImage(dataUrl, label) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const band = Math.max(48, Math.round(img.width * 0.05));
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height + band;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = label.startsWith('답안지') ? '#19b38a' : label.startsWith('시험지 원문') ? '#f08c00' : '#16161d';
      ctx.fillRect(0, 0, canvas.width, band);
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(band * 0.55)}px sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText(`[${label}]`, band * 0.3, band / 2);
      ctx.drawImage(img, 0, band);
      resolve(canvas.toDataURL('image/jpeg', SEND_JPEG_QUALITY));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function attachedMsg() {
  const parts = [];
  if (scans.length) parts.push(`시험지 ${scans.length}장`);
  if (keys.length) parts.push(`답안지 ${keys.length}장`);
  if (origs.length) parts.push(`시험지 원문 ${origs.length}장`);
  return parts.length ? `${parts.join(', ')}이 들어왔어요.` : '';
}

// 사진 찍기·앨범에서 고르기·(PC에서는) 끌어다 놓기·지우기가 되는 사진 칸을 만듭니다. (시험지 칸, 답안지 칸, 원문 칸 공용)
function setupImageZone(zone, cameraInput, albumInput, list, store, what) {
  async function addFiles(fileList, fromCamera) {
    const skipped = [];
    for (const file of [...fileList]) {
      if (file.type && !file.type.startsWith('image/')) { skipped.push(`${file.name}(사진 아님)`); continue; }
      if (file.size > MAX_SCAN_BYTES) { skipped.push(`${file.name}(너무 큼)`); continue; }
      if (store.length >= MAX_SCANS) { skipped.push(`${file.name}(최대 ${MAX_SCANS}장)`); continue; }
      try {
        const name = fromCamera ? `${what} ${store.length + 1}` : file.name;
        store.push({ id: crypto.randomUUID(), name, dataUrl: await shrinkImage(await readAsDataUrl(file)) });
      } catch {
        skipped.push(`${file.name}(읽기 실패)`);
      }
    }
    render();
    if (skipped.length) setScanMsg(`추가하지 못한 사진: ${skipped.join(', ')}`, true);
    else setScanMsg(attachedMsg());
    if (fromCamera && !skipped.length) toast(`${what} ${store.length}장째가 들어왔어요. 다음 장은 📷를 다시 누르세요.`);
  }

  function render() {
    list.innerHTML = store.map((s, i) => `
      <li class="thumb" data-id="${s.id}">
        <img src="${s.dataUrl}" alt="${esc(s.name)}">
        <div class="name">${i + 1}. ${esc(s.name)}</div>
        <button type="button" class="rotate" aria-label="${esc(s.name)} 돌리기">↻</button>
        <button type="button" class="remove" aria-label="${esc(s.name)} 삭제">✕</button>
      </li>`).join('');
    zone.classList.toggle('has-files', store.length > 0);
    zone.querySelectorAll('.btn-cam, .btn-album').forEach((b) => { b.disabled = store.length >= MAX_SCANS; });
    resetGrade(); // 시험지·답안지·원문이 바뀌면 이전 채점 결과는 맞지 않으니 지웁니다.
  }

  zone.addEventListener('click', async (e) => {
    const opener = e.target.closest('[data-open]');
    if (opener) return $(`#${opener.dataset.open}`).click();
    const rotateBtn = e.target.closest('.rotate');
    if (rotateBtn) {
      const item = store.find((s) => s.id === rotateBtn.closest('.thumb').dataset.id);
      if (!item) return;
      rotateBtn.disabled = true;
      item.dataUrl = await rotateImage(item.dataUrl);
      render();
      return;
    }
    const removeBtn = e.target.closest('.remove');
    if (removeBtn) {
      const i = store.findIndex((s) => s.id === removeBtn.closest('.thumb').dataset.id);
      if (i >= 0) store.splice(i, 1);
      render();
      setScanMsg(attachedMsg());
    }
  });
  cameraInput.addEventListener('change', () => { addFiles(cameraInput.files, true); cameraInput.value = ''; });
  albumInput.addEventListener('change', () => { addFiles(albumInput.files, false); albumInput.value = ''; });

  // PC 브라우저에서 열었을 때는 끌어다 놓기도 됩니다.
  let dragDepth = 0;
  zone.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; zone.classList.add('dragover'); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  zone.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; zone.classList.remove('dragover'); } });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    zone.classList.remove('dragover');
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files, false);
  });
  return render;
}

const dropzone = $('#dropzone');
const keyDropzone = $('#keyDropzone');
const origDropzone = $('#origDropzone');
const renderScans = setupImageZone(dropzone, $('#scanCamera'), $('#scanInput'), $('#thumbs'), scans, '시험지');
const renderKeys = setupImageZone(keyDropzone, $('#keyCamera'), $('#keyInput'), $('#keyThumbs'), keys, '답안지');
const renderOrigs = setupImageZone(origDropzone, $('#origCamera'), $('#origInput'), $('#origThumbs'), origs, '시험지 원문');
['dragover', 'drop'].forEach((t) => window.addEventListener(t, (e) => {
  if (![dropzone, keyDropzone, origDropzone].some((z) => z.contains(e.target))) e.preventDefault();
}));

/* ---------- 내 폰의 AI 앱으로 보내기 ---------- */
function dataUrlToFile(dataUrl, name) {
  const [head, b64] = dataUrl.split(',');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: head.slice(5, head.indexOf(';')) });
}

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
  return Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* 웹 앱은 다른 앱의 전송 버튼을 대신 누르거나 그 화면을 읽을 수 없어서(폰 보안), 이렇게 이어 줍니다.
   1) 'AI로 점수계산' 한 번에 사진·지시문을 공유 창으로 넘기고, 지시문도 복사해 둡니다.
   2) AI 앱에서 답의 [복사]를 누르고 돌아오면 클립보드를 자동으로 읽어 바로 반영합니다.
      또는 AI 답 글을 선택해 [공유] → onemath2 를 고르면 이 앱이 열리면서 바로 반영합니다. (manifest 의 share_target)
   답을 기다리는 동안의 사진·결과는 폰에 저장해 두어서, 앱이 새로 열려도 이어집니다. (아래 '작업 저장') */
let pending = null; // AI 앱의 답을 기다리는 중: { kind: 'grade'|'practice', text }
let lastClip = ''; // 이미 읽어 본 클립보드 글 (같은 글을 두 번 반영하지 않게)
let awayFromApp = false; // 공유 창이나 AI 앱에 다녀왔을 수 있음 (돌아와 화면을 누르면 클립보드를 읽어 봄)

const handoffBox = (kind) => $(kind === 'practice' ? '#practiceHandoff' : '#gradeHandoff');

function clearHandoffs() {
  $('#gradeHandoff').innerHTML = '';
  $('#practiceHandoff').innerHTML = '';
  pending = null;
  saveSession();
}

// 사진·지시문을 공유 창으로 넘깁니다. 결과: 'shared' | 'aborted' | 'failed' | 'unsupported'
async function shareToApp(files, text) {
  lastClip = text;
  copyText(text); // 공유와 같은 누름 안에서 복사해야 폰이 막지 않습니다.
  const data = files.length ? { files, text, title: 'onemath' } : { text, title: 'onemath' };
  if (!navigator.share || (navigator.canShare && !navigator.canShare(data))) return 'unsupported';
  try {
    await navigator.share(data);
    return 'shared';
  } catch (err) {
    return err.name === 'AbortError' ? 'aborted' : 'failed';
  }
}

function handoffMsg(kind, t, isError = false) {
  const el = $('.handoff-msg', handoffBox(kind));
  if (!el) return toast(t);
  el.textContent = t;
  el.classList.toggle('error', isError);
}

// AI 앱 안내 칸을 그리고, 바로 공유 창을 띄웁니다. (autoSend: 'AI로 점수계산'을 누른 그 자리에서 부를 때)
// files: 보낼 사진 File 목록, text: 지시문, what: 제목에 쓸 말
async function showHandoff(kind, { files, text, what, autoSend = true }) {
  // 어떤 AI 앱을 쓸지는 공유 창에서 고르므로, 앱 열기와 도움말은 모든 AI 앱 것을 보여 줍니다.
  const tools = Object.values(AI_TOOLS);
  const box = handoffBox(kind);
  box.innerHTML = `
    <div class="handoff">
      <p class="handoff-title">📲 AI 앱으로 ${esc(what)}</p>
      <ol class="handoff-steps">
        <li>
          공유 창에서 <b>쓰는 AI 앱</b>(ChatGPT·제미나이·Claude 등)을 고르고, 앱에서 <b>전송</b>을 누르세요.
          <span class="sub">지시문은 복사도 해 두었어요. 앱 입력칸에 글이 없으면 길게 눌러 붙여 넣으세요.</span>
          <div class="handoff-btns">
            <button type="button" class="btn-send">📤 ${autoSend ? '다시 ' : ''}보내기</button>
            <button type="button" class="btn-outline btn-copy">📋 지시문 복사</button>
            ${files.length ? '<button type="button" class="btn-outline btn-save-imgs">💾 사진 저장</button>' : ''}
            ${tools.map((t) => `<a class="btn-outline" href="${t.appUrl}" target="_blank" rel="noopener">↗ ${esc(t.label)} 열기</a>`).join('')}
          </div>
        </li>
        <li>
          답이 다 나오면 답 아래의 <b>복사</b> 버튼을 누르고 이 앱으로 돌아오세요.
          <span class="sub">돌아오면 자동으로 읽어서 반영해요. 답 글을 길게 눌러 선택한 뒤 <b>공유 → onemath2</b> 를 골라도 돼요.</span>
          ${tools.filter((t) => t.returnTip).map((t) => `<span class="sub tool-tip">💡 ${t.returnTip}</span>`).join('')}
        </li>
        <li class="auto-wait">
          <p class="wait-line"><span class="spin">⏳</span> <b>AI 답을 기다리는 중…</b></p>
          <button type="button" class="btn-grade btn-paste">📋 AI 답 붙여넣기</button>
          <details class="more">
            <summary>자동으로 안 들어오면: 직접 붙여넣기</summary>
            <textarea class="handoff-answer" rows="4" placeholder="여기에 AI 답을 길게 눌러 붙여 넣으세요"></textarea>
            <button type="button" class="btn-outline wide btn-apply">✅ 결과 반영</button>
          </details>
        </li>
      </ol>
      <p class="hint handoff-msg" aria-live="polite"></p>
    </div>`;
  const msg = (t, isError) => handoffMsg(kind, t, isError);
  const saveImages = () => files.forEach((f, i) => setTimeout(() => downloadBlob(f, f.name), i * 400));
  const send = async () => {
    const result = await shareToApp(files, text);
    if (result === 'shared' || result === 'unsupported') awayFromApp = true;
    if (result === 'shared') msg('AI 앱에서 전송하고, 답이 나오면 복사해서 돌아와 주세요. 자동으로 반영해요.');
    else if (result === 'aborted') msg('보내기를 닫았어요. 📤 보내기를 다시 눌러 주세요.');
    else if (result === 'failed') msg(`바로 보내지 못했어요. 📤 보내기를 다시 누르거나, '사진 저장'과 '지시문 복사' 후 앱에 직접 넣어 주세요.`, true);
    else {
      // 공유 기능이 없는 브라우저(PC 등): 사진을 저장하고 지시문을 복사합니다. AI는 위의 열기 버튼으로 직접 엽니다.
      if (files.length) saveImages();
      msg(`이 브라우저는 앱으로 바로 보내기를 못 해요. ${files.length ? '사진을 저장하고 ' : ''}지시문을 복사했어요. 위의 ↗ 열기 버튼으로 AI를 열고 ${files.length ? '사진을 올린 뒤 ' : ''}지시문을 붙여 넣어 주세요.`);
    }
  };

  $('.btn-send', box).addEventListener('click', send);
  $('.btn-copy', box).addEventListener('click', async () => {
    lastClip = text;
    msg((await copyText(text)) ? '지시문을 복사했어요. AI 앱 입력칸을 길게 눌러 붙여 넣으세요.' : '복사하지 못했어요.');
  });
  $('.btn-save-imgs', box)?.addEventListener('click', () => { saveImages(); msg('사진을 저장했어요. AI 앱에서 사진을 올려 주세요.'); });
  $('.btn-paste', box).addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      lastClip = t;
      receiveAnswer(t);
    } catch {
      msg('붙여넣기 권한이 없어요. 아래 칸을 길게 눌러 붙여 넣어 주세요.', true);
      $('details.more', box).open = true;
      $('.handoff-answer', box).focus();
    }
  });
  $('.btn-apply', box).addEventListener('click', () => receiveAnswer($('.handoff-answer', box).value));
  if (autoSend) await send();
}

// AI 답 글을 받아 채점 결과나 보충 문제로 반영합니다. 반영하면 true.
// quiet: 클립보드를 자동으로 읽은 경우라, AI 답(JSON)처럼 보이지 않으면 아무 말 없이 넘깁니다.
function receiveAnswer(text, { quiet = false } = {}) {
  const t = String(text || '');
  const kindHint = pending?.kind || 'grade';
  const looksAnswer = /"(questions|sets)"\s*:/.test(t);
  const fail = (m) => { if (!quiet || looksAnswer) handoffMsg(kindHint, m, true); return false; };
  const ownPrompt = '지금 클립보드에는 보낸 지시문이 들어 있어요. AI 답 아래의 복사 버튼을 눌러 주세요.';
  if (!t.trim()) return fail('붙여 넣을 글이 없어요. AI 답의 복사 버튼을 먼저 눌러 주세요.');
  if (/^\s*https?:\/\/\S+\s*$/.test(t)) return fail('대화 링크가 들어왔어요. 링크 말고 AI 답 글을 복사(또는 선택해서 공유)해 주세요.');
  let json;
  try { json = parseAiJson(t); } catch (err) { return fail(isOwnPrompt(t) ? ownPrompt : err.message); }
  const kind = Array.isArray(json.questions) ? 'grade' : Array.isArray(json.sets) ? 'practice' : null;
  if (!kind) return fail('채점 결과나 보충 문제 모양의 답이 아니에요. AI 답 전체를 다시 복사해 주세요.');
  // 지시문 끝의 견본 JSON 만 읽힌 경우 (지시문을 그대로 복사해 왔거나, AI가 견본을 되풀이함)
  const isExample = kind === 'grade'
    ? json.questions.every((q) => q?.type === '단원 이름')
    : json.sets.every((s) => s?.type === '유형 이름');
  if (isExample) return fail(ownPrompt);
  const engine = 'AI 앱';
  try {
    if (kind === 'grade') {
      if (!scans.length) throw new Error('시험지 사진이 없어서 채점 결과를 붙일 수 없어요. 사진을 넣고 다시 보내 주세요.');
      finishGrade(json, engine);
    } else {
      if (!examScore) throw new Error('보충 문제는 채점이 끝난 뒤에 받을 수 있어요.');
      finishPractice(json, engine);
    }
  } catch (err) {
    return fail(err.message);
  }
  handoffBox(kind).innerHTML = '';
  pending = null;
  saveSession();
  toast(kind === 'grade' ? `✅ AI 답을 자동으로 받아 채점했어요. 총점 ${fmt(examScore.total)}/${fmt(examScore.maxScore)}점` : '✅ AI가 만든 보충 문제를 받았어요.');
  return true;
}

// AI 앱에서 돌아오면 클립보드를 읽어, AI 답이 있으면 바로 반영합니다.
// (안드로이드 크롬은 처음 한 번 '클립보드 보기' 권한을 물어요. 아이폰은 막혀 있어서 '📋 AI 답 붙여넣기'를 눌러야 해요)
let clipReading = false; // focus 와 visibilitychange 가 함께 와도 한 번만 읽습니다.
async function readClipboardAuto() {
  if (clipReading || !pending || document.visibilityState !== 'visible' || !navigator.clipboard?.readText) return;
  clipReading = true;
  try {
    try {
      const perm = await navigator.permissions?.query({ name: 'clipboard-read' });
      if (perm?.state === 'denied') return nudgePaste();
    } catch {} // 'clipboard-read' 권한 이름을 모르는 브라우저
    let text;
    try { text = await readClipboardText(); } catch { return nudgePaste(); }
    if (!text || text === lastClip) return;
    lastClip = text;
    awayFromApp = false;
    if (!receiveAnswer(text, { quiet: true })) nudgePaste();
  } finally {
    clipReading = false;
  }
}

// 클립보드의 글을 읽습니다. 서식 있는 글(HTML)만 넣는 앱도 있어서, 일반 글이 비어 있으면 HTML 에서 글자만 꺼냅니다.
async function readClipboardText() {
  const text = await navigator.clipboard.readText();
  if (text.trim() || !navigator.clipboard.read) return text;
  try {
    for (const item of await navigator.clipboard.read()) {
      if (!item.types.includes('text/html')) continue;
      const html = await (await item.getType('text/html')).text();
      return new DOMParser().parseFromString(html, 'text/html').body.innerText || '';
    }
  } catch {}
  return text;
}

// 자동으로 못 읽었을 때 '📋 AI 답 붙여넣기' 버튼을 눈에 띄게 합니다.
function nudgePaste() {
  const btn = pending && $('.btn-paste', handoffBox(pending.kind));
  if (!btn) return;
  btn.classList.add('pulse');
  btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

window.addEventListener('focus', () => setTimeout(readClipboardAuto, 300));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') setTimeout(readClipboardAuto, 600);
  else awayFromApp = true;
});
window.addEventListener('pageshow', () => setTimeout(readClipboardAuto, 600));
document.addEventListener('resume', () => setTimeout(readClipboardAuto, 600)); // 폰이 잠시 멈춰 둔 화면을 다시 살릴 때
window.addEventListener('blur', () => { awayFromApp = true; });

// 제미나이처럼 이 앱 위에 작은 창(오버레이)으로 떠서 열리는 AI 앱은, 닫아도 이 앱이 '다시 보임'·'다시 선택됨' 신호를 받지 못해요.
// 그래서 다녀온 뒤 화면을 처음 톡 누를 때 클립보드를 읽습니다. (안드로이드는 읽을 때마다 '붙여넣음' 알림이 떠서, 4초에 한 번만)
let lastTapRead = 0;
document.addEventListener('pointerdown', (e) => {
  if (!pending || !awayFromApp || Date.now() - lastTapRead < 4000) return;
  if (e.target.closest('.btn-paste, .btn-apply, .handoff-answer')) return; // 직접 붙여넣기 버튼은 그쪽에서 처리
  lastTapRead = Date.now();
  readClipboardAuto();
}, { capture: true, passive: true });
// 클립보드가 바뀌면 알려 주는 브라우저에서는 그때 바로 읽습니다.
navigator.clipboard?.addEventListener?.('clipboardchange', () => setTimeout(readClipboardAuto, 200));

/* ---------- 시험지 채점 ---------- */
let examScore = null; // scoreSummary 결과 + { engine, usedAnswerKey }
let gradeRun = 0; // 채점 중에 시험지가 바뀌면 이전 결과는 버립니다.

// 시험지가 바뀌면 이전 채점 결과는 맞지 않으니 지우고, 'AI로 점수계산'을 다시 누르도록 합니다.
function resetGrade() {
  gradeRun++;
  examScore = null;
  $('#btnGrade').disabled = false;
  $('#btnGrade').textContent = '🤖 AI로 점수계산';
  $('#gradeHandoff').innerHTML = '';
  pending = null;
  prepareGradeFiles();
  renderGrade();
  saveSession();
}

// AI 앱으로 보낼 사진(띠 붙인 사진)을 미리 만들어 둡니다.
// 'AI로 점수계산'을 누른 뒤 사진을 만드느라 시간이 지나면 폰이 공유 창을 막아서, 누르는 즉시 공유 창이 뜨게 하려는 것입니다.
let gradeFilesReady = null;
let prepareTimer;
function prepareGradeFiles() {
  gradeFilesReady = null;
  clearTimeout(prepareTimer);
  if (scans.length && !useApi()) prepareTimer = setTimeout(gradeFiles, 400);
}
function gradeFiles() {
  gradeFilesReady ||= labeledImages().then((images) => images.map((img) => dataUrlToFile(img.dataUrl, img.fileName)));
  return gradeFilesReady;
}
const gradeHandoffText = () => handoffPrompt(gradeSystem(), gradeRequest(), GRADE_EXAMPLE,
  '사진 맨 위 띠에 [학생 시험지 1/2] 처럼 어떤 사진인지 적혀 있습니다.');

// 함께 보내는 사진(답안지·원문)이 있을 때만 그 규칙을 지시문에 넣습니다.
const gradeSystem = () => gradePrompt({ keyCount: keys.length, origCount: origs.length });

// 초1~중3 전체 단원 이름으로 문제 유형을 나누게 하고, 1단계의 주제학습 단원명도 알려 줍니다.
function gradeRequest() {
  const unitNames = [...new Set(SCHOOL_GRADES.flatMap((g) => Object.values(CURRICULUM[g]).flat()).map((u) => u.name))];
  return gradeText({
    scanCount: scans.length, keyCount: keys.length, origCount: origs.length, topic: studentInfo().period, unitNames,
  });
}

async function labeledImages() {
  const label = (list, what, file) => Promise.all(list.map(async (s, i) => {
    const name = `${what} ${i + 1}/${list.length}`;
    return { label: name, fileName: `${file}_${i + 1}.jpg`, dataUrl: await labelImage(s.dataUrl, name) };
  }));
  return [
    ...await label(scans, '학생 시험지', '시험지'),
    ...await label(keys, '답안지(정답)', '답안지'),
    ...await label(origs, '시험지 원문', '시험지원문'),
  ];
}

function finishGrade(result, engine) {
  examScore = { ...scoreSummary(result), engine, usedAnswerKey: keys.length > 0 };
  renderGrade();
  saveSession();
  $('#step2-1').scrollIntoView({ behavior: 'smooth' });
  toast(`채점을 마쳤습니다. 총점 ${fmt(examScore.total)}/${fmt(examScore.maxScore)}점`);
}

async function gradeScans() {
  if (!scans.length) {
    toast('먼저 시험지 사진을 찍어 주세요.');
    dropzone.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  const btn = $('#btnGrade');
  const tool = currentTool();
  if (!useApi()) {
    // 앱으로 보내기: 누르는 즉시 공유 창을 띄우고, 돌아오면 답을 자동으로 받습니다.
    examScore = null;
    renderGrade('waiting');
    const files = await gradeFiles();
    const text = gradeHandoffText();
    pending = { kind: 'grade', text };
    saveSession();
    const sending = showHandoff('grade', { files, text, what: '채점 보내기' });
    $('#gradeHandoff').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await sending;
    return;
  }
  const run = ++gradeRun;
  btn.disabled = true;
  btn.textContent = '🤖 채점하는 중…';
  try {
    const images = await labeledImages();
    const request = gradeRequest();
    if (run !== gradeRun) return;
    $('#step2-1').scrollIntoView({ behavior: 'smooth' });
    renderGrade('loading');
    const result = await askAI({
      system: gradeSystem(), text: request, images, schema: GRADE_SCHEMA, schemaName: 'grade', effort: 'high',
    });
    if (run !== gradeRun) return;
    finishGrade(result, tool.label);
  } catch (err) {
    if (run !== gradeRun) return;
    examScore = null;
    renderGrade('error', err.message);
  } finally {
    if (run === gradeRun) {
      btn.disabled = false;
      btn.textContent = '🤖 AI로 점수계산';
    }
  }
}

function renderGrade(state, msg = '') {
  const box = $('#gradeBox');
  renderGradeDetail(state);
  renderPracticePick();
  renderPdfState();
  if (state === 'loading') {
    box.innerHTML = `<p class="grade-empty loading"><span class="spin">✏️</span> ${esc(`${currentTool().label}가 시험지 ${scans.length}장을 ${keys.length ? `답안지 ${keys.length}장과 비교하며 ` : ''}채점하고 있어요…`)} (1~2분 걸릴 수 있어요)</p>`;
    return;
  }
  if (state === 'waiting') {
    box.innerHTML = `<p class="grade-empty">📲 AI 앱의 답을 기다리고 있어요. 답을 복사해서 돌아오면 자동으로 채점돼요.</p>`;
    return;
  }
  if (state === 'error') {
    box.innerHTML = `<p class="grade-empty error">채점하지 못했습니다. ${esc(msg)}</p>`;
    return;
  }
  if (!examScore) {
    box.innerHTML = `<p class="grade-empty">${scans.length
      ? `시험지 ${scans.length}장이 준비됐어요. 2단계의 'AI로 점수계산'을 눌러 주세요.`
      : "시험지 사진을 찍고 'AI로 점수계산'을 누르면 채점 결과가 여기에 나타나요."}</p>`;
    return;
  }
  const s = examScore;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  // AI가 글씨를 알아보기 어렵거나 답이 애매해 확실히 채점하지 못한 문항은 선생님이 직접 보도록 맨 위에 알려 줍니다.
  const review = s.questions.filter((q) => String(q.review || '').trim());
  const reviewHtml = review.length ? `
    <div class="review-alert" role="alert">
      <p class="review-title">👀 선생님 확인이 필요한 문항이 ${review.length}개 있어요</p>
      <p class="review-desc">글씨를 알아보기 어렵거나 답이 애매해서 AI가 확실하게 채점하지 못했어요. 아래 점수는 AI가 가장 그럴듯하게 읽은 답으로 매긴 것이니, 시험지를 직접 보고 판단해 주세요.</p>
      <ul>${review.map((q) => `
        <li>
          <span class="num-chip review">${esc(q.number)}번</span>
          <span class="review-read">AI가 읽은 답 <b>${esc(q.studentAnswer)}</b> → ${q.correct ? '정답' : q.earned > 0 ? '부분 점수' : '오답'} 처리 (${fmt(q.earned)}/${fmt(q.points)}점)</span>
          <span class="review-why">${esc(q.review)}</span>
        </li>`).join('')}
      </ul>
    </div>` : '';
  box.innerHTML = `
    ${reviewHtml}
    <div class="score-top">
      <div class="score-ring" style="--p:${pct(s.total, s.maxScore)}"><b>${fmt(s.total)}</b><span>/ ${fmt(s.maxScore)}점</span></div>
      <div class="score-meta">
        <p class="score-label">총점</p>
        <p>정답 <b>${s.correctCount}</b> / ${s.questions.length}문항</p>
        ${s.engine ? `<p class="engine">${esc(s.engine)} 채점${s.usedAnswerKey ? ' · 답안지 확인' : ''}</p>` : ''}
      </div>
    </div>
    <h4 class="grade-sub">유형별 점수</h4>
    <ul class="type-list">${s.types.map((t) => `
      <li>
        <div class="type-head"><span class="type-name">${esc(t.type)}</span><span>${fmt(t.earned)}/${fmt(t.max)}점 · ${t.correct}/${t.count}문항</span></div>
        <div class="bar"><i style="width:${pct(t.earned, t.max)}%"></i></div>
      </li>`).join('')}
    </ul>
    <details class="q-detail">
      <summary>문항별 채점 결과 보기 (${s.questions.length}문항)</summary>
      <div class="q-scroll"><table class="q-table">
        <thead><tr><th>번호</th><th>유형</th><th>학생 답</th><th>정답</th><th>채점</th><th>점수</th></tr></thead>
        <tbody>${s.questions.map((q) => `
          <tr class="${q.correct ? 'ok' : 'no'}${String(q.review || '').trim() ? ' review' : ''}" ${q.review ? `title="${esc(q.review)}"` : ''}>
            <td>${esc(q.number)}${String(q.review || '').trim() ? ' 👀' : ''}</td><td>${esc(q.type)}</td><td>${esc(q.studentAnswer)}</td><td>${esc(q.correctAnswer)}</td>
            <td class="mark">${q.correct ? '⭕' : '❌'}</td><td>${fmt(q.earned)}/${fmt(q.points)}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>
    </details>
    <p class="hint"><a href="#step2-2">📋 맞은 문제·틀린 문제 번호와 자세한 설명은 2-2에서 볼 수 있어요</a></p>`;
}

function renderGradeDetail(state) {
  const box = $('#gradeDetail');
  if (state === 'loading') {
    box.innerHTML = '<p class="grade-empty loading"><span class="spin">📋</span> 채점이 끝나면 자세한 설명을 정리해 드릴게요…</p>';
    return;
  }
  if (!examScore) {
    box.innerHTML = '<p class="grade-empty">채점이 끝나면 자세한 설명이 여기에 나타나요.</p>';
    return;
  }
  const s = examScore;
  const chips = (list, cls) => (list.length
    ? list.map((x) => `<span class="num-chip ${cls}">${esc(x)}번</span>`).join('')
    : '<span class="none">없음</span>');
  const missed = s.questions.filter((q) => !q.correct);
  const weakest = s.types.filter((t) => t.max).sort((a, b) => a.earned / a.max - b.earned / b.max)[0];
  const advice = s.advice
    || (weakest && weakest.earned < weakest.max ? `${weakest.type} 유형 점수가 가장 낮아요 (${fmt(weakest.earned)}/${fmt(weakest.max)}점). 이 유형부터 복습해 주세요.` : '');
  box.innerHTML = `
    <div class="detail-sec">
      <h4>📏 채점 기준</h4>
      <p>${esc(s.criteria || '시험지에 적힌 배점과 정답을 기준으로 채점했어요.')}</p>
    </div>
    <div class="detail-sec">
      <h4>🔢 번호로 보기</h4>
      <div class="num-row"><b>⭕ 맞은 문제 (${s.correctNumbers.length})</b><div>${chips(s.correctNumbers, 'ok')}</div></div>
      ${s.partialNumbers.length ? `<div class="num-row"><b>🔺 부분 점수 (${s.partialNumbers.length})</b><div>${chips(s.partialNumbers, 'part')}</div></div>` : ''}
      <div class="num-row"><b>❌ 틀린 문제 (${s.wrongNumbers.length})</b><div>${chips(s.wrongNumbers, 'no')}</div></div>
    </div>
    <div class="detail-sec">
      <h4>✏️ 틀린 문제 살펴보기</h4>
      ${missed.length ? `<ul class="miss-list">${missed.map((q) => `
        <li>
          <span class="num-chip ${q.earned > 0 ? 'part' : 'no'}">${esc(q.number)}번</span>
          <span class="miss-type">${esc(q.type)}</span>
          학생 답 <b>${esc(q.studentAnswer)}</b> → 정답 <b>${esc(q.correctAnswer)}</b>
          ${q.earned > 0 ? `<span class="miss-part">부분 점수 ${fmt(q.earned)}/${fmt(q.points)}점</span>` : ''}
          ${q.reason ? `<p class="miss-reason">${esc(q.reason)}</p>` : ''}
        </li>`).join('')}</ul>` : '<p>모든 문제를 맞혔어요! 🎉</p>'}
    </div>
    ${s.checks.length ? `
    <div class="detail-sec warn">
      <h4>⚠️ 선생님 확인 필요</h4>
      <ul>${s.checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
    </div>` : ''}
    ${advice ? `
    <div class="detail-sec tip">
      <h4>💡 보완 포인트</h4>
      <p>${esc(advice)}</p>
    </div>` : ''}
    ${s.note ? `<p class="hint">📝 ${esc(s.note)}</p>` : ''}`;
}

$('#btnGrade').addEventListener('click', gradeScans);

/* ---------- 2-3 보충 문제 ---------- */
const WEAK_PCT = 70; // 이 점수(%) 미만인 유형을 보충 대상으로 미리 골라 둡니다.
let practice = null; // { sets: [{ type, tip, problems: [{ question, answer, explanation }] }], engine }
let practiceRun = 0; // 만드는 중에 채점 결과가 바뀌면 이전 결과는 버립니다.
const PRACTICE_BTN = '🧩 보충 문제 만들기';

// 채점 결과가 바뀔 때마다 유형 목록을 새로 그리고, 이전 보충 문제는 지웁니다.
function renderPracticePick() {
  practiceRun++;
  practice = null;
  $('#practiceResult').innerHTML = '';
  $('#practiceHandoff').innerHTML = '';
  if (pending?.kind === 'practice') pending = null;
  $('#btnPractice').disabled = false;
  $('#btnPractice').textContent = PRACTICE_BTN;
  const box = $('#practicePick');
  if (!examScore) {
    box.innerHTML = '<p class="grade-empty">채점이 끝나면 보충할 유형이 여기에 나타나요.</p>';
    $('#practiceControls').classList.add('hidden');
    return;
  }
  const types = examScore.types
    .map((t) => ({ ...t, pct: t.max ? Math.round((t.earned / t.max) * 100) : 100 }))
    .sort((a, b) => a.pct - b.pct);
  const anyWeak = types.some((t) => t.pct < WEAK_PCT);
  box.innerHTML = `
    ${anyWeak ? '' : `<p class="hint">🎉 모든 유형이 ${WEAK_PCT}% 이상이에요. 더 연습할 유형을 직접 골라도 돼요.</p>`}
    <ul class="pick-list">${types.map((t) => `
      <li><label class="pick ${t.pct < WEAK_PCT ? 'weak' : ''}">
        <input type="checkbox" value="${esc(t.type)}" ${t.pct < WEAK_PCT ? 'checked' : ''}>
        <span class="pick-name">${esc(t.type)}</span>
        <span class="pick-score">${fmt(t.earned)}/${fmt(t.max)}점 · ${t.pct}%</span>
      </label></li>`).join('')}
    </ul>`;
  $('#practiceControls').classList.remove('hidden');
}

function finishPractice(result, engine) {
  practice = { ...cleanPractice(result), engine };
  renderPractice();
  renderPdfState();
  saveSession();
  toast(`보충 문제 ${practice.sets.reduce((a, s) => a + s.problems.length, 0)}개를 만들었어요.`);
}

async function makePractice() {
  if (!examScore) return toast('먼저 시험지를 채점해 주세요.');
  const chosen = [...document.querySelectorAll('#practicePick input:checked')].map((i) => i.value);
  if (!chosen.length) return toast('보충할 유형을 하나 이상 골라 주세요.');
  // 유형마다 학생이 틀린 내용을 함께 보내, 그 실수를 연습하는 문제를 만들게 합니다.
  const types = chosen.map((name) => {
    const t = examScore.types.find((x) => x.type === name);
    const mistakes = examScore.questions
      .filter((q) => q.type === name && !q.correct)
      .map((q) => q.reason || `학생 답 ${q.studentAnswer}, 정답 ${q.correctAnswer}`);
    return { type: name, earned: t.earned, max: t.max, mistakes };
  });
  const request = practiceText({ count: +$('#practiceCount').value, types });
  const run = ++practiceRun;
  const tool = currentTool();
  practice = null;
  $('#practiceResult').innerHTML = '';
  if (!useApi()) {
    const text = handoffPrompt(PRACTICE_PROMPT, `아래 정보로 보충 문제를 만들어 주세요.\n\n${request}`, PRACTICE_EXAMPLE);
    pending = { kind: 'practice', text };
    saveSession();
    const sending = showHandoff('practice', { files: [], text, what: '보충 문제 요청하기' });
    $('#practiceHandoff').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await sending;
    return;
  }
  const btn = $('#btnPractice');
  btn.disabled = true;
  btn.textContent = '🧩 만드는 중…';
  $('#practiceResult').innerHTML = `<p class="grade-empty loading"><span class="spin">🧩</span> ${esc(tool.label)}가 보충 문제를 만들고 있어요… (1~2분 걸릴 수 있어요)</p>`;
  try {
    const result = await askAI({
      system: PRACTICE_PROMPT, text: `아래 정보로 보충 문제를 만들어 주세요.\n\n${request}`,
      schema: PRACTICE_SCHEMA, schemaName: 'practice', effort: 'medium',
    });
    if (run !== practiceRun) return;
    finishPractice(result, tool.label);
  } catch (err) {
    if (run !== practiceRun) return;
    $('#practiceResult').innerHTML = `<p class="grade-empty error">보충 문제를 만들지 못했습니다. ${esc(err.message)}</p>`;
  } finally {
    if (run === practiceRun) {
      btn.disabled = false;
      btn.textContent = PRACTICE_BTN;
    }
  }
}

function renderPractice() {
  const total = practice.sets.reduce((a, s) => a + s.problems.length, 0);
  $('#practiceResult').classList.remove('show-ans');
  $('#practiceResult').innerHTML = `
    <div class="practice-bar">
      <span><b>${practice.sets.length}개 유형 · ${total}문제</b> ${practice.engine ? `<small>${esc(practice.engine)}${hasBatchim(practice.engine) ? '이' : '가'} 만들었어요</small>` : ''}</span>
      <label class="check-inline"><input type="checkbox" id="practiceShowAns"> 정답·풀이 보기</label>
      <button type="button" class="btn-outline" id="btnPracticePrint">🖨️ 학생용 인쇄</button>
    </div>
    ${practice.sets.map((s) => `
    <div class="pset">
      <h4>🧩 ${esc(s.type)}</h4>
      ${s.tip ? `<p class="ptip">💡 ${esc(s.tip)}</p>` : ''}
      <ol class="plist">${s.problems.map((p) => `
        <li>
          <p class="pq">${esc(p.question)}</p>
          <div class="pans"><b>정답</b> ${esc(p.answer)}${p.explanation ? `<span>${esc(p.explanation)}</span>` : ''}</div>
        </li>`).join('')}
      </ol>
    </div>`).join('')}
    <p class="hint"><a href="#step3">📄 보충 문제도 3단계 PDF 문서에 함께 들어가요</a></p>`;
}

// 학생에게 나눠 줄 문제지(앞)와 선생님용 정답·풀이(뒤 페이지)를 새 창으로 열어 인쇄합니다.
function printPractice() {
  const info = studentInfo();
  const title = `${info.student ? `${info.student} 학생 ` : ''}보충 문제`;
  // 1단계에서 입력한 학원명·주제학습 단원명·선생님 이름을 문제지 머리글에 넣습니다.
  const meta = [info.academy, info.period, `${info.teacher || '담임'} 선생님`].filter(Boolean).map(esc).join(' · ');
  let n = 0;
  const sheet = practice.sets.map((s) => `
    <h2>${esc(s.type)}</h2>
    ${s.tip ? `<p class="tip">💡 ${esc(s.tip)}</p>` : ''}
    ${s.problems.map((p) => `<div class="q"><b>${++n}.</b> ${esc(p.question)}<div class="line">답: ________________</div></div>`).join('')}`).join('');
  n = 0;
  const key = practice.sets.map((s) => `
    <h2>${esc(s.type)}</h2>
    ${s.problems.map((p) => `<p><b>${++n}.</b> ${esc(p.answer)} <small>${esc(p.explanation || '')}</small></p>`).join('')}`).join('');
  const win = window.open('', '_blank');
  if (!win) return toast('새 창이 막혀 있어요. 브라우저에서 팝업을 허용해 주세요.');
  win.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
    <style>
      body { font-family: "Malgun Gothic", "Apple SD Gothic Neo", sans-serif; max-width: 760px; margin: 24px auto; padding: 0 16px; color: #222; line-height: 1.6; }
      h1 { font-size: 22px; margin: 0 0 4px; } .meta { color: #666; margin: 0 0 16px; }
      h2 { font-size: 17px; border-bottom: 2px solid #b197fc; padding-bottom: 4px; margin: 22px 0 10px; }
      .tip { color: #555; font-size: 14px; } .q { margin: 0 0 18px; white-space: pre-line; break-inside: avoid; }
      .line { margin-top: 8px; color: #999; } .key { break-before: page; } small { color: #666; }
    </style></head><body>
    <h1>${esc(title)}</h1><p class="meta">${meta}<br>이름: ______________ &nbsp; 날짜: ______________</p>
    ${sheet}
    <section class="key"><h1>정답과 풀이</h1>${key}</section>
    <script>window.onload = () => window.print();<\/script>
    </body></html>`);
  win.document.close();
}

$('#btnPractice').addEventListener('click', makePractice);
$('#practiceResult').addEventListener('change', (e) => {
  if (e.target.id === 'practiceShowAns') $('#practiceResult').classList.toggle('show-ans', e.target.checked);
});
$('#practiceResult').addEventListener('click', (e) => {
  if (e.target.closest('#btnPracticePrint')) printPractice();
});

/* ---------- 3. PDF 문서로 제출 ---------- */
function renderPdfState() {
  const ready = !!examScore;
  $('#btnPdfShare').disabled = !ready;
  $('#btnPdfSave').disabled = !ready;
  $('#pdfMsg').textContent = ready
    ? `채점 결과${practice ? '와 보충 문제' : ''}가 문서에 들어가요.${practice ? '' : ' 보충 문제도 넣으려면 2-3에서 먼저 만들어 주세요.'}`
    : '채점이 끝나면 누를 수 있어요.';
}

function reportFile() {
  const info = studentInfo();
  const safe = (t) => (t || '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 30);
  const name = `${[safe(info.student) || '학생', safe(info.period), '채점결과'].filter(Boolean).join('_')}.pdf`;
  return new File([buildReportPdf({ info, score: examScore, practice })], name, { type: PDF_MIME });
}

$('#btnPdfShare').addEventListener('click', async () => {
  if (!examScore) return;
  const file = reportFile();
  if (navigator.canShare?.({ files: [file] })) {
    try {
      // title/text 없이 파일만 보냅니다. (일부 폰은 함께 보내면 거부합니다)
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err.name === 'AbortError') return; // 사용자가 공유창을 닫음
      // 폰이 공유를 거부(Permission denied 등)하면 자동으로 파일로 저장해 줍니다.
      downloadBlob(file, file.name);
      toast(`바로 보내기가 막혀서 파일로 저장했어요. '내 파일 > 다운로드'에서 ${file.name} 을(를) 길게 눌러 공유하세요.`);
    }
    return;
  }
  downloadBlob(file, file.name);
  toast('이 브라우저는 바로 보내기를 못 해서 파일로 저장했어요.');
});
$('#btnPdfSave').addEventListener('click', () => {
  if (!examScore) return;
  const file = reportFile();
  downloadBlob(file, file.name);
  toast(`${file.name} 을(를) 저장했어요. (다운로드 폴더)`);
});

renderPdfState();

/* ---------- 새 학생 시작 ---------- */
$('#btnNewStudent').addEventListener('click', () => {
  ['studentName', 'reportPeriod'].forEach((id) => { $(`#${id}`).value = ''; });
  scans.length = 0;
  keys.length = 0;
  origs.length = 0;
  renderScans();
  renderKeys();
  renderOrigs(); // 채점 결과·보충 문제·기다리던 요청도 함께 지워집니다.
  setScanMsg('');
  $('#step1').scrollIntoView({ behavior: 'smooth' });
  toast('새 학생을 시작해요. 학생 이름부터 넣어 주세요.');
});

/* ---------- 저장해 둔 작업 이어 가기 · AI 답 공유받기 ---------- */
// AI 앱에서 답 글을 선택해 [공유] → onemath2 를 고르면 ./?st=제목&sx=글&su=링크 로 이 앱이 열립니다. (manifest 의 share_target)
function takeSharedText() {
  const p = new URLSearchParams(location.search);
  if (!['st', 'sx', 'su'].some((k) => p.has(k))) return '';
  history.replaceState(null, '', location.pathname);
  return ['sx', 'st', 'su'].map((k) => p.get(k) || '').filter(Boolean).join('\n');
}

async function restoreSession() {
  let s = null;
  try { s = await sessionStore('readonly', (st) => st.get('session')); } catch {}
  if (s && Date.now() - s.savedAt < SESSION_HOURS * 3600 * 1000) {
    const info = s.info || {};
    [['studentName', info.student], ['teacherName', info.teacher], ['reportPeriod', info.period]]
      .forEach(([id, v]) => { if (v) $(`#${id}`).value = v; });
    scans.push(...(s.scans || []));
    keys.push(...(s.keys || []));
    origs.push(...(s.origs || []));
    renderScans();
    renderKeys();
    renderOrigs();
    setScanMsg(attachedMsg());
    if (s.examScore && scans.length) {
      examScore = s.examScore;
      renderGrade();
      if (s.practice) {
        practice = s.practice;
        renderPractice();
        renderPdfState();
      }
    }
    if (s.pending) {
      pending = s.pending;
      if (pending.kind === 'grade' && scans.length) {
        renderGrade('waiting');
        showHandoff('grade', { files: await gradeFiles(), text: pending.text, what: '채점 보내기', autoSend: false });
      } else if (pending.kind === 'practice' && examScore) {
        showHandoff('practice', { files: [], text: pending.text, what: '보충 문제 요청하기', autoSend: false });
      } else {
        pending = null;
      }
    }
  }
  restoring = false;
}

const sharedText = takeSharedText();
restoreSession().then(() => {
  if (sharedText) {
    if (!receiveAnswer(sharedText)) $(`#${pending?.kind === 'practice' ? 'step2-3' : 'step2'}`).scrollIntoView({ behavior: 'smooth' });
  } else {
    readClipboardAuto(); // 이 앱이 새로 열린 경우에도 복사해 온 AI 답을 읽어 봅니다.
  }
});
