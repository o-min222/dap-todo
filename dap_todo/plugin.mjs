/**
 * DAP Todo — 할 일을 리스트/칸반으로 관리하고, 붙여넣은 글·이미지·메일에서 초안을 뽑는다.
 *
 * 자기완결 ESM: npm 의존성 없음 (node: 빌트인만 사용). DAP 메인 프로세스에서 돌기 때문에
 * fetch/setInterval/node:fs를 그대로 쓸 수 있고, UI 페이지는 CSP로 네트워크가 막혀 있어
 * 데이터는 전부 postMessage로 내려준다.
 *
 * 아래 순수 함수들은 scripts/check.mjs가 검증한다 — activate() 없이 단독 호출 가능.
 */
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 보류(hold) = 의도적으로 세워둔 일. 완료가 아니므로 미완으로 집계된다. */
const STATUSES = ["todo", "doing", "hold", "done"];
/**
 * 보류는 **먼저 꺼내지 않는다** — 말풍선 알림과 아침 브리핑에서 빠진다.
 * 사용자가 일부러 세워둔 걸 펫이 들쑤시면 안 된다. 목록·통계·"할 일 뭐 있어?"처럼
 * 사용자가 직접 물어보는 자리에는 그대로 나온다(숨기는 게 아니라 조용할 뿐).
 */
const isParked = (t) => t.status === "hold";
/** 빈 문자열 = 중요도 없음. 노션처럼 "굳이 안 정해도 되는" 속성으로 둔다. */
export const PRIORITIES = ["high", "medium", "low"];
const MAX_AI_CHARS = 120;
const REMIND_LEAD_MIN = 10;
const TICK_MS = 60_000;

/* ─────────────────────────── 순수 로직 ─────────────────────────── */

/** `YYYY-MM-DD` 또는 `YYYY-MM-DDTHH:mm`(datetime-local 원형) → Date. 없거나 깨졌으면 null. */
export function dueDate(task) {
  if (!task || typeof task.due !== "string" || !task.due) return null;
  const d = new Date(task.due);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
export const isSameDay = (a, b) => dayKey(a) === dayKey(b);

export const isOpen = (t) => t.status !== "done";

/** 신규 항목 정규화. 신뢰할 수 없는 입력(LLM 초안 포함)이 그대로 저장되지 않게 한다. */
export function normalizeTask(raw, now = new Date(), id = null) {
  const title = String(raw?.title ?? "").trim().slice(0, 200);
  if (!title) return null;
  const status = STATUSES.includes(raw?.status) ? raw.status : "todo";
  const tags = Array.isArray(raw?.tags)
    ? raw.tags.map((t) => String(t).trim().slice(0, 24)).filter(Boolean).slice(0, 6)
    : [];
  return {
    id: id ?? `t${now.getTime().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    title,
    notes: String(raw?.notes ?? "").trim().slice(0, 2000),
    status,
    priority: PRIORITIES.includes(raw?.priority) ? raw.priority : "",
    due: typeof raw?.due === "string" && raw.due.trim() ? raw.due.trim() : "",
    tags,
    order: Number.isFinite(raw?.order) ? raw.order : now.getTime(),
    createdAt: new Date(now).toISOString(),
    source: typeof raw?.source === "string" ? raw.source.slice(0, 24) : "manual",
  };
}

/**
 * 상태 변경은 전부 이 리듀서를 지난다 — 팔레트/채팅/트레이가 같은 규칙을 쓰도록.
 * 항상 새 배열을 반환하고, 알 수 없는 명령은 원본을 그대로 돌려준다.
 */
export function applyCommand(tasks, cmd, now = new Date()) {
  const list = Array.isArray(tasks) ? tasks : [];
  switch (cmd?.type) {
    case "add": {
      const task = normalizeTask(cmd.task, now);
      return task ? [...list, task] : list;
    }
    case "addMany": {
      const added = (Array.isArray(cmd.tasks) ? cmd.tasks : [])
        .map((t, i) => normalizeTask({ ...t, order: now.getTime() + i }, now))
        .filter(Boolean);
      return added.length ? [...list, ...added] : list;
    }
    case "move":
      if (!STATUSES.includes(cmd.status)) return list;
      return list.map((t) => (t.id === cmd.id ? { ...t, status: cmd.status } : t));
    case "toggle":
      return list.map((t) =>
        t.id === cmd.id ? { ...t, status: t.status === "done" ? "todo" : "done" } : t,
      );
    case "edit": {
      const patch = {};
      if (typeof cmd.title === "string" && cmd.title.trim()) patch.title = cmd.title.trim().slice(0, 200);
      if (typeof cmd.notes === "string") patch.notes = cmd.notes.slice(0, 2000);
      if (typeof cmd.due === "string") patch.due = cmd.due.trim();
      // 빈 문자열도 유효한 값(= 중요도 없음)이라 includes 검사 전에 따로 통과시킨다.
      if (cmd.priority === "" || PRIORITIES.includes(cmd.priority)) patch.priority = cmd.priority;
      if (Array.isArray(cmd.tags)) {
        patch.tags = cmd.tags.map((t) => String(t).trim().slice(0, 24)).filter(Boolean).slice(0, 6);
      }
      if (!Object.keys(patch).length) return list;
      return list.map((t) => (t.id === cmd.id ? { ...t, ...patch } : t));
    }
    case "delete":
      return list.filter((t) => t.id !== cmd.id);
    case "clearDone":
      return list.filter(isOpen);
    default:
      return list;
  }
}

/**
 * LLM 추출 응답 → 초안 배열. 모델은 코드펜스나 앞뒤 설명을 곧잘 덧붙이므로 첫 JSON 배열만
 * 건져낸다. 실패하면 빈 배열 — 호출자가 원문을 그대로 보여주고 수동 입력으로 떨어뜨린다.
 */
export function parseDraftJson(raw) {
  if (typeof raw !== "string") return [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => {
      const title = String(item?.title ?? item?.할일 ?? "").trim();
      if (!title) return null;
      const due = typeof item?.due === "string" ? item.due.trim() : "";
      const priority = String(item?.priority ?? "").trim().toLowerCase();
      return {
        title: title.slice(0, 200),
        notes: String(item?.notes ?? "").trim().slice(0, 2000),
        // 모델이 "미정"/"없음" 같은 값을 넣는 일이 잦다 — 날짜 모양만 통과시킨다.
        due: /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?$/.test(due) ? due.replace(" ", "T") : "",
        priority: PRIORITIES.includes(priority) ? priority : "",
        tags: Array.isArray(item?.tags) ? item.tags.map(String).slice(0, 6) : [],
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

/* ── 로컬 힌트 추출 ──
 * 노션 페이지에 본문을 치는 동안 속성(마감·중요도·태그)을 즉시 채우기 위한 것.
 * LLM은 한 번에 30~60초라 타이핑 중에는 못 쓴다 — 여기는 정규식만, AI 분석은 별도 버튼.
 */

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const pad2 = (n) => String(n).padStart(2, "0");
const dateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDays = (d, n) => {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
};
/** 그 주의 월요일. 주 경계는 한국 관례대로 월요일 시작. */
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));

/** 본문에서 마감일(date 부분)을 찾는다. 못 찾으면 null. */
function findDate(text, now) {
  const t = text.replace(/\s+/g, " ");
  let m;

  if ((m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t))) {
    return dateStr(new Date(+m[1], +m[2] - 1, +m[3]));
  }
  if ((m = /(\d{1,2})월\s*(\d{1,2})일/.exec(t))) {
    return dateStr(new Date(now.getFullYear(), +m[1] - 1, +m[2]));
  }
  // 8/5 — 시각(14:30)이나 분수와 헷갈리지 않게 숫자에 둘러싸이지 않은 것만.
  if ((m = /(?:^|[^\d:/])(\d{1,2})\/(\d{1,2})(?![\d:/])/.exec(t))) {
    const mo = +m[1];
    const day = +m[2];
    if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
      return dateStr(new Date(now.getFullYear(), mo - 1, day));
    }
  }
  if (/오늘/.test(t)) return dateStr(now);
  if (/내일/.test(t)) return dateStr(addDays(now, 1));
  if (/모레/.test(t)) return dateStr(addDays(now, 2));
  if (/글피/.test(t)) return dateStr(addDays(now, 3));

  if ((m = /(다음\s*주|담주|이번\s*주|금주)?\s*([일월화수목금토])요일/.exec(t))) {
    const target = WEEKDAYS.indexOf(m[2]);
    const monday = mondayOf(now);
    const offsetFromMonday = (target + 6) % 7; // 월=0 … 일=6
    if (/다음|담/.test(m[1] ?? "")) return dateStr(addDays(monday, 7 + offsetFromMonday));
    if (m[1]) return dateStr(addDays(monday, offsetFromMonday));
    // 수식어 없는 "금요일" = 오늘 포함 다음 도래일
    const ahead = (target - now.getDay() + 7) % 7;
    return dateStr(addDays(now, ahead));
  }
  if (/다음\s*주|담주/.test(t)) return dateStr(addDays(mondayOf(now), 7));
  return null;
}

/** 본문에서 시각(HH:mm)을 찾는다. 못 찾으면 null. */
function findTime(text) {
  let m;
  if ((m = /(\d{1,2}):(\d{2})/.exec(text))) {
    const h = +m[1];
    const min = +m[2];
    if (h <= 23 && min <= 59) return `${pad2(h)}:${pad2(min)}`;
  }
  // `시` 뒤에 올 수 있는 것을 제한한다 — 안 그러면 "2026-09-01 시작"의 "01 시"를 시각으로 읽는다.
  if ((m = /(오전|오후|아침|점심|저녁|밤|새벽)?\s*(\d{1,2})\s*시(?=$|[\s,.)\d]|에|까지|부터|반|분|경|쯤)\s*(반|(\d{1,2})\s*분)?/.exec(text))) {
    let h = +m[2];
    if (h > 23) return null;
    const period = m[1] ?? "";
    // 12시간제 표현이 붙었을 때만 보정한다. "14시"는 그대로 둔다.
    if (/오후|저녁|밤/.test(period) && h < 12) h += 12;
    if (/오전|아침|새벽/.test(period) && h === 12) h = 0;
    const min = m[3] === "반" ? 30 : m[4] ? +m[4] : 0;
    if (min > 59) return null;
    return `${pad2(h)}:${pad2(min)}`;
  }
  return null;
}

/**
 * 본문에서 마감·중요도·태그를 뽑는다. 값이 없으면 그 키를 아예 담지 않는다 —
 * 호출자가 "찾은 것만" 덮어쓸 수 있어야 사용자가 손으로 고친 값을 지우지 않는다.
 */
export function parseHints(text, now = new Date()) {
  const src = String(text ?? "");
  const out = {};
  if (!src.trim()) return out;

  const date = findDate(src, now);
  const time = findTime(src);
  if (date) out.due = time ? `${date}T${time}` : date;
  else if (time) out.due = `${dateStr(now)}T${time}`; // 날짜 없이 시각만 = 오늘

  // 급[함해하히] = 급함/급해/급하게/급하다/급히를 한 번에 잡는다.
  if (/긴급|급[함해하히]|최우선|중요|필수|asap|!!/i.test(src)) out.priority = "high";
  else if (/나중에|천천히|여유|언젠가|낮음|덜 급/i.test(src)) out.priority = "low";
  else if (/보통|중간/.test(src)) out.priority = "medium";

  const tags = [...src.matchAll(/#([^\s#,.]{1,24})/g)].map((m) => m[1]);
  if (tags.length) out.tags = [...new Set(tags)].slice(0, 6);

  return out;
}

/**
 * 상단 상태표시줄 수치. UI에 같은 로직을 복제하지 않으려고 여기서 계산해 내려보낸다
 * (팔레트는 별도 문서라 import를 못 한다).
 */
export function stats(tasks, now = new Date()) {
  const list = tasks ?? [];
  const open = list.filter(isOpen);
  const byDue = (pred) =>
    open.filter((t) => {
      const d = dueDate(t);
      return d ? pred(d) : false;
    }).length;
  const done = list.length - open.length;
  return {
    total: list.length,
    todo: list.filter((t) => t.status === "todo").length,
    doing: list.filter((t) => t.status === "doing").length,
    hold: list.filter(isParked).length,
    done,
    overdue: byDue((d) => d < now && !isSameDay(d, now)),
    today: byDue((d) => isSameDay(d, now)),
    high: open.filter((t) => t.priority === "high").length,
    percent: list.length ? Math.round((done / list.length) * 100) : 0,
  };
}

const STATUS_LABEL = { todo: "할 일", doing: "진행 중", hold: "보류", done: "완료" };
const PRIORITY_LABEL = { high: "높음", medium: "보통", low: "낮음" };

/**
 * 제목으로 할 일을 찾는다. 정확 일치 → 시작 일치 → 부분 일치 순.
 * 완료/보류보다 살아있는 항목을 먼저 집는다(같은 제목이 여러 번 나오는 흔한 경우).
 */
export function findTask(tasks, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return null;
  const rank = (t) => (t.status === "done" ? 2 : t.status === "hold" ? 1 : 0);
  const pick = (pred) =>
    (tasks ?? []).filter((t) => pred(String(t.title ?? "").toLowerCase())).sort((a, b) => rank(a) - rank(b))[0];
  return pick((s) => s === q) ?? pick((s) => s.startsWith(q)) ?? pick((s) => s.includes(q)) ?? null;
}

/**
 * 채팅에서 한 건의 전체 내용을 읽어줄 때 쓰는 텍스트. aiContext(300자)에는 못 담는 노트·자료를
 * 여기서 펼친다 — 요약은 상시, 상세는 요청 시라는 분담이다.
 */
export function detailText(task) {
  if (!task) return "";
  const lines = [`■ ${task.title}`];
  const meta = [STATUS_LABEL[task.status] ?? task.status];
  if (task.priority) meta.push(`중요도 ${PRIORITY_LABEL[task.priority]}`);
  if (task.due) meta.push(`마감 ${task.due.replace("T", " ")}`);
  if (task.tags?.length) meta.push(task.tags.map((x) => `#${x}`).join(" "));
  lines.push(meta.join(" · "));
  if (task.notes?.trim()) lines.push("", task.notes.trim().slice(0, 1500));
  return lines.join("\n");
}

/** 캘린더 등 다른 플러그인에 흘려보낼 마감 목록. 노트 같은 본문은 싣지 않는다. */
export function deadlinePayload(tasks) {
  return (tasks ?? [])
    .filter((t) => isOpen(t) && !isParked(t) && t.due)
    .map((t) => ({ id: t.id, title: t.title, due: t.due, priority: t.priority ?? "" }));
}

/** 매 대화 턴에 프롬프트로 들어가는 한 줄. 예산이 빡빡하므로 목록 덤프 금지. */
export function summarizeForAi(tasks, now = new Date()) {
  const open = (tasks ?? []).filter(isOpen);
  if (!open.length) return "";
  const overdue = open.filter((t) => {
    const d = dueDate(t);
    return d && d < now && !isSameDay(d, now);
  });
  const today = open.filter((t) => {
    const d = dueDate(t);
    return d && isSameDay(d, now);
  });
  const high = open.filter((t) => t.priority === "high");
  const held = open.filter(isParked);
  const parts = [`미완 ${open.length}건`];
  if (held.length) parts.push(`보류 ${held.length}건`);
  if (high.length) parts.push(`중요 ${high.length}건`);
  if (overdue.length) parts.push(`지난 마감 ${overdue.length}건`);
  if (today.length) parts.push(`오늘 마감: ${today.map((t) => t.title).join(", ")}`);
  return parts.join(" · ").slice(0, MAX_AI_CHARS);
}

/** 아침 브리핑 한 줄. 알릴 게 없으면 빈 문자열 — 호스트가 조용히 넘어간다.
 *  보류는 빠진다 — 세워둔 일을 아침부터 다시 들이밀지 않는다. */
export function briefingLine(tasks, now = new Date()) {
  const open = (tasks ?? []).filter((t) => isOpen(t) && !isParked(t));
  if (!open.length) return "";
  const due = open.filter((t) => {
    const d = dueDate(t);
    return d && d <= new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  });
  const head = `할 일 ${open.length}건`;
  if (!due.length) return head;
  return `${head} (오늘까지: ${due.map((t) => t.title).join(", ")})`.slice(0, 300);
}

/** 마감 lead분 이내이면서 아직 안 알린 항목. notified는 { [id]: dueISO }.
 *  보류는 알리지 않는다 — 사용자가 일부러 세워둔 일이다. */
export function dueSoon(tasks, now = new Date(), leadMinutes = REMIND_LEAD_MIN, notified = {}) {
  const limit = new Date(now.getTime() + leadMinutes * 60_000);
  return (tasks ?? []).filter((t) => {
    if (!isOpen(t) || isParked(t)) return false;
    const d = dueDate(t);
    if (!d || d > limit) return false;
    // 마감을 고쳐 다시 다가오면 재알림 — 같은 마감으로는 한 번만.
    return notified[t.id] !== t.due;
  });
}

/** 추출 프롬프트. 모델이 설명을 덧붙여도 parseDraftJson이 건져내지만, 우선 못 붙이게 막는다. */
export function extractionPrompt(text, todayISO) {
  return [
    "아래 내용에서 사용자가 해야 할 일만 뽑아 JSON 배열로만 답해.",
    '형식: [{"title":"짧은 할 일","due":"YYYY-MM-DD 또는 YYYY-MM-DDTHH:mm","priority":"high|medium|low","notes":"부연","tags":["태그"]}]',
    `오늘은 ${todayISO} 야. "내일", "다음 주 화요일" 같은 표현은 실제 날짜로 바꿔.`,
    "마감을 알 수 없으면 due 는 빈 문자열, 중요도를 알 수 없으면 priority 는 빈 문자열.",
    "할 일이 없으면 [] 만 답해.",
    "설명이나 코드펜스 없이 JSON 배열만 출력해.",
    "",
    "---",
    String(text ?? "").slice(0, 12000),
  ].join("\n");
}

/**
 * 등록 버튼을 누른 순간 AI에게 넘기는 프롬프트. parseDraftJson이 그대로 읽도록 배열로 받는다.
 * 붙여넣은 메일 한 통에 할 일이 여러 개일 수 있으므로 **여러 건도 허용**한다 — 1건이면 바로
 * 등록하고, 여러 건이면 확인 카드를 띄운다. 입력 지점을 하나로 모으기 위한 설계다.
 */
export function composePrompt(draft, todayISO) {
  return [
    "아래는 사용자가 방금 적은 메모야. 검토해서 깔끔한 할 일로 정리해줘.",
    "- 할 일이 하나면 1건, 여러 개가 섞여 있으면 여러 건으로 나눠줘.",
    "- title: 한눈에 보이는 짧은 제목 (군더더기·날짜 표현 제거)",
    "- notes: 남길 만한 세부 내용만. 없으면 빈 문자열",
    "- due/priority/tags: 메모에서 읽어낼 수 있으면 채우고, 아니면 빈 값",
    '형식: [{"title":"…","due":"YYYY-MM-DDTHH:mm","priority":"high|medium|low","notes":"…","tags":["…"]}]',
    `오늘은 ${todayISO} 야. "내일", "다음 주 화요일" 같은 표현은 실제 날짜로 바꿔.`,
    "설명이나 코드펜스 없이 JSON 배열만 출력해.",
    "",
    "---",
    `제목: ${String(draft?.title ?? "").slice(0, 200)}`,
    `내용: ${String(draft?.notes ?? "").slice(0, 4000)}`,
  ].join("\n");
}

/**
 * 채팅/음성 발화에서 명령 트리거를 떼어내 본문만 남긴다.
 * "할 일 추가 우유 사기" → "우유 사기". 트리거만 말했으면 빈 문자열.
 */
export function stripTrigger(text, triggers) {
  let out = String(text ?? "").trim();
  // 긴 트리거부터 지워야 "할 일 추가"가 "할 일"에 먼저 걸려 "추가"가 남지 않는다.
  for (const trigger of [...triggers].sort((a, b) => b.length - a.length)) {
    const idx = out.indexOf(trigger);
    if (idx >= 0) {
      out = (out.slice(0, idx) + out.slice(idx + trigger.length)).trim();
      break;
    }
  }
  return out.replace(/^[,:\-–—]\s*/, "").replace(/\s*(해줘|해 줘|해라|하기|등록해|추가해)$/, "").trim();
}

/**
 * AI가 다듬은 결과와 사용자가 적은 값을 합친다.
 * 제목·본문은 AI 정리본을 쓰되, **사용자가 직접 정한 마감/중요도/태그는 AI가 못 덮어쓴다** —
 * 사용자의 명시적 선택을 모델 추측으로 되돌리면 안 된다. 빈 칸만 AI가 채운다.
 */
export function mergeComposed(userDraft, aiDraft) {
  const u = userDraft ?? {};
  const a = aiDraft ?? {};
  return {
    title: (a.title || "").trim() || String(u.title ?? "").trim(),
    notes: (a.notes ?? "").trim() || String(u.notes ?? "").trim(),
    due: String(u.due ?? "").trim() || a.due || "",
    priority: String(u.priority ?? "").trim() || a.priority || "",
    tags: (Array.isArray(u.tags) && u.tags.length ? u.tags : a.tags) ?? [],
    // 칸반 컬럼에서 추가하면 그 컬럼으로 들어가야 한다 — AI가 정할 값이 아니다.
    ...(u.status ? { status: u.status } : {}),
    source: "compose",
  };
}

/* ─────────────────────────── 플러그인 배선 ─────────────────────────── */

export function activate(ctx) {
  const storage = ctx.host.storage;
  let tasks = [];
  let notified = {};
  let palette = null;
  let trayPanel = null;
  let view = "list";

  const load = async () => {
    tasks = (await storage.getJson("tasks")) ?? [];
    notified = (await storage.getJson("notified")) ?? {};
    if (!Array.isArray(tasks)) tasks = [];
  };
  const save = async () => {
    await storage.setJson("tasks", tasks);
    push();
    publishDeadlines();
  };

  /**
   * 마감 목록을 펫 이벤트 버스로 브로드캐스트한다 — 캘린더 플러그인이 날짜별 "할 일 N건"을
   * 그리는 데 쓴다. 플러그인끼리 직접 부르는 API는 없고, 이 버스가 유일한 정식 채널이다.
   * 브로드캐스트라 제목·마감 정도만 싣는다(노트는 절대 싣지 않는다).
   */
  const publishDeadlines = () => {
    try {
      ctx.host.events?.emit?.("todo.deadlines", { tasks: deadlinePayload(tasks) });
    } catch {
      /* 버스가 없어도 플러그인은 계속 돈다 */
    }
  };

  /** 살아있는 표면 전부에 현재 상태를 밀어준다. */
  const push = () => {
    const payload = { type: "todo.state", tasks, view, stats: stats(tasks) };
    try {
      palette?.postMessage(payload);
    } catch {
      /* 창이 닫혔으면 무시 */
    }
    try {
      trayPanel?.postMessage({ type: "todo.today", summary: summarizeForAi(tasks), tasks });
    } catch {
      /* 패널이 없으면 무시 */
    }
  };

  const run = async (cmd) => {
    tasks = applyCommand(tasks, cmd);
    await save();
  };

  /** 추출 → 초안. 실패해도 원문을 함께 돌려줘 사용자가 손으로 옮길 수 있게 한다. */
  const extract = async (text, timeoutS = 60) => {
    const today = new Date().toISOString().slice(0, 10);
    const reply = await ctx.host.llm.generate(extractionPrompt(text, today), timeoutS);
    return { drafts: parseDraftJson(reply), raw: String(reply ?? "") };
  };

  /**
   * 이미지 추출: ctx.host.llm.generate는 문자열 전용이라 비전 입력이 없다. 임시 파일로 쓰고
   * 경로를 프롬프트에 넣어 CLI가 직접 읽게 한다(codex는 read-only 샌드박스라 읽기 가능).
   * provider에 따라 실패할 수 있으므로 호출자가 raw를 그대로 보여준다.
   */
  const extractImage = async (dataUrl) => {
    const base64 = String(dataUrl ?? "").split(",")[1] ?? "";
    if (!base64) return { drafts: [], raw: "이미지를 읽지 못했어요." };
    const file = join(tmpdir(), `dap-todo-${Date.now()}.png`);
    writeFileSync(file, Buffer.from(base64, "base64"));
    try {
      const today = new Date().toISOString().slice(0, 10);
      const reply = await ctx.host.llm.generate(
        [
          `이미지 파일 ${file} 를 열어서 읽고, 거기 적힌 할 일을 JSON 배열로만 답해.`,
          extractionPrompt("(이미지 내용)", today),
        ].join("\n"),
        120,
      );
      return { drafts: parseDraftJson(reply), raw: String(reply ?? "") };
    } finally {
      rmSync(file, { force: true });
    }
  };

  /** 메일: 사용자 CLI에 붙은 Gmail 커넥터가 처리한다 — DAP은 메일 권한을 따로 받지 않는다. */
  const extractGmail = async (days = 3) => {
    const today = new Date().toISOString().slice(0, 10);
    const reply = await ctx.host.llm.generate(
      [
        `최근 ${days}일 받은 메일을 확인해서, 내가 해야 할 일을 뽑아줘.`,
        "메일을 읽을 수 없으면 [] 만 답해.",
        extractionPrompt("(메일 본문)", today),
      ].join("\n"),
      180,
    );
    return { drafts: parseDraftJson(reply), raw: String(reply ?? "") };
  };

  /**
   * 등록 경로의 단일 지점: 팔레트의 [등록]도, 채팅/음성의 "할 일 추가"도 여기를 지난다.
   * AI가 죽거나 느려도 사용자가 친 내용은 반드시 살아남는다 — 입력을 잃는 게 최악이다.
   */
  const composeDrafts = async (draft) => {
    let parsed = [];
    try {
      const reply = await ctx.host.llm.generate(
        composePrompt(draft, new Date().toISOString().slice(0, 10)),
        45,
      );
      parsed = parseDraftJson(reply);
    } catch {
      parsed = [];
    }
    if (parsed.length > 1) {
      return { many: true, drafts: parsed.map((d) => ({ ...d, source: "compose" })) };
    }
    return { many: false, task: mergeComposed(draft, parsed[0]) };
  };

  const openPalette = async () => {
    if (palette && !palette.isDestroyed?.()) {
      palette.show?.();
      push();
      return;
    }
    palette = await ctx.host.windows.openPalette({
      page: "palette/index.html",
      width: 760,
      height: 560,
      resizable: true,
      alwaysOnTop: false,
    });
    palette.onMessage(async (msg) => {
      switch (msg?.type) {
        case "todo.ready":
          push();
          break;
        case "todo.view":
          view = msg.view === "kanban" ? "kanban" : "list";
          push();
          break;
        case "todo.cmd":
          await run(msg.cmd);
          break;
        case "todo.hints":
          // 타이핑 중 속성 자동 채우기. 파서를 UI에 복제하지 않으려고 왕복시킨다 —
          // 같은 프로세스 IPC라 수 ms면 끝난다.
          palette.postMessage({
            type: "todo.hints.result",
            seq: msg.seq,
            hints: parseHints(msg.text),
          });
          break;
        case "todo.compose": {
          const result = await composeDrafts(msg.draft);
          if (result.many) {
            // 메일 한 통에 할 일이 여럿이면 바로 넣지 않고 확인 카드로 넘긴다.
            palette.postMessage({ type: "todo.drafts", drafts: result.drafts, raw: "" });
          } else {
            if (result.task.title) await run({ type: "add", task: result.task });
            palette.postMessage({ type: "todo.composed", task: result.task });
          }
          break;
        }
        case "todo.extract": {
          try {
            const result =
              msg.source === "image"
                ? await extractImage(msg.dataUrl)
                : msg.source === "gmail"
                  ? await extractGmail()
                  : await extract(
                      msg.source === "clipboard" ? ctx.host.clipboard.readText() : msg.text,
                    );
            // `into`는 그대로 되돌려준다 — 입력 페이지 안에서 부른 추출은 결과를 그 페이지에
            // 채워야 하고, 툴바에서 부른 것은 확인 카드를 띄워야 한다.
            palette.postMessage({ type: "todo.drafts", into: msg.into ?? "", ...result });
          } catch (e) {
            palette.postMessage({
              type: "todo.drafts",
              into: msg.into ?? "",
              drafts: [],
              raw: `추출에 실패했어요: ${e?.message ?? e}`,
            });
          }
          break;
        }
        default:
          break;
      }
    });
    push();
  };

  /* 등록 */
  ctx.actions.registerAction({ id: "open", callback: () => void openPalette() });
  ctx.actions.registerAction({
    id: "summary",
    callback: () => summarizeForAi(tasks) || "아직 등록한 할 일이 없어.",
  });
  /**
   * 한 건의 전체 내용(노트 포함)을 채팅으로 읽어준다. aiContext는 300자라 요약만 담기므로,
   * "그 할 일 자세히 알려줘" 류는 이 커맨드로 온다. LLM도 [[run_plugin]]으로 부를 수 있다.
   */
  const DETAIL_TRIGGERS = ["할 일 상세", "할일 상세", "할 일 자세히", "할일 자세히"];
  ctx.actions.registerAction({
    id: "detail",
    callback: (payload) => {
      const q = stripTrigger(payload?.text ?? "", DETAIL_TRIGGERS);
      if (!q) {
        const open = tasks.filter((t) => isOpen(t)).slice(0, 8);
        return open.length
          ? `어떤 걸 볼까? ${open.map((t) => `"${t.title}"`).join(", ")}`
          : "아직 등록한 할 일이 없어.";
      }
      const hit = findTask(tasks, q);
      return hit ? detailText(hit) : `"${q}" 로 찾은 할 일이 없어.`;
    },
  });
  ctx.commands.addCommand({
    id: "todo_detail",
    title: "할 일 상세",
    matchers: [{ type: "keyword", patterns: DETAIL_TRIGGERS, priority: 25 }],
    backend: { type: "builtin", handler: "detail" },
  });

  /**
   * 채팅/음성으로 등록. 음성은 DAP이 받아쓰기해 채팅 발화로 넣어주므로 이 한 경로로 둘 다 된다.
   * 반환 문자열이 그대로 펫의 답변이 된다.
   */
  const ADD_TRIGGERS = ["할 일 추가", "할일 추가", "할 일 등록", "할일 등록", "투두 추가", "todo 추가"];
  ctx.actions.registerAction({
    id: "add",
    callback: async (payload) => {
      const body = stripTrigger(payload?.text ?? "", ADD_TRIGGERS);
      if (!body) return "뭘 할 일로 넣을까? 예를 들어 \"할 일 추가 내일 3시까지 보고서\" 처럼 말해줘.";
      const result = await composeDrafts({ title: body, notes: "", ...parseHints(body) });
      if (result.many) {
        await run({ type: "addMany", tasks: result.drafts });
        return `할 일 ${result.drafts.length}건 넣었어: ${result.drafts.map((d) => d.title).join(", ")}`;
      }
      if (!result.task.title) return "할 일로 만들 내용을 못 찾았어. 다시 한 번 말해줄래?";
      await run({ type: "add", task: result.task });
      const when = result.task.due ? ` (${result.task.due.replace("T", " ")})` : "";
      return `할 일에 넣었어: "${result.task.title}"${when}`;
    },
  });
  ctx.commands.addCommand({
    id: "todo_add",
    title: "할 일 추가",
    // 열기/확인 커맨드보다 먼저 잡아야 "할 일 추가 …"가 "할 일"에 뺏기지 않는다.
    matchers: [{ type: "keyword", patterns: ADD_TRIGGERS, priority: 30 }],
    backend: { type: "builtin", handler: "add" },
  });

  ctx.commands.addCommand({
    id: "todo_open",
    title: "할 일 열기",
    matchers: [{ type: "keyword", patterns: ["할 일 열기", "할일 열기", "투두"], priority: 40 }],
    backend: { type: "builtin", handler: "open" },
  });
  ctx.commands.addCommand({
    id: "todo_summary",
    title: "할 일 확인",
    matchers: [{ type: "keyword", patterns: ["할 일 뭐", "할일 뭐", "남은 할 일"], priority: 40 }],
    backend: { type: "builtin", handler: "summary" },
  });

  ctx.trayMenu.addItem({ itemId: "open", label: "할 일", actionId: "open", showInContextMenu: true });
  ctx.radialMenu.addItem({ itemId: "open", label: "할 일", actionId: "open", priority: 60, icon: "icon.png" });

  ctx.aiContext.contribute({ id: "todo_summary", provider: () => summarizeForAi(tasks) });
  ctx.briefing.contribute({ id: "today", provider: () => briefingLine(tasks) });

  trayPanel = ctx.trayPanel.register({ id: "today", page: "tray/index.html", height: 180, priority: 20 });
  trayPanel.onMessage((msg) => {
    if (msg?.type === "todo.open") void openPalette();
    if (msg?.type === "todo.toggle") void run({ type: "toggle", id: msg.id });
  });

  ctx.settings.registerSettingsSection({
    sectionId: "general",
    title: "할 일",
    spec: {
      fields: [
        {
          key: "leadMinutes",
          label: "마감 알림 (분 전)",
          type: "range",
          default: REMIND_LEAD_MIN,
          min: 5,
          max: 60,
          step: 5,
          unit: "분",
        },
        { key: "remind", label: "마감 임박하면 말풍선으로 알리기", type: "toggle", default: true },
      ],
    },
  });

  // 마감 임박 알림. 앱이 켜져 있는 동안만 돈다 — OS 알림은 플러그인에 열려 있지 않다.
  const timer = setInterval(() => {
    void (async () => {
      const cfg = ctx.host.settings.values("general") ?? {};
      if (cfg.remind === false) return;
      const lead = Number.isFinite(cfg.leadMinutes) ? cfg.leadMinutes : REMIND_LEAD_MIN;
      const soon = dueSoon(tasks, new Date(), lead, notified);
      if (!soon.length) return;
      for (const t of soon) notified[t.id] = t.due;
      await storage.setJson("notified", notified);
      const head = soon[0];
      ctx.host.bubble.speak(
        soon.length === 1
          ? `"${head.title}" 마감이 곧이야.`
          : `마감 임박한 할 일이 ${soon.length}건 있어. 먼저 "${head.title}"부터.`,
      );
    })();
  }, TICK_MS);

  // 캘린더가 먼저 뜨면 아직 보낼 게 없으므로, 요청을 받으면 다시 쏴준다(기동 순서 무관).
  const offBus = ctx.host.events?.on?.((event) => {
    if (event === "todo.deadlines.request") publishDeadlines();
  });

  void load().then(() => {
    push();
    publishDeadlines();
  });

  return () => {
    clearInterval(timer);
    try {
      offBus?.();
    } catch {
      /* 이미 해제됐으면 무시 */
    }
    try {
      palette?.close?.();
    } catch {
      /* 이미 닫혔으면 무시 */
    }
    palette = null;
    trayPanel = null;
  };
}
