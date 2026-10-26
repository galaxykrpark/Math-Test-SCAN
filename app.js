const MAX_SCANS = 10;
const MAX_SCAN_BYTES = 30 * 1024 * 1024; // 폰 카메라 원본도 받을 수 있게 넉넉히 둡니다. (받은 뒤 줄여서 저장)
const ACADEMY_KEY = 'oneclick-point-academy';
const SCHOOL_GRADES = GRADES.filter((g) => g !== '고등'); // 초1 ~ 중3

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (x) => String(+(+x).toFixed(1));

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
      <small>${aiSettings.keys[id] ? '🔑 키 있음' : '앱'}</small>
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
  $('#aiPill').textContent = `${tool.icon} ${tool.label} · ${useApi() ? '자동' : '앱'}`;
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
SCHOOL_GRADES.forEach((g) => $('#actualGrade').append(new Option(g, g)));
try { $('#academyName').value = localStorage.getItem(ACADEMY_KEY) || ''; } catch {}
$('#academyName').addEventListener('change', (e) => {
  try { localStorage.setItem(ACADEMY_KEY, e.target.value.trim()); } catch {}
});

const studentInfo = () => ({
  academy: $('#academyName').value.trim(),
  student: $('#studentName').value.trim(),
  teacher: $('#teacherName').value.trim(),
  period: $('#reportPeriod').value.trim(),
  grade: $('#actualGrade').value,
});

/* ---------- 학생 시험지 · 답안지(정답) 사진 ---------- */
const scans = []; // 학생 시험지 { id, name, dataUrl }
const keys = []; // 답안지(정답) { id, name, dataUrl } — 채점할 때 정답 확인용으로 함께 보냅니다.

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

// 큰 사진은 AI가 받을 수 있는 크기로 줄입니다. (폰 카메라 사진은 4000px 넘게 크고, 그대로 두면 폰 메모리가 모자라요)
function shrinkImage(dataUrl, maxSide = 2000) {
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
      ctx.fillStyle = label.startsWith('답안지') ? '#19b38a' : '#16161d';
      ctx.fillRect(0, 0, canvas.width, band);
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(band * 0.55)}px sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText(`[${label}]`, band * 0.3, band / 2);
      ctx.drawImage(img, 0, band);
      resolve(canvas.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function attachedMsg() {
  const parts = [];
  if (scans.length) parts.push(`시험지 ${scans.length}장`);
  if (keys.length) parts.push(`답안지 ${keys.length}장`);
  return parts.length ? `${parts.join(', ')}이 들어왔어요.` : '';
}

// 사진 찍기·앨범에서 고르기·(PC에서는) 끌어다 놓기·지우기가 되는 사진 칸을 만듭니다. (시험지 칸, 답안지 칸 공용)
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
        <button type="button" class="remove" aria-label="${esc(s.name)} 삭제">✕</button>
      </li>`).join('');
    zone.classList.toggle('has-files', store.length > 0);
    zone.querySelectorAll('.btn-cam, .btn-album').forEach((b) => { b.disabled = store.length >= MAX_SCANS; });
    resetGrade(); // 시험지나 답안지가 바뀌면 이전 채점 결과는 맞지 않으니 지웁니다.
  }

  zone.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-open]');
    if (opener) return $(`#${opener.dataset.open}`).click();
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
}

const dropzone = $('#dropzone');
const keyDropzone = $('#keyDropzone');
setupImageZone(dropzone, $('#scanCamera'), $('#scanInput'), $('#thumbs'), scans, '시험지');
setupImageZone(keyDropzone, $('#keyCamera'), $('#keyInput'), $('#keyThumbs'), keys, '답안지');
['dragover', 'drop'].forEach((t) => window.addEventListener(t, (e) => {
  if (!dropzone.contains(e.target) && !keyDropzone.contains(e.target)) e.preventDefault();
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

function clearHandoffs() {
  $('#gradeHandoff').innerHTML = '';
  $('#practiceHandoff').innerHTML = '';
}

// 고른 AI 앱으로 사진·지시문을 공유하고, 앱에서 복사해 온 답을 붙여 넣어 받는 안내 칸을 그립니다.
// files: 보낼 사진 File 목록, text: 지시문, onAnswer(json): 붙여 넣은 답 처리 (실패하면 오류를 던짐)
function showHandoff(box, { files, text, what, onAnswer }) {
  const tool = currentTool();
  box.innerHTML = `
    <div class="handoff">
      <p class="handoff-title">${tool.icon} ${esc(tool.label)} 앱으로 ${esc(what)}</p>
      <ol class="handoff-steps">
        <li>
          <b>보내기</b>를 누르고 공유 목록에서 <b>${esc(tool.label)}</b>를 고른 뒤, 앱에서 전송하세요.
          <span class="sub">지시문은 복사도 해 두니, 앱에 글이 안 들어갔으면 입력칸을 길게 눌러 붙여 넣으세요.</span>
          <div class="handoff-btns">
            <button type="button" class="btn-send">📤 ${esc(tool.label)}로 보내기</button>
            <button type="button" class="btn-outline btn-copy">📋 지시문 복사</button>
            ${files.length ? '<button type="button" class="btn-outline btn-save-imgs">💾 사진 저장</button>' : ''}
            <a class="btn-outline" href="${tool.appUrl}" target="_blank" rel="noopener">↗ 앱 열기</a>
          </div>
        </li>
        <li>답이 다 나오면 코드 칸의 <b>복사</b> 버튼(또는 답을 길게 눌러 복사)을 누르고 이 앱으로 돌아오세요.</li>
        <li>
          <button type="button" class="btn-outline btn-paste">📋 붙여넣기</button> 를 누르거나 아래 칸에 붙여 넣고 <b>결과 반영</b>을 누르세요.
          <textarea class="handoff-answer" rows="4" placeholder="여기에 AI 답을 붙여 넣으세요"></textarea>
          <button type="button" class="btn-grade btn-apply">✅ 결과 반영</button>
        </li>
      </ol>
      <p class="hint handoff-msg" aria-live="polite"></p>
    </div>`;
  const msg = (t, isError = false) => {
    const el = $('.handoff-msg', box);
    el.textContent = t;
    el.classList.toggle('error', isError);
  };
  const saveImages = () => files.forEach((f, i) => setTimeout(() => downloadBlob(f, f.name), i * 400));

  $('.btn-send', box).addEventListener('click', async () => {
    copyText(text); // 공유와 같은 누름 안에서 복사해야 폰이 막지 않습니다.
    const data = files.length ? { files, text, title: 'onemath' } : { text, title: 'onemath' };
    if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      try {
        await navigator.share(data);
        msg(`${tool.label}에서 답이 나오면 복사해서 돌아와 주세요.`);
      } catch (err) {
        if (err.name !== 'AbortError') msg(`보내지 못했어요. (${err.message}) 아래 '사진 저장'과 '지시문 복사' 후 앱에 직접 넣어 주세요.`, true);
      }
      return;
    }
    // 공유 기능이 없는 브라우저(PC 등): 사진을 저장하고 지시문을 복사한 뒤 앱을 엽니다.
    if (files.length) saveImages();
    msg(`이 브라우저는 앱으로 바로 보내기를 못 해요. ${files.length ? '사진을 저장하고 ' : ''}지시문을 복사했어요. ${tool.label}에 ${files.length ? '사진을 올리고 ' : ''}지시문을 붙여 넣어 주세요.`);
    window.open(tool.appUrl, '_blank', 'noopener');
  });
  $('.btn-copy', box).addEventListener('click', async () => {
    msg((await copyText(text)) ? '지시문을 복사했어요. AI 앱 입력칸을 길게 눌러 붙여 넣으세요.' : '복사하지 못했어요.', false);
  });
  $('.btn-save-imgs', box)?.addEventListener('click', () => { saveImages(); msg('사진을 저장했어요. AI 앱에서 사진을 올려 주세요.'); });
  $('.btn-paste', box).addEventListener('click', async () => {
    try {
      $('.handoff-answer', box).value = await navigator.clipboard.readText();
      $('.btn-apply', box).click();
    } catch {
      msg('붙여넣기 권한이 없어요. 아래 칸을 길게 눌러 붙여 넣어 주세요.', true);
      $('.handoff-answer', box).focus();
    }
  });
  $('.btn-apply', box).addEventListener('click', () => {
    try {
      onAnswer(parseAiJson($('.handoff-answer', box).value));
      box.innerHTML = '';
    } catch (err) {
      msg(err.message, true);
    }
  });
}

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
  renderGrade();
}

// 학년을 골랐으면 그 학년 단원 이름으로, 아니면 초1~중3 전체 단원 이름으로 문제 유형을 나누게 합니다.
function gradeRequest() {
  const grade = $('#actualGrade').value;
  const terms = grade ? CURRICULUM[grade] : null;
  const hint = terms
    ? `${grade} (${Object.entries(terms).map(([sem, units]) => `${sem}: ${units.map((u) => u.name).join(', ')}`).join(' / ')})`
    : '';
  const unitNames = [...new Set((terms ? Object.values(terms).flat()
    : SCHOOL_GRADES.flatMap((g) => Object.values(CURRICULUM[g]).flat())).map((u) => u.name))];
  return gradeText({ keyCount: keys.length, hint, unitNames });
}

async function labeledImages() {
  const label = (list, what) => Promise.all(list.map(async (s, i) => {
    const name = `${what} ${i + 1}/${list.length}`;
    return { label: name, dataUrl: await labelImage(s.dataUrl, name) };
  }));
  return [...await label(scans, '학생 시험지'), ...await label(keys, '답안지(정답) — 채점하지 말고 정답 확인용')];
}

function finishGrade(result, engine) {
  examScore = { ...scoreSummary(result), engine, usedAnswerKey: keys.length > 0 };
  renderGrade();
  $('#step2-1').scrollIntoView({ behavior: 'smooth' });
  toast(`채점을 마쳤습니다. 총점 ${fmt(examScore.total)}/${fmt(examScore.maxScore)}점`);
}

async function gradeScans() {
  if (!scans.length) {
    toast('먼저 시험지 사진을 찍어 주세요.');
    dropzone.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  const run = ++gradeRun;
  const btn = $('#btnGrade');
  const tool = currentTool();
  btn.disabled = true;
  btn.textContent = useApi() ? '🤖 채점하는 중…' : '🤖 보낼 사진 준비 중…';
  try {
    const images = await labeledImages();
    const request = gradeRequest();
    if (run !== gradeRun) return;
    if (!useApi()) {
      renderGrade('waiting');
      showHandoff($('#gradeHandoff'), {
        files: images.map((img, i) => dataUrlToFile(img.dataUrl, `${i < scans.length ? '시험지' : '답안지'}_${i < scans.length ? i + 1 : i - scans.length + 1}.jpg`)),
        text: handoffPrompt(GRADE_PROMPT, request, GRADE_EXAMPLE,
          '사진 맨 위 띠에 [학생 시험지 1/2], [답안지(정답) …] 처럼 어떤 사진인지 적혀 있습니다.'),
        what: '채점 보내기',
        onAnswer: (json) => {
          if (run !== gradeRun) throw new Error('시험지 사진이 바뀌었어요. AI로 점수계산을 다시 눌러 주세요.');
          finishGrade(json, `${tool.label} 앱`);
        },
      });
      $('#gradeHandoff').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    $('#step2-1').scrollIntoView({ behavior: 'smooth' });
    renderGrade('loading');
    const result = await askAI({
      system: GRADE_PROMPT, text: request, images, schema: GRADE_SCHEMA, schemaName: 'grade', effort: 'high',
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
  renderDocxState();
  if (state === 'loading') {
    box.innerHTML = `<p class="grade-empty loading"><span class="spin">✏️</span> ${esc(`${currentTool().label}가 시험지 ${scans.length}장을 ${keys.length ? `답안지 ${keys.length}장과 비교하며 ` : ''}채점하고 있어요…`)} (1~2분 걸릴 수 있어요)</p>`;
    return;
  }
  if (state === 'waiting') {
    box.innerHTML = `<p class="grade-empty">📲 ${esc(currentTool().label)} 앱의 답을 기다리고 있어요. 2단계 아래 안내를 따라 주세요.</p>`;
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
  renderDocxState();
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
  const request = practiceText({ grade: $('#actualGrade').value, count: +$('#practiceCount').value, types });
  const run = ++practiceRun;
  const tool = currentTool();
  practice = null;
  $('#practiceResult').innerHTML = '';
  if (!useApi()) {
    showHandoff($('#practiceHandoff'), {
      files: [],
      text: handoffPrompt(PRACTICE_PROMPT, `아래 정보로 보충 문제를 만들어 주세요.\n\n${request}`, PRACTICE_EXAMPLE),
      what: '보충 문제 요청하기',
      onAnswer: (json) => {
        if (run !== practiceRun) throw new Error('채점 결과가 바뀌었어요. 보충 문제 만들기를 다시 눌러 주세요.');
        finishPractice(json, `${tool.label} 앱`);
      },
    });
    $('#practiceHandoff').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      <span><b>${practice.sets.length}개 유형 · ${total}문제</b> ${practice.engine ? `<small>${esc(practice.engine)}가 만들었어요</small>` : ''}</span>
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
    <p class="hint"><a href="#step3">📄 보충 문제도 3단계 Word 문서에 함께 들어가요</a></p>`;
}

// 학생에게 나눠 줄 문제지(앞)와 선생님용 정답·풀이(뒤 페이지)를 새 창으로 열어 인쇄합니다.
function printPractice() {
  const info = studentInfo();
  const title = `${info.student ? `${info.student} 학생 ` : ''}보충 문제`;
  // 1단계에서 입력한 학원명·학년·학습지 기간·선생님 이름을 문제지 머리글에 넣습니다.
  const meta = [info.academy, info.grade, info.period, `${info.teacher || '담임'} 선생님`].filter(Boolean).map(esc).join(' · ');
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

/* ---------- 3. Word(docx) 문서로 제출 ---------- */
function renderDocxState() {
  const ready = !!examScore;
  $('#btnDocxShare').disabled = !ready;
  $('#btnDocxSave').disabled = !ready;
  $('#docxMsg').textContent = ready
    ? `채점 결과${practice ? '와 보충 문제' : ''}가 문서에 들어가요.${practice ? '' : ' 보충 문제도 넣으려면 2-3에서 먼저 만들어 주세요.'}`
    : '채점이 끝나면 누를 수 있어요.';
}

function reportFile() {
  const info = studentInfo();
  const safe = (t) => (t || '').replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 30);
  const name = `${[safe(info.student) || '학생', safe(info.period), '채점결과'].filter(Boolean).join('_')}.docx`;
  return new File([buildReportDocx({ info, score: examScore, practice })], name, { type: DOCX_MIME });
}

$('#btnDocxShare').addEventListener('click', async () => {
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
$('#btnDocxSave').addEventListener('click', () => {
  if (!examScore) return;
  const file = reportFile();
  downloadBlob(file, file.name);
  toast(`${file.name} 을(를) 저장했어요. (다운로드 폴더)`);
});

renderDocxState();
