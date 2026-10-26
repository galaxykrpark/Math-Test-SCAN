/* AI 연결 (onemath2: 앱으로 보내기는 누르는 즉시 공유 창, 돌아오면 클립보드의 답을 자동으로 읽음)
   - 앱으로 보내기: 사진과 지시문을 폰의 ChatGPT·제미나이·Claude 앱으로 공유하고, AI 답(JSON)을 복사해 와서 붙여 넣습니다.
   - API 키: 이 폰에 저장한 키로 앱 안에서 바로 AI를 불러 자동으로 채점합니다.
   지시문(GRADE_PROMPT, PRACTICE_PROMPT)과 점수 계산은 PC용 server.py 와 같습니다. */

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

const GRADE_PROMPT = `당신은 수학 학원 선생님을 도와 학생 시험지를 채점하는 도우미입니다.
학생이 푼 시험지를 스캔한 그림이 주어집니다. 그림이 여러 장이면 이어지는 한 시험지로 보고 모든 문항을 빠짐없이 채점해 주세요.

문항마다 다음을 적습니다.
- number: 시험지에 적힌 문항 번호 (예: "1", "12", "서술형 2")
- type: 문제 유형. 중·고등 수학 단원 기준의 짧은 이름으로 씁니다 (예: "일차방정식의 활용", "도형의 넓이", "인수분해"). 같은 유형은 반드시 같은 이름으로 써서 유형별로 묶을 수 있게 합니다.
- studentAnswer: 학생이 쓴 답. 비어 있으면 "(무응답)"
- correctAnswer: 정답. 문제를 직접 풀어 구합니다.
- correct: 학생 답이 정답과 같으면 true
- points: 시험지에 적힌 배점. 배점이 보이지 않으면 0
- earned: 받은 점수. 맞으면 points, 틀리면 0. 서술형이나 답이 여러 칸인 문항에서 일부만 맞으면 부분 점수를 줄 수 있습니다.
- reason: 틀렸거나 부분 점수인 이유를 한 문장으로 씁니다 (예: "6×7을 41로 계산함", "340은 맞지만 단위를 m로 씀"). 맞은 문항은 빈 문자열입니다.
- review: AI가 확실하게 채점하기 어려워 선생님이 시험지를 직접 보고 판단해야 하는 경우, 그 이유를 한 문장으로 씁니다. 확실하면 빈 문자열입니다.
  이런 경우에 씁니다: 필기체나 흘려 쓴 글씨라 숫자·기호를 알아보기 어려울 때 (예: 1과 7, 4와 9, 0과 6, < 와 >), 지우다 만 흔적이나 덧쓴 답이 있어 최종 답을 알 수 없을 때, 답을 두 가지 이상으로 읽을 수 있을 때, 답 칸 밖에 써서 어느 것이 답인지 애매할 때, 서술형 풀이가 맞는지 판단이 애매할 때.
  이때도 가장 그럴듯하게 읽은 답으로 studentAnswer, correct, earned 를 채우고, review 에는 어떻게 읽힐 수 있는지 함께 적습니다 (예: "답이 7인지 1인지 알아보기 어려움, 7로 읽고 정답 처리함").

시험지 전체에 대해 다음도 적습니다.
- criteria: 채점 기준을 한두 문장으로 설명합니다 (예: 배점이 없어 문항당 몇 점으로 했는지, 부분 점수를 어떻게 줬는지).
- checks: 선생님이 직접 확인해야 할 점의 목록. 글씨를 알아보기 어려운 문항, 시험지 인쇄 오류 등. 없으면 빈 목록입니다.
- advice: 가장 시급하게 보완할 유형과 이유를 한두 문장으로 씁니다.
- note: 그 밖에 알아 둘 점을 한 문장으로 씁니다. 없으면 빈 문자열입니다.

지켜야 할 것:
- 선생님이 이미 채점 표시(O, X, ✓, 빗금 등)를 했다면 그 표시를 따릅니다. 표시가 없으면 직접 풀어서 판단합니다.
- 그림에서 읽을 수 없는 문항은 지어내지 말고 checks에 적습니다.
- type에 쓸 단원 이름 목록이 주어지면, 문항이 속한 단원 이름을 그 목록에서 골라 글자 그대로 씁니다.

답안지(정답) 그림이 함께 주어지면:
- 학생 시험지 그림과 답안지 그림은 따로 표시해서 보냅니다. 답안지는 채점하지 말고 정답을 확인하는 데만 씁니다.
- 문항 번호를 맞춰서 correctAnswer 를 답안지의 정답으로 씁니다.
- 직접 푼 답과 답안지 정답이 다르면 답안지를 따르고, checks 에 "몇 번은 답안지 정답(○)과 직접 푼 답(○)이 달라 답안지를 따름"처럼 적어 선생님이 확인하게 합니다.
- 답안지에 없는 문항이나 답안지 글씨를 알아보기 어려운 문항은 직접 풀어서 채점하고, 그 문항의 review 에 이유를 적습니다.
- criteria 에 답안지를 기준으로 채점했다고 적습니다.

시험지 원문 그림이 함께 주어지면:
- 시험지 원문은 학생이 아무것도 쓰지 않은 원래 시험지입니다. 채점하지 말고, 학생 글씨를 가려내는 기준으로만 씁니다.
- 학생 시험지에서 시험지 원문에 인쇄되어 있는 글자·숫자·그림·보기 번호·밑줄·빈칸 표시는 학생이 쓴 것이 아닙니다. 시험지 원문에 없는 내용만 학생이 직접 쓴 것입니다.
- 학생 답을 읽을 때는 같은 문항을 시험지 원문과 학생 시험지에서 하나하나 견주어 보고, 원문에 없이 새로 더해진 글씨·숫자·동그라미·체크 표시만 studentAnswer 로 읽습니다. 문제에 인쇄된 숫자나 보기를 학생 답으로 잘못 읽지 않도록 특히 꼼꼼히 살핍니다.
- 학생 글씨가 인쇄된 글자와 겹치거나 바로 붙어 있어 무엇이 학생 글씨인지 가려내기 어려우면, 가장 그럴듯하게 읽고 그 문항의 review 에 이유를 적습니다.`;

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

const PRACTICE_PROMPT = `당신은 수학 학원 선생님을 도와 학생에게 줄 보충 문제를 만드는 도우미입니다.
학생의 학년, 점수가 낮았던 문제 유형, 그 유형에서 학생이 틀린 내용이 주어집니다. 유형마다 보충 문제를 정해진 개수만큼 만들어 주세요.

유형마다 다음을 적습니다.
- type: 주어진 유형 이름을 글자 그대로 씁니다.
- tip: 이 유형을 풀 때 기억할 점을 학생 눈높이에서 한두 문장으로 씁니다.
- problems: 보충 문제 목록. 문제마다
  - question: 문제. 그림이나 표 없이 글로만 풀 수 있게 씁니다. 번호는 붙이지 않습니다.
  - answer: 정답만 짧게 씁니다 (예: "56", "3 m 50 cm", "△").
  - explanation: 풀이를 학생이 이해할 수 있게 한두 문장으로 씁니다.

지켜야 할 것:
- 한국 초·중학교 수학 교육과정의 해당 학년 수준에 맞춥니다. 학년이 없으면 틀린 문제의 수준에 맞춥니다.
- 학생이 틀린 내용(예: 7단 곱셈, 단위 바꾸기)을 집중해서 연습할 수 있게 만듭니다.
- 쉬운 문제부터 시작해 시험 문제와 비슷한 수준까지 차근차근 어려워지게 배열합니다.
- 계산 문제와 생활 속 문장제를 섞습니다. 틀린 문제를 그대로 베끼지 말고 숫자, 순서, 물건을 바꿔서 만듭니다.
- 정답이 하나로 정해지는 문제만 만들고, 정답과 풀이가 맞는지 직접 풀어서 확인합니다.
- 묻는 조건에 맞는 답이 반드시 있어야 합니다. 예를 들어 "더 큰 것을 고르시오"라고 물으면서 보기의 값이 모두 같게 만들지 않습니다.
- 곱하기는 ×, 나누기는 ÷, 분수는 3/4 처럼 씁니다. 마크다운과 이모지는 쓰지 않습니다.`;

// AI 앱은 답 모양을 강제할 수 없어서, 지시문 끝에 JSON 견본을 붙여 그대로 답하게 합니다.
const GRADE_EXAMPLE = '{"questions":[{"number":"1","type":"단원 이름","studentAnswer":"12","correctAnswer":"12","correct":true,"points":5,"earned":5,"reason":"","review":""}],"criteria":"","checks":[],"advice":"","note":""}';
const PRACTICE_EXAMPLE = '{"sets":[{"type":"유형 이름","tip":"","problems":[{"question":"","answer":"","explanation":""}]}]}';

function gradeText({ keyCount, origCount = 0, hint, unitNames }) {
  return '이 시험지를 채점해 주세요.'
    + (keyCount ? `\n답안지(정답) 그림 ${keyCount}장이 함께 있습니다. 정답은 답안지를 기준으로 확인해 주세요.` : '')
    + (origCount ? `\n시험지 원문 그림 ${origCount}장이 함께 있습니다. 학생 시험지에서 시험지 원문에 없는 내용만 학생이 쓴 것이니, 학생 글씨와 인쇄된 원문 글을 잘 살펴 구분해 주세요.` : '')
    + (hint ? `\n참고: 지금 배우는 단원은 ${hint} 입니다.` : '')
    + (unitNames.length ? `\ntype에 쓸 단원 이름 목록: ${unitNames.slice(0, 200).join(', ')}` : '');
}

function practiceText({ grade, count, types }) {
  const n = Math.min(Math.max(+count || 5, 1), 10);
  const lines = [`학년: ${grade || '미입력'}`, `유형마다 만들 문제 수: ${n}개`, ''];
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
    + `${ANSWER_RULE} 글자 그대로의 키 이름을 쓰고, 문항이 많아도 끝까지 빠짐없이 씁니다.`
    + ' 들여쓰기·줄바꿈 없이 한 줄로 쓰고, JSON 안에 주석(//)을 넣지 마세요. 답 앞뒤에 이 지시문을 다시 옮겨 적지 마세요.\n'
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
  // 배점이 하나도 보이지 않으면 100점 만점으로 똑같이 나눕니다.
  if (!questions.some((q) => (+q.points || 0) > 0)) {
    const each = Math.round((100 / questions.length) * 10) / 10;
    questions.forEach((q) => { q.points = each; q.earned = q.correct ? each : 0; });
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
