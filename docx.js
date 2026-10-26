/* 채점 결과를 Word(.docx) 파일로 만듭니다.
   외부 라이브러리 없이 docx 안의 XML 파일들을 직접 쓰고 zip(무압축)으로 묶어서, 인터넷이 없어도 동작합니다. */

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/* ---------- zip (무압축) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files, type) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // 파일 이름은 UTF-8
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(local, name, data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(dir, name);
    offset += 30 + name.length + data.length;
  }
  const dirSize = central.reduce((a, p) => a + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end], { type });
}

/* ---------- Word 문서 조각 ---------- */
// XML 에 넣을 수 없는 글자를 바꾸거나 뺍니다.
const xmlText = (s) => String(s ?? '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

// item: 글자 또는 { t, bold, color, size }   (줄바꿈 \n 은 줄바꿈으로 씁니다)
function wRun(item) {
  const o = typeof item === 'string' ? { t: item } : item;
  const props = [o.bold && '<w:b/>', o.color && `<w:color w:val="${o.color}"/>`, o.size && `<w:sz w:val="${o.size}"/><w:szCs w:val="${o.size}"/>`]
    .filter(Boolean).join('');
  const text = String(o.t ?? '').split('\n').map((t) => `<w:t xml:space="preserve">${xmlText(t)}</w:t>`).join('<w:br/>');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${text}</w:r>`;
}

// items: 글자 하나 또는 wRun 항목 목록 / o: { style, align, pageBreak, after, shade }
function wPara(items, o = {}) {
  const props = [
    o.style && `<w:pStyle w:val="${o.style}"/>`,
    o.pageBreak && '<w:pageBreakBefore/>',
    o.shade && `<w:shd w:val="clear" w:color="auto" w:fill="${o.shade}"/>`,
    o.after != null && `<w:spacing w:after="${o.after}"/>`,
    o.align && `<w:jc w:val="${o.align}"/>`,
  ].filter(Boolean).join('');
  const list = Array.isArray(items) ? items : [items];
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${list.map(wRun).join('')}</w:p>`;
}

// widths: 칸 너비 비율. 본문 너비(9638 twip)에 맞춰 나눕니다.
function wTable(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const tw = widths.map((w) => Math.round((9638 * w) / total));
  const cell = (item, i, head, fill) => `<w:tc><w:tcPr><w:tcW w:w="${tw[i]}" w:type="dxa"/>${
    fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}</w:tcPr>${
    wPara(head ? { t: item, bold: true } : item, { after: 0 })}</w:tc>`;
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D5D0F5"/>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="9638" w:type="dxa"/><w:tblBorders>${
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')
  }</w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>`
    + `<w:tblGrid>${tw.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`
    + `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headers.map((h, i) => cell(h, i, true, 'F0EDFF')).join('')}</w:tr>`
    + rows.map((r) => `<w:tr>${r.cells.map((c, i) => cell(c, i, false, r.fill)).join('')}</w:tr>`).join('')
    + '</w:tbl>' + wPara('', { after: 0 });
}

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic" w:eastAsia="맑은 고딕" w:cs="Malgun Gothic"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:b/><w:color w:val="16161D"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="2" w:color="B197FC"/></w:pBdr><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="5B3FD6"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="16161D"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
</w:styles>`;

function docxBlob(bodyXml) {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${bodyXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return makeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: DOCX_STYLES },
  ], DOCX_MIME);
}

/* ---------- 채점 결과 리포트 ---------- */
// info: { academy, student, teacher, period, grade }, score: scoreSummary 결과, practice: 보충 문제 (없으면 null)
function buildReportDocx({ info, score: s, practice }) {
  const f1 = (x) => String(+(+x).toFixed(1));
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const today = new Date().toLocaleDateString('ko-KR');
  const out = [];
  const h1 = (t) => out.push(wPara(t, { style: 'Heading1' }));
  const h2 = (t) => out.push(wPara(t, { style: 'Heading2' }));
  const line = (items, o) => out.push(wPara(items, o));
  const bullets = (list) => list.forEach((t) => line(`• ${t}`, { after: 40 }));

  line(`${info.student ? `${info.student} 학생 ` : ''}수학 시험지 채점 결과`, { style: 'Title' });
  line({ t: [info.academy, info.grade, info.period, `${info.teacher || '담임'} 선생님`, `작성일 ${today}`].filter(Boolean).join(' · '), color: '8A8A99' });

  h1('1. 채점 점수');
  line([{ t: '총점  ', bold: true }, { t: `${f1(s.total)} / ${f1(s.maxScore)}점`, bold: true, size: 32, color: '5B3FD6' },
    { t: `   (${pct(s.total, s.maxScore)}%, 정답 ${s.correctCount} / ${s.questions.length}문항)` }]);
  if (s.engine) line({ t: `${s.engine} 채점${s.usedAnswerKey ? ' · 답안지 확인' : ''}`, color: '8A8A99' });
  h2('유형별 점수');
  out.push(wTable(['유형', '점수', '맞은 문항', '비율'],
    s.types.map((t) => ({
      cells: [t.type, `${f1(t.earned)} / ${f1(t.max)}점`, `${t.correct} / ${t.count}`, `${pct(t.earned, t.max)}%`],
      fill: pct(t.earned, t.max) < 70 ? 'FFF0F0' : null,
    })), [5, 2.4, 1.8, 1.2]));

  const review = s.questions.filter((q) => String(q.review || '').trim());
  if (review.length) {
    h2(`선생님 확인이 필요한 문항 (${review.length}개)`);
    line({ t: '글씨를 알아보기 어렵거나 답이 애매해 AI가 확실하게 채점하지 못한 문항입니다. 시험지를 직접 보고 판단해 주세요.', color: '9A5300' });
    review.forEach((q) => line([{ t: `${q.number}번  `, bold: true },
      `AI가 읽은 답 ${q.studentAnswer} → ${q.correct ? '정답' : q.earned > 0 ? '부분 점수' : '오답'} 처리 (${f1(q.earned)}/${f1(q.points)}점). ${q.review}`], { after: 40 }));
  }

  h1('2. 상세 설명');
  h2('채점 기준');
  line(s.criteria || '시험지에 적힌 배점과 정답을 기준으로 채점했어요.');
  h2('번호로 보기');
  const nums = (list) => (list.length ? list.map((n) => `${n}번`).join(', ') : '없음');
  line([{ t: `맞은 문제 (${s.correctNumbers.length}): `, bold: true, color: '19B38A' }, nums(s.correctNumbers)]);
  if (s.partialNumbers.length) line([{ t: `부분 점수 (${s.partialNumbers.length}): `, bold: true, color: 'F08C00' }, nums(s.partialNumbers)]);
  line([{ t: `틀린 문제 (${s.wrongNumbers.length}): `, bold: true, color: 'E5484D' }, nums(s.wrongNumbers)]);

  h2('틀린 문제 살펴보기');
  const missed = s.questions.filter((q) => !q.correct);
  if (!missed.length) line('모든 문제를 맞혔어요!');
  missed.forEach((q) => line([
    { t: `${q.number}번 `, bold: true }, { t: `[${q.type}] `, color: '5B3FD6' },
    `학생 답 ${q.studentAnswer} → 정답 ${q.correctAnswer}`,
    ...(q.earned > 0 ? [{ t: ` (부분 점수 ${f1(q.earned)}/${f1(q.points)}점)`, color: 'F08C00' }] : []),
    ...(q.reason ? [{ t: `\n${q.reason}`, color: '6B6B7B' }] : []),
  ], { after: 80 }));

  if (s.checks.length) {
    h2('선생님 확인 필요');
    bullets(s.checks);
  }
  const weakest = s.types.filter((t) => t.max).sort((a, b) => a.earned / a.max - b.earned / b.max)[0];
  const advice = s.advice
    || (weakest && weakest.earned < weakest.max ? `${weakest.type} 유형 점수가 가장 낮아요 (${f1(weakest.earned)}/${f1(weakest.max)}점). 이 유형부터 복습해 주세요.` : '');
  if (advice) {
    h2('보완 포인트');
    line(advice, { shade: 'F6FFD6' });
  }
  if (s.note) line({ t: `참고: ${s.note}`, color: '8A8A99' });

  h2('문항별 채점 결과');
  out.push(wTable(['번호', '유형', '학생 답', '정답', '채점', '점수'],
    s.questions.map((q) => ({
      cells: [`${q.number}${String(q.review || '').trim() ? ' (확인)' : ''}`, q.type, q.studentAnswer, q.correctAnswer,
        q.correct ? 'O' : q.earned > 0 ? '△' : 'X', `${f1(q.earned)}/${f1(q.points)}`],
      fill: String(q.review || '').trim() ? 'FFF4E2' : q.correct ? null : 'FFF7F7',
    })), [1, 3, 2, 2, 0.9, 1.3]));

  if (practice?.sets?.length) {
    h1('3. 보충 문제');
    let n = 0;
    practice.sets.forEach((set) => {
      h2(set.type);
      if (set.tip) line({ t: `💡 ${set.tip}`, color: '5F6B17' }, { shade: 'F6FFD6' });
      set.problems.forEach((p) => {
        line([{ t: `${++n}. `, bold: true }, p.question], { after: 40 });
        line({ t: '답: ________________', color: '999999' }, { after: 200 });
      });
    });
    line('정답과 풀이', { style: 'Heading1', pageBreak: true });
    n = 0;
    practice.sets.forEach((set) => {
      h2(set.type);
      set.problems.forEach((p) => line([{ t: `${++n}. ${p.answer}  `, bold: true }, { t: p.explanation || '', color: '6B6B7B' }], { after: 60 }));
    });
  }
  return docxBlob(out.join(''));
}
