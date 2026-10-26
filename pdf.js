/* 채점 결과를 PDF 파일로 만듭니다.
   외부 라이브러리·글꼴 없이 폰에 있는 한글 글꼴로 A4 페이지를 캔버스에 그린 뒤,
   페이지마다 JPEG 그림으로 PDF 안에 넣습니다. 그래서 인터넷이 없어도 동작합니다. */

const PDF_MIME = 'application/pdf';

const PAGE_W = 595.28; // A4 (pt)
const PAGE_H = 841.89;
const MARGIN = 56.7; // 2cm
const BODY_W = PAGE_W - MARGIN * 2;
const PX_PER_PT = 2; // 1pt 를 캔버스 2px 로 그립니다 (약 144dpi)
const BASE = 10.5; // 본문 글자 크기 (pt)
const LINE = 1.5; // 줄 간격 (글자 크기의 배수)
const PDF_FONT = '"Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "Noto Sans KR", "Noto Sans CJK KR", sans-serif';

/* ---------- 글자 배치 ---------- */
// item: 글자 또는 { t, bold, color, size }   (줄바꿈 \n 은 줄바꿈으로 씁니다)
const runOf = (item) => (item && typeof item === 'object' ? item : { t: item });
const fontOf = (o) => `${o.bold ? 'bold ' : ''}${o.size || BASE}px ${PDF_FONT}`;

// 글자 조각들을 width 에 맞춰 줄로 나눕니다. 결과: [[{ o, t, x }, ...], ...]
function wrapRuns(ctx, items, width, base = {}) {
  const lines = [];
  let cur = [];
  let x = 0;
  const breakLine = () => { lines.push(cur); cur = []; x = 0; };
  (Array.isArray(items) ? items : [items]).forEach((raw) => {
    const o = { ...base, ...runOf(raw) };
    ctx.font = fontOf(o);
    String(o.t ?? '').split('\n').forEach((part, i) => {
      if (i) breakLine();
      part.split(/(\s+)/).forEach((tok) => {
        if (!tok) return;
        const w = ctx.measureText(tok).width;
        if (x + w > width && x > 0) {
          if (!tok.trim()) return; // 줄 끝 띄어쓰기는 버립니다
          breakLine();
        }
        if (w > width) { // 한 줄보다 긴 낱말은 글자 단위로 자릅니다
          for (const ch of tok) {
            const cw = ctx.measureText(ch).width;
            if (x + cw > width && x > 0) breakLine();
            cur.push({ o, t: ch, x });
            x += cw;
          }
          return;
        }
        cur.push({ o, t: tok, x });
        x += w;
      });
    });
  });
  breakLine();
  return lines;
}

const lineSize = (line) => Math.max(0, ...line.map((s) => s.o.size || BASE)) || BASE;

function drawLine(ctx, line, x0, top, lh) {
  const baseline = top + lh * 0.7;
  line.forEach((s) => {
    ctx.font = fontOf(s.o);
    ctx.fillStyle = `#${s.o.color || '222222'}`;
    ctx.fillText(s.t, x0 + s.x, baseline);
  });
}

/* ---------- 페이지 ---------- */
class PdfDoc {
  constructor() {
    this.pages = [];
    this.newPage();
  }

  newPage() {
    const c = document.createElement('canvas');
    c.width = Math.round(PAGE_W * PX_PER_PT);
    c.height = Math.round(PAGE_H * PX_PER_PT);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.scale(PX_PER_PT, PX_PER_PT);
    this.pages.push(c);
    this.ctx = ctx;
    this.y = MARGIN;
  }

  room() { return PAGE_H - MARGIN - this.y; }

  // 남은 공간이 h 보다 작으면 다음 페이지로 넘깁니다.
  ensure(h) { if (h > this.room() && this.y > MARGIN) this.newPage(); }

  // o: { after, shade, base }   shade: 배경색
  para(items, o = {}) {
    const pad = o.shade ? 5 : 0;
    const lines = wrapRuns(this.ctx, items, BODY_W - pad * 2, o.base);
    lines.forEach((line, i) => {
      const lh = lineSize(line) * LINE;
      const top = i === 0 ? pad : 0;
      const bottom = i === lines.length - 1 ? pad : 0;
      this.ensure(top + lh + bottom);
      if (o.shade) {
        this.ctx.fillStyle = `#${o.shade}`;
        this.ctx.fillRect(MARGIN, this.y, BODY_W, top + lh + bottom);
      }
      drawLine(this.ctx, line, MARGIN + pad, this.y + top, lh);
      this.y += top + lh + bottom;
    });
    this.y += o.after ?? 5;
  }

  title(t) { this.para({ t, bold: true, size: 18, color: '16161D' }, { after: 4 }); }

  h1(t, { pageBreak } = {}) {
    if (pageBreak) this.newPage();
    else if (this.y > MARGIN) this.y += 16;
    this.ensure(14 * LINE + 6 + BASE * LINE * 2); // 제목만 페이지 끝에 남지 않게
    this.para({ t, bold: true, size: 14, color: '5B3FD6' }, { after: 2 });
    this.ctx.strokeStyle = '#B197FC';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.moveTo(MARGIN, this.y);
    this.ctx.lineTo(MARGIN + BODY_W, this.y);
    this.ctx.stroke();
    this.y += 6;
  }

  h2(t) {
    if (this.y > MARGIN) this.y += 10;
    this.ensure(12 * LINE + BASE * LINE * 2);
    this.para({ t, bold: true, size: 12, color: '16161D' }, { after: 4 });
  }

  // widths: 칸 너비 비율 / rows: [{ cells, fill }]
  table(headers, rows, widths) {
    const total = widths.reduce((a, b) => a + b, 0);
    const cw = widths.map((w) => (BODY_W * w) / total);
    const padX = 5;
    const padY = 3;
    const lh = BASE * LINE;
    const layout = (cells, bold) => {
      const ls = cells.map((c, i) => wrapRuns(this.ctx, c, cw[i] - padX * 2, bold ? { bold: true } : {}));
      return { ls, h: Math.max(...ls.map((l) => l.length)) * lh + padY * 2 };
    };
    const draw = (row, fill) => {
      let x = MARGIN;
      row.ls.forEach((lines, i) => {
        if (fill) {
          this.ctx.fillStyle = `#${fill}`;
          this.ctx.fillRect(x, this.y, cw[i], row.h);
        }
        this.ctx.strokeStyle = '#D5D0F5';
        this.ctx.lineWidth = 0.5;
        this.ctx.strokeRect(x, this.y, cw[i], row.h);
        lines.forEach((line, j) => drawLine(this.ctx, line, x + padX, this.y + padY + j * lh, lh));
        x += cw[i];
      });
      this.y += row.h;
    };
    const head = layout(headers, true);
    const body = rows.map((r) => ({ ...layout(r.cells), fill: r.fill }));
    this.ensure(head.h + (body[0]?.h || 0));
    draw(head, 'F0EDFF');
    body.forEach((row) => {
      if (row.h > this.room()) { // 다음 페이지에서 머리글을 다시 그립니다
        this.newPage();
        draw(head, 'F0EDFF');
      }
      draw(row, row.fill);
    });
    this.y += 8;
  }

  // 페이지 번호를 넣고 PDF 파일로 묶습니다.
  toBlob() {
    const n = this.pages.length;
    this.pages.forEach((c, i) => {
      const ctx = c.getContext('2d');
      ctx.font = `8px ${PDF_FONT}`;
      ctx.fillStyle = '#999999';
      ctx.textAlign = 'center';
      ctx.fillText(`${i + 1} / ${n}`, PAGE_W / 2, PAGE_H - MARGIN / 2);
      ctx.textAlign = 'left';
    });
    return pdfFromCanvases(this.pages);
  }
}

/* ---------- PDF 파일 ---------- */
function dataUrlBytes(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 페이지마다 캔버스를 JPEG 로 바꿔 넣습니다. (toDataURL 은 동기라서 공유 버튼의 '사용자 동작'이 끊기지 않습니다)
function pdfFromCanvases(canvases) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let len = 0;
  const add = (p) => {
    const b = typeof p === 'string' ? enc.encode(p) : p;
    parts.push(b);
    len += b.length;
  };
  const begin = (id) => { offsets[id] = len; add(`${id} 0 obj\n`); };

  add(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // %PDF-1.4
  // 1: 카탈로그, 2: 페이지 목록, 페이지마다 3개 (페이지, 내용, 그림)
  begin(1); add('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  begin(2); add(`<< /Type /Pages /Kids [${canvases.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${canvases.length} >>\nendobj\n`);
  canvases.forEach((c, i) => {
    const id = 3 + i * 3;
    const jpg = dataUrlBytes(c.toDataURL('image/jpeg', 0.9));
    const content = `q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im0 Do Q`;
    begin(id);
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>\nendobj\n`);
    begin(id + 1);
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    begin(id + 2);
    add(`<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    add(jpg);
    add('\nendstream\nendobj\n');
  });
  const count = 3 + canvases.length * 3;
  const xref = len;
  let tail = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) tail += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  add(`${tail}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: PDF_MIME });
}

/* ---------- 채점 결과 리포트 ---------- */
// info: { academy, student, teacher, period, grade }, score: scoreSummary 결과, practice: 보충 문제 (없으면 null)
function buildReportPdf({ info, score: s, practice }) {
  const f1 = (x) => String(+(+x).toFixed(1));
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const today = new Date().toLocaleDateString('ko-KR');
  const d = new PdfDoc();
  const line = (items, o) => d.para(items, o);
  const bullets = (list) => list.forEach((t) => line(`• ${t}`, { after: 2 }));

  d.title(`${info.student ? `${info.student} 학생 ` : ''}수학 시험지 채점 결과`);
  line({ t: [info.academy, info.grade, info.period, `${info.teacher || '담임'} 선생님`, `작성일 ${today}`].filter(Boolean).join(' · '), color: '8A8A99' });

  d.h1('1. 채점 점수');
  line([{ t: '총점  ', bold: true }, { t: `${f1(s.total)} / ${f1(s.maxScore)}점`, bold: true, size: 16, color: '5B3FD6' },
    { t: `   (${pct(s.total, s.maxScore)}%, 정답 ${s.correctCount} / ${s.questions.length}문항)` }]);
  if (s.engine) line({ t: `${s.engine} 채점${s.usedAnswerKey ? ' · 답안지 확인' : ''}`, color: '8A8A99' });
  d.h2('유형별 점수');
  d.table(['유형', '점수', '맞은 문항', '비율'],
    s.types.map((t) => ({
      cells: [t.type, `${f1(t.earned)} / ${f1(t.max)}점`, `${t.correct} / ${t.count}`, `${pct(t.earned, t.max)}%`],
      fill: pct(t.earned, t.max) < 70 ? 'FFF0F0' : null,
    })), [5, 2.4, 1.8, 1.2]);

  const review = s.questions.filter((q) => String(q.review || '').trim());
  if (review.length) {
    d.h2(`선생님 확인이 필요한 문항 (${review.length}개)`);
    line({ t: '글씨를 알아보기 어렵거나 답이 애매해 AI가 확실하게 채점하지 못한 문항입니다. 시험지를 직접 보고 판단해 주세요.', color: '9A5300' });
    review.forEach((q) => line([{ t: `${q.number}번  `, bold: true },
      `AI가 읽은 답 ${q.studentAnswer} → ${q.correct ? '정답' : q.earned > 0 ? '부분 점수' : '오답'} 처리 (${f1(q.earned)}/${f1(q.points)}점). ${q.review}`], { after: 2 }));
  }

  d.h1('2. 상세 설명');
  d.h2('채점 기준');
  line(s.criteria || '시험지에 적힌 배점과 정답을 기준으로 채점했어요.');
  d.h2('번호로 보기');
  const nums = (list) => (list.length ? list.map((n) => `${n}번`).join(', ') : '없음');
  line([{ t: `맞은 문제 (${s.correctNumbers.length}): `, bold: true, color: '19B38A' }, nums(s.correctNumbers)]);
  if (s.partialNumbers.length) line([{ t: `부분 점수 (${s.partialNumbers.length}): `, bold: true, color: 'F08C00' }, nums(s.partialNumbers)]);
  line([{ t: `틀린 문제 (${s.wrongNumbers.length}): `, bold: true, color: 'E5484D' }, nums(s.wrongNumbers)]);

  d.h2('틀린 문제 살펴보기');
  const missed = s.questions.filter((q) => !q.correct);
  if (!missed.length) line('모든 문제를 맞혔어요!');
  missed.forEach((q) => line([
    { t: `${q.number}번 `, bold: true }, { t: `[${q.type}] `, color: '5B3FD6' },
    `학생 답 ${q.studentAnswer} → 정답 ${q.correctAnswer}`,
    ...(q.earned > 0 ? [{ t: ` (부분 점수 ${f1(q.earned)}/${f1(q.points)}점)`, color: 'F08C00' }] : []),
    ...(q.reason ? [{ t: `\n${q.reason}`, color: '6B6B7B' }] : []),
  ], { after: 4 }));

  if (s.checks.length) {
    d.h2('선생님 확인 필요');
    bullets(s.checks);
  }
  const weakest = s.types.filter((t) => t.max).sort((a, b) => a.earned / a.max - b.earned / b.max)[0];
  const advice = s.advice
    || (weakest && weakest.earned < weakest.max ? `${weakest.type} 유형 점수가 가장 낮아요 (${f1(weakest.earned)}/${f1(weakest.max)}점). 이 유형부터 복습해 주세요.` : '');
  if (advice) {
    d.h2('보완 포인트');
    line(advice, { shade: 'F6FFD6' });
  }
  if (s.note) line({ t: `참고: ${s.note}`, color: '8A8A99' });

  d.h2('문항별 채점 결과');
  d.table(['번호', '유형', '학생 답', '정답', '채점', '점수'],
    s.questions.map((q) => ({
      cells: [`${q.number}${String(q.review || '').trim() ? ' (확인)' : ''}`, q.type, q.studentAnswer, q.correctAnswer,
        q.correct ? 'O' : q.earned > 0 ? '△' : 'X', `${f1(q.earned)}/${f1(q.points)}`],
      fill: String(q.review || '').trim() ? 'FFF4E2' : q.correct ? null : 'FFF7F7',
    })), [1, 3, 2, 2, 0.9, 1.3]);

  if (practice?.sets?.length) {
    d.h1('3. 보충 문제');
    let n = 0;
    practice.sets.forEach((set) => {
      d.h2(set.type);
      if (set.tip) line({ t: `💡 ${set.tip}`, color: '5F6B17' }, { shade: 'F6FFD6' });
      set.problems.forEach((p) => {
        line([{ t: `${++n}. `, bold: true }, p.question], { after: 2 });
        line({ t: '답: ________________', color: '999999' }, { after: 10 });
      });
    });
    d.h1('정답과 풀이', { pageBreak: true });
    n = 0;
    practice.sets.forEach((set) => {
      d.h2(set.type);
      set.problems.forEach((p) => line([{ t: `${++n}. ${p.answer}  `, bold: true }, { t: p.explanation || '', color: '6B6B7B' }], { after: 3 }));
    });
  }
  return d.toBlob();
}
