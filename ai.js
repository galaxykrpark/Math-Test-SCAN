/* AI 연결 (onemath2: 앱으로 보내기는 누르는 즉시 공유 창, 돌아오면 클립보드의 답을 자동으로 읽음)
   - 앱으로 보내기: 사진과 지시문을 폰의 ChatGPT·제미나이·Claude 앱으로 공유하고, AI 답(JSON)을 복사해 와서 붙여 넣습니다.
   - API 키: 이 폰에 저장한 키로 앱 안에서 바로 AI를 불러 자동으로 채점합니다.
   점수 계산은 PC용 server.py 와 같고, 지시문(GRADE_PROMPT, PRACTICE_PROMPT)은 폰에 맞게 줄인 것입니다. */

const AI_TOOLS = {
  chatgpt: {
    label: 'ChatGPT', icon: '🟢', appUrl: 'https://chatgpt.com/',
    keyUrl: 'https://platform.openai.com/api-keys', model: 'gpt-5', keyHint: 'sk-로 시작',
  },
  gemini: {
    label: '제미나이', icon: '🔷', appUrl: 'https://gemini.google.com/app',
    keyUrl: 'https://aistudio.google.com/apikey', model: 'gemini-3.8-flash', keyHint: 'AQ. 또는 AIza로 시작 · 무료 등급 있음',
    // 제미나이는 이 앱 위에 작은 창으로 떠서 열릴 때가 있어, 닫아도 앱이 돌아온 줄 모를 수 있어요.
    returnTip: '제미나이가 화면 위에 작은 창으로 떠서 열렸다면, 답을 복사한 뒤 제미나이 창을 닫고 이 화면을 한 번 톡 눌러 주세요. 그때 자동으로 읽어요.',
  },
  claude: {
    label: 'Claude', icon: '🟠', appUrl: 'https://claude.ai/new',
    keyUrl: 'https://platform.claude.com/settings/keys', model: 'claude-opus-5-5', keyHint: 'sk-ant-로 시작',
  },
};
const AI_SETTINGS_KEY = 'onemath-ai';

// { tool: 'chatgpt'|'gemini'|'claude', mode: 'app'|'api', keys: { tool: key }, models: { tool: model } }
const aiSettings = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || '{}'); } catch {}
  return {
    tool: AI_TOOLS[saved.tool] ? saved.tool : 'chatgpt',
    mode: saved.mode === 'api' ? 'api' : 'app',
    keys: saved.keys || {},
    models: saved.models || {},
  };
})();

function saveAiSettings() {
  try { localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(aiSettings)); } catch {}
}

const currentTool = () => AI_TOOLS[aiSettings.tool];
const currentModel = () => (aiSettings.models[aiSettings.tool] || '').trim() || currentTool().model;
const useApi = () => aiSettings.mode === 'api';

/* ---------- 지시문 (server.py 와 같음) ---------- */
const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'string' },
          type: { type: 'string' },
          studentAnswer: { type: 'string' },
          correctAnswer: { type: 'string' },
          correct: { type: 'boolean' },
          points: { type: 'number' },
          earned: { type: 'number' },
          reason: { type: 'string' },
          review: { type: 'string' },
        },
        required: ['number', 'type', 'studentAnswer', 'correctAnswer', 'correct', 'points', 'earned', 'reason', 'review'],
        additionalProperties: false,
      },
    },
    criteria: { type: 'string' },
    checks: { type: 'array', items: { type: 'string' } },
    advice: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['questions', 'criteria', 'checks', 'advice', 'note'],
  additionalProperties: false,
};

// 채점 지시문은 꼭 필요한 내용만 짧게 둡니다. (AI 앱 입력칸에 그대로 붙으니, 길면 선생님이 보기에도 부담돼요)
// 답안지·시험지 원문 규칙은 그 사진을 함께 보낼 때만 붙입니다. → gradePrompt()
const GRADE_PROMPT = `당신은 수학 학원 선생님을 도와 학생 시험지를 채점합니다.
[학생 시험지] 그림이 여러 장이면 이어지는 한 시험지로 보고, 모든 문항을 빠짐없이 채점하세요.

문항마다:
- number: 시험지의 큰 문항 번호 (예: "1", "서술형 2"). (1)(2) 같은 소문항은 따로 나누지 않고 한 문항으로 묶습니다.
- type: 문제 유형(단원) 이름. 단원 이름 목록이 있으면 그중에서 글자 그대로 고르고, 같은 유형은 늘 같은 이름으로 씁니다.
- studentAnswer: 학생이 쓴 최종 답. 소문항은 "(1) … (2) …"처럼 함께 씁니다. 비어 있으면 "(무응답)"
- correctAnswer: 정답 (직접 풀어서 구함, 소문항은 studentAnswer와 같은 모양)
- correct: 모든 소문항까지 정답이면 true
- points: 시험지의 배점. 안 보이면 0
- earned: 받은 점수. 맞으면 points, 틀리면 0. 소문항·서술형은 맞은 만큼 부분 점수. 배점이 안 보이면(points 0) 맞은 비율을 0~1로 씁니다 (예: 소문항 3개 중 2개 맞으면 0.67)
- reason: 틀렸거나 부분 점수인 이유 한 문장 (예: "6×7을 41로 계산함"). 맞으면 ""
- review: 확실히 채점하기 어려우면 그 이유 한 문장, 확실하면 "". 흘려 쓴 글씨(1과 7, 4와 9, 0과 6, <와 >), 지우다 만 답·덧쓴 답, 두 가지로 읽히는 답, 답 칸 밖의 답, 판단이 애매한 서술형일 때 씁니다. 이때도 가장 그럴듯한 답으로 채점하고 어떻게 읽었는지 적습니다 (예: "7인지 1인지 애매, 7로 읽고 정답 처리").

시험지 전체:
- criteria: 채점 기준 한두 문장 (배점이 없을 때 어떻게 했는지, 부분 점수 기준)
- checks: 선생님이 직접 확인할 점 목록 (읽을 수 없는 문항, 인쇄 오류 등). 없으면 []
- advice: 가장 시급히 보완할 유형과 이유 한두 문장
- note: 그 밖에 알아 둘 점 한 문장. 없으면 ""

규칙:
- 선생님의 채점 표시(O, X, ✓, 빗금)가 있으면 그 표시를 따릅니다.
- 학생과 다른 색(주로 빨간 펜)으로 쓴 글씨는 선생님의 정정·채점이니 studentAnswer로 읽지 않습니다.
- 문제나 답안지가 요구한 꼴(거듭제곱, 소인수분해 꼴, 기약분수 등)로 쓰지 않으면 값이 같아도 틀림입니다 (예: 2²×3 자리에 2×2×3). 꼴은 맞고 괄호 등 표기만 다르면 정답으로 하고 review에 적습니다.
- 인쇄된 빈칸(□, 괄호) 안에 쓴 작은 글씨도 학생 답입니다. 무응답으로 보기 전에 빈칸 안을 다시 확인합니다.
- 읽을 수 없는 문항은 지어내지 말고 checks에 적습니다.`;

const GRADE_KEY_RULE = `[답안지(정답)] 그림: 채점하지 말고 정답 확인에만 씁니다.
- 문항 번호를 맞춰 correctAnswer를 답안지 정답으로 씁니다. 직접 푼 답과 다르면 답안지를 따르고, checks에 "○번: 답안지 정답 ○, 직접 푼 답 ○"처럼 적습니다.
- 답안지에 없거나 알아보기 어려운 문항은 직접 풀고 review에 이유를 적습니다.
- criteria에 답안지 기준으로 채점했다고 적습니다.`;

const GRADE_ORIG_RULE = `[시험지 원문] 그림: 학생 글씨가 없는 원래 시험지입니다. 채점하지 말고 학생 글씨를 가려내는 기준으로만 씁니다.
- 같은 문항을 원문과 학생 시험지에서 견주어, 원문에 없이 새로 더해진 글씨·숫자·동그라미·체크만 학생 답으로 읽습니다. 인쇄된 숫자·보기를 학생 답으로 읽지 않게 주의합니다.
- 학생 글씨가 인쇄된 글자와 겹쳐 가려내기 어려우면 가장 그럴듯하게 읽고 review에 이유를 적습니다.`;

// 함께 보내는 사진에 맞춰 채점 지시문을 만듭니다.
function gradePrompt({ keyCount = 0, origCount = 0 } = {}) {
  return [GRADE_PROMPT, keyCount && GRADE_KEY_RULE, origCount && GRADE_ORIG_RULE].filter(Boolean).join('\n\n');
}

const PRACTICE_SCHEMA = {
  type: 'object',
  properties: {
    sets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          tip: { type: 'string' },
          problems: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                answer: { type: 'string' },
                explanation: { type: 'string' },
              },
              required: ['question', 'answer', 'explanation'],
              additionalProperties: false,
            },
          },
        },
        required: ['type', 'tip', 'problems'],
        additionalProperties: false,
      },
    },
  },
  required: ['sets'],
  additionalProperties: false,
};

const PRACTICE_PROMPT = `당신은 수학 학원 선생님을 도와 학생에게 줄 보충 문제를 만듭니다.
점수가 낮았던 유형과 그 유형에서 학생이 틀린 내용이 주어집니다. 유형마다 정해진 개수만큼 문제를 만드세요.

유형마다:
- type: 주어진 유형 이름을 글자 그대로
- tip: 이 유형을 풀 때 기억할 점, 학생 눈높이로 한두 문장
- problems: 문제마다 question(그림·표 없이 글로만 풀 수 있는 문제, 번호 없이), answer(정답만 짧게, 예: "56", "3 m 50 cm"), explanation(풀이 한두 문장)

규칙:
- 한국 초·중학교 교육과정과 틀린 문제의 수준에 맞추고, 학생이 틀린 내용을 집중해서 연습하게 합니다.
- 쉬운 문제부터 시험 수준까지 차근차근 어려워지게 하고, 계산 문제와 생활 속 문장제를 섞습니다. 틀린 문제를 베끼지 말고 숫자·물건을 바꿉니다.
- 답이 하나로 정해지는 문제만 만들고, 직접 풀어 정답과 풀이를 확인합니다. (예: "더 큰 것을 고르시오"인데 값이 모두 같으면 안 됨)
- 곱하기 ×, 나누기 ÷, 분수 3/4 처럼 쓰고, 마크다운과 이모지는 쓰지 않습니다.`;

// AI 앱은 답 모양을 강제할 수 없어서, 지시문 끝에 JSON 견본을 붙여 그대로 답하게 합니다.
const GRADE_EXAMPLE = '{"questions":[{"number":"1","type":"단원 이름","studentAnswer":"12","correctAnswer":"12","correct":true,"points":5,"earned":5,"reason":"","review":""}],"criteria":"","checks":[],"advice":"","note":""}';
const PRACTICE_EXAMPLE = '{"sets":[{"type":"유형 이름","tip":"","problems":[{"question":"","answer":"","explanation":""}]}]}';

// 사진 장수와 단원 정보를 알려 주는 요청 글. (답안지·원문을 어떻게 쓸지는 gradePrompt 의 규칙에 있어요)
function gradeText({ scanCount = 0, keyCount = 0, origCount = 0, topic = '', unitNames = [] }) {
  const photos = [`학생 시험지 ${scanCount}장`, keyCount && `답안지(정답) ${keyCount}장`, origCount && `시험지 원문 ${origCount}장`];
  return `이 시험지를 채점해 주세요. 함께 보낸 그림: ${photos.filter(Boolean).join(', ')}`
    + (topic ? `\n이 시험의 주제 단원: ${topic}` : '')
    + (unitNames.length ? `\ntype에 쓸 단원 이름 목록: ${unitNames.slice(0, 200).join(', ')}` : '');
}

function practiceText({ count, types }) {
  const n = Math.min(Math.max(+count || 5, 1), 10);
  const lines = [`유형마다 만들 문제 수: ${n}개`, ''];
  for (const t of types.slice(0, 6)) {
    lines.push(`[유형] ${t.type} (시험 점수 ${+t.earned}/${+t.max}점)`);
    for (const m of t.mistakes.slice(0, 8)) lines.push(`- 틀린 내용: ${m}`);
  }
  return lines.join('\n');
}

// 지시문 맨 앞에 붙이는 제목. (지시문인지 가릴 때는 이 제목이 아니라 아래 ANSWER_RULE 을 봅니다)
const PROMPT_MARK = '[onemath 채점 지시문]';

// 지시문 끝의 '답 모양' 안내. 이 문장이 들어 있으면 AI 답이 아니라 우리가 보낸 지시문입니다.
const ANSWER_RULE = '답은 설명 없이 아래 모양의 JSON 하나만 ```json 코드 블록 하나에 담아 주세요.';

// AI 앱에 붙여 보낼 한 덩어리 글 (지시문 + 요청 + 답 모양)
// JSON 을 한 줄로 쓰게 해서 답을 짧게 만듭니다. (제미나이 앱은 답이 길면 중간에 끊는 일이 많아요)
function handoffPrompt(system, request, example, extra = '') {
  return `${PROMPT_MARK}\n${system}\n\n---\n${request}${extra ? `\n${extra}` : ''}\n\n`
    + `${ANSWER_RULE} 키 이름은 그대로, 문항이 많아도 끝까지, 줄바꿈·주석 없이 한 줄로 쓰고, 이 지시문은 다시 옮겨 적지 마세요.\n`
    + example;
}

// 우리가 보낸 지시문(또는 지시문만 들어 있는 글)인지 봅니다.
// 표시 글자만으로 판단하면, 제미나이처럼 답 첫머리에 "[onemath 채점 지시문]에 따라…" 하고 표시를 되풀이하는 AI의 답까지 버리게 됩니다.
const isOwnPrompt = (text) => String(text || '').includes(ANSWER_RULE);

/* ---------- 붙여 넣은 AI 답 읽기 ----------
   AI 앱마다 복사되는 글 모양이 달라서 넉넉하게 읽습니다.
   - 제미나이: 코드 칸 없이 JSON 만 오거나, 설명·코드 칸이 여러 개 섞여 오고, 띄어쓰기가 줄바꿈 없는 공백(U+00A0)으로 바뀌어 오기도 합니다.
     True/False(파이썬 모양)나 // 주석을 넣는 일도 있습니다.
   - 공통: 둥근 따옴표, 끝에 남은 쉼표, 글 안에 그대로 들어간 줄바꿈 */
function parseAiJson(text) {
  const t = normalizeCopied(text);
  const candidates = jsonCandidates(t);
  if (!candidates.length) throw new Error('붙여 넣은 글에서 결과(JSON)를 찾지 못했어요. AI 답의 복사 버튼으로 답 전체를 복사해 주세요.');
  for (const c of candidates) {
    try { return JSON.parse(c); } catch {}
    try { return JSON.parse(repairJson(c)); } catch {}
  }
  throw new Error('AI 답이 중간에 끊겼거나 모양이 달라요. AI에게 "JSON을 처음부터 끝까지 다시 써 줘"라고 한 뒤 다시 복사해 주세요.');
}

// 복사하면서 섞여 들어온 보이지 않는 글자·특수 공백·둥근 따옴표를 보통 글자로 바꿉니다.
function normalizeCopied(text) {
  return String(text || '')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/[   　]/g, ' ')
    .replace(/[“”„″＂]/g, '"')
    .replace(/\r\n?/g, '\n')
    .trim();
}

// 글 안에서 JSON 으로 보이는 덩어리를 찾아, 그럴듯한 순서로 돌려줍니다.
// questions/sets 가 들어 있는 덩어리를 먼저, 그중 긴 것(=견본보다 진짜 답)을 먼저 봅니다.
function jsonCandidates(t) {
  const found = [];
  for (const m of t.matchAll(/```[a-zA-Z]*\s*([\s\S]*?)```/g)) found.push(...balancedObjects(m[1]));
  found.push(...balancedObjects(t));
  const score = (s) => (/"(questions|sets)"\s*:/.test(s) ? 1e9 : 0) + s.length;
  return [...new Set(found)].filter((s) => !isOwnPrompt(s)).sort((a, b) => score(b) - score(a));
}

// 글 안의 { … } 덩어리를 괄호 짝을 맞춰 모두 꺼냅니다. (따옴표 안의 괄호는 세지 않음, 끝이 잘렸으면 끝까지)
function balancedObjects(t) {
  const out = [];
  let i = t.indexOf('{');
  while (i >= 0) {
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let j = i; j < t.length; j++) {
      const ch = t[j];
      if (inString) {
        if (ch === '\\') j++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { end = j; break; }
    }
    if (end < 0) { out.push(t.slice(i)); break; }
    out.push(t.slice(i, end + 1));
    i = t.indexOf('{', end + 1);
  }
  return out;
}

// 흔한 모양 실수를 고칩니다: 글 안의 줄바꿈·탭, // 와 /* */ 주석, True/False/None, 끝에 남은 쉼표
function repairJson(json) {
  let out = '';
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inString) {
      if (ch === '\\') { out += ch + (json[++i] ?? ''); continue; }
      if (ch === '"') inString = false;
      if (ch === '\n') out += '\\n';
      else if (ch === '\t') out += '\\t';
      else out += ch;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && json[i + 1] === '/') { while (i < json.length && json[i] !== '\n') i++; continue; }
    if (ch === '/' && json[i + 1] === '*') { const e = json.indexOf('*/', i + 2); i = e < 0 ? json.length : e + 1; continue; }
    const word = /^(True|False|None)\b/.exec(json.slice(i, i + 5));
    if (word) { out += { True: 'true', False: 'false', None: 'null' }[word[1]]; i += word[1].length - 1; continue; }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/* ---------- 점수 계산 (server.py score_summary 와 같음, 덧셈은 AI에게 맡기지 않습니다) ---------- */
function scoreSummary(result) {
  const questions = (result.questions || []).filter((q) => q && typeof q === 'object');
  if (!questions.length) throw new Error('시험지에서 문항을 찾지 못했습니다.');
  // 배점이 하나도 보이지 않으면 100점 만점으로 똑같이 나눕니다. (문항 점수는 반올림하지 않아야 만점이 꼭 100점이 돼요)
  // 이때 AI는 earned 에 맞은 비율(0~1)을 적어 보내므로, 부분 점수도 그 비율로 매깁니다.
  if (!questions.some((q) => (+q.points || 0) > 0)) {
    const each = 100 / questions.length;
    const ratio = (q) => (q.correct === true || q.correct === 'true' ? 1 : Math.min(Math.max(+q.earned || 0, 0), 1));
    questions.forEach((q) => { q.earned = each * ratio(q); q.points = each; });
  }
  const types = new Map();
  for (const q of questions) {
    q.number = String(q.number ?? '');
    q.correct = q.correct === true || q.correct === 'true';
    q.points = Math.max(+q.points || 0, 0);
    q.earned = Math.min(Math.max(+q.earned || 0, 0), q.points);
    q.type = String(q.type || '기타').trim() || '기타';
    if (!types.has(q.type)) types.set(q.type, { type: q.type, earned: 0, max: 0, correct: 0, count: 0 });
    const t = types.get(q.type);
    t.earned += q.earned;
    t.max += q.points;
    t.correct += q.correct ? 1 : 0;
    t.count += 1;
  }
  const r1 = (x) => Math.round(x * 10) / 10;
  const numbers = (keep) => questions.filter(keep).map((q) => q.number);
  return {
    questions,
    types: [...types.values()].map((t) => ({ ...t, earned: r1(t.earned), max: r1(t.max) })),
    total: r1(questions.reduce((a, q) => a + q.earned, 0)),
    maxScore: r1(questions.reduce((a, q) => a + q.points, 0)),
    correctCount: questions.filter((q) => q.correct).length,
    correctNumbers: numbers((q) => q.correct),
    wrongNumbers: numbers((q) => !q.correct && q.earned === 0),
    partialNumbers: numbers((q) => !q.correct && q.earned > 0),
    reviewNumbers: numbers((q) => String(q.review || '').trim()),
    criteria: result.criteria || '',
    checks: (result.checks || []).map(String).filter((c) => c.trim()),
    advice: result.advice || '',
    note: result.note || '',
  };
}

// 빈 문제는 빼고, 문제가 하나도 없으면 실패로 봅니다.
function cleanPractice(result) {
  const sets = [];
  for (const s of result.sets || []) {
    const problems = (s.problems || []).filter((p) => p && String(p.question || '').trim() && String(p.answer || '').trim());
    if (problems.length) sets.push({ type: String(s.type || '보충 문제'), tip: String(s.tip || ''), problems });
  }
  if (!sets.length) throw new Error('보충 문제를 만들지 못했습니다.');
  return { sets };
}

/* ---------- API 키로 바로 부르기 ---------- */
// images: [{ label, dataUrl }]  → 고른 AI의 JSON 답을 객체로 돌려줍니다.
async function askAI({ system, text, images = [], schema, schemaName, effort = 'medium' }) {
  const key = (aiSettings.keys[aiSettings.tool] || '').trim();
  if (!key) throw new Error(`${currentTool().label} API 키가 없어요. 맨 위 'AI 선택'에서 키를 넣거나 '앱으로 보내기'를 골라 주세요.`);
  const parts = images.map((img) => {
    const [head, b64] = img.dataUrl.split(',');
    return { label: img.label, mime: head.replace('data:', '').replace(';base64', ''), b64, dataUrl: img.dataUrl };
  });
  const call = { chatgpt: callOpenAI, gemini: callGemini, claude: callClaude }[aiSettings.tool];
  return parseAiJson(await call({ key, model: currentModel(), system, text, parts, schema, schemaName, effort }));
}

async function readError(res, who) {
  const body = await res.json().catch(() => ({}));
  const msg = body.error?.message || body.error?.type || body.message || '';
  if (res.status === 401 || res.status === 403) return `${who} API 키가 맞지 않아요. (${msg || res.status})`;
  if (res.status === 429) return `${who} 사용량이 넘쳤어요. 잠시 뒤 다시 해 보세요. (${msg || res.status})`;
  return `${who} 오류 (${res.status}) ${msg}`;
}

async function callOpenAI({ key, model, system, text, parts, schema, schemaName }) {
  const content = [];
  for (const p of parts) content.push({ type: 'text', text: `[${p.label}]` }, { type: 'image_url', image_url: { url: p.dataUrl } });
  content.push({ type: 'text', text });
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
      response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
    }),
  });
  if (!res.ok) throw new Error(await readError(res, 'ChatGPT'));
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (msg?.refusal) throw new Error('AI가 이 요청에 답하지 않았습니다.');
  return msg?.content || '';
}

async function callGemini({ key, model, system, text, parts, schema }) {
  const contentParts = [];
  for (const p of parts) contentParts.push({ text: `[${p.label}]` }, { inline_data: { mime_type: p.mime, data: p.b64 } });
  contentParts.push({ text: `${text}\n결과는 JSON으로 써 주세요.` });
  const send = (withSchema) => fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: contentParts }],
        generationConfig: {
          responseMimeType: 'application/json',
          ...(withSchema ? { responseJsonSchema: schema } : {}),
          thinkingConfig: { thinkingLevel: 'low' },
        },
      }),
    },
  );
  let res = await send(true);
  if (res.status === 400) res = await send(false); // 모델이 답 모양 지정을 못 받으면 지시문만으로 다시 보냅니다.
  if (!res.ok) throw new Error(await readError(res, '제미나이'));
  const data = await res.json();
  const out = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  if (!out) throw new Error(`제미나이가 답을 주지 않았어요. (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || '빈 답'})`);
  return out;
}

// 이 모델들은 안전 검사로 답을 거절하면 서버가 다른 모델로 이어서 답하게 할 수 있습니다.
const CLAUDE_FALLBACK_MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];

async function callClaude({ key, model, system, text, parts, schema, effort }) {
  const content = [];
  for (const p of parts) {
    content.push({ type: 'text', text: `[${p.label}]` }, { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.b64 } });
  }
  content.push({ type: 'text', text });
  const fallback = CLAUDE_FALLBACK_MODELS.includes(model);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      ...(fallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
      // 서버 없이 폰 앱에서 바로 부를 때 필요한 표시입니다. (키는 이 폰에만 저장됩니다)
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      ...(fallback ? { fallbacks: 'default' } : {}),
      system,
      output_config: { effort, format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error(await readError(res, 'Claude'));
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('AI가 이 요청에 답하지 않았습니다.');
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}
