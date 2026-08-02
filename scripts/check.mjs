/**
 * dap-todo 릴리스 게이트. 프레임워크 없이 node:assert + node:vm 만 쓴다.
 *   node scripts/check.mjs
 *
 * 검증 대상: 매니페스트/파일 존재, UI 스크립트 문법(코드펜스 안 JS가 실제로 파싱되는지),
 * 그리고 plugin.mjs가 export한 순수 로직(리듀서·추출 파서·요약·알림 선별).
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const plugin = await import(new URL("dap_todo/plugin.mjs", root));

/* ── 패키징 ── */
const manifest = read("plugin.yaml");
assert.match(manifest, /^id: io\.github\.o-min222\.todo$/m, "manifest id는 카탈로그 id와 같아야 한다");
assert.match(manifest, /^entry: dap_todo\.plugin:activate$/m);
for (const slot of ["tray_panel", "briefing.daily"]) {
  assert.ok(manifest.includes(slot), `surface_slots에 ${slot}이 있어야 한다`);
}
assert.ok(manifest.includes("todo_summary"), "context_contributors 선언이 없으면 activate가 던진다");
for (const file of ["README.md", "LICENSE", "palette/index.html", "tray/index.html"]) {
  assert.ok(read(file).length > 100, `${file}이 릴리스에 포함돼야 한다`);
}
// 래디얼이 icon.png를 참조한다 — 없으면 첫 글자 아바타로 조용히 떨어진다(DAP은 앱 아이콘을 빌려주지 않는다).
const icon = readFileSync(new URL("icon.png", root));
assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "icon.png는 실제 PNG여야 한다");
assert.ok(icon.length < 512 * 1024, "icon.png는 512KB 미만이어야 로드된다");
// 설치기는 파일을 그대로 내려받는다 — 번들 단계가 없으니 npm 의존성이 있으면 부팅 때 죽는다.
const source = read("dap_todo/plugin.mjs");
assert.ok(source.includes('icon: "icon.png"'), "래디얼 등록이 아이콘을 가리켜야 한다");
for (const [, spec] of source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)) {
  assert.ok(spec.startsWith("node:"), `자기완결이어야 한다 — bare import 발견: ${spec}`);
}

/* ── UI 스크립트 문법 (여기서 실제로 오타를 잡는다) ── */
for (const page of ["palette/index.html", "tray/index.html"]) {
  const scripts = [...read(page).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length, `${page}에 script가 있어야 한다`);
  scripts.forEach((m, i) => new vm.Script(m[1], { filename: `${page}#${i + 1}` }));
}
// UI 페이지는 CSP로 connect-src 'none' — 네트워크를 부르면 조용히 실패한다.
for (const page of ["palette/index.html", "tray/index.html"]) {
  assert.doesNotMatch(read(page), /\bfetch\s*\(|XMLHttpRequest|WebSocket/, `${page}는 네트워크를 쓸 수 없다`);
}

/* ── 리듀서 ── */
const now = new Date("2026-08-02T09:00:00");
let tasks = plugin.applyCommand([], { type: "add", task: { title: "보고서" } }, now);
assert.equal(tasks.length, 1);
assert.equal(tasks[0].status, "todo");
assert.equal(tasks[0].source, "manual");
assert.equal(plugin.applyCommand([], { type: "add", task: { title: "   " } }, now).length, 0, "빈 제목은 거부");

tasks = plugin.applyCommand(tasks, { type: "toggle", id: tasks[0].id }, now);
assert.equal(tasks[0].status, "done");
tasks = plugin.applyCommand(tasks, { type: "toggle", id: tasks[0].id }, now);
assert.equal(tasks[0].status, "todo", "toggle은 왕복해야 한다");

tasks = plugin.applyCommand(tasks, { type: "move", id: tasks[0].id, status: "doing" }, now);
assert.equal(tasks[0].status, "doing");
assert.equal(
  plugin.applyCommand(tasks, { type: "move", id: tasks[0].id, status: "bogus" }, now)[0].status,
  "doing",
  "알 수 없는 상태는 무시",
);
assert.deepEqual(plugin.applyCommand(tasks, { type: "nope" }, now), tasks, "모르는 명령은 원본 유지");

const before = tasks;
tasks = plugin.applyCommand(tasks, { type: "edit", id: tasks[0].id, title: "보고서 마무리" }, now);
assert.equal(tasks[0].title, "보고서 마무리");
assert.notEqual(tasks, before, "리듀서는 항상 새 배열을 반환한다");
tasks = plugin.applyCommand(tasks, { type: "delete", id: tasks[0].id }, now);
assert.equal(tasks.length, 0);

const many = plugin.applyCommand([], { type: "addMany", tasks: [{ title: "a" }, { title: "" }, { title: "b" }] }, now);
assert.equal(many.length, 2, "빈 제목은 걸러진다");
assert.notEqual(many[0].id, many[1].id, "id는 겹치면 안 된다");
assert.equal(plugin.applyCommand([{ id: "x", status: "done" }], { type: "clearDone" }).length, 0);

// 신뢰할 수 없는 입력이 그대로 저장되지 않는다.
const dirty = plugin.normalizeTask({ title: "x".repeat(500), tags: ["a", "b", "c", "d", "e", "f", "g"], status: "hacked" }, now);
assert.equal(dirty.title.length, 200);
assert.equal(dirty.tags.length, 6);
assert.equal(dirty.status, "todo");

/* ── 추출 파서 ── */
assert.deepEqual(plugin.parseDraftJson('[{"title":"우유 사기","due":"2026-08-03"}]').map((d) => d.title), ["우유 사기"]);
assert.equal(plugin.parseDraftJson('```json\n[{"title":"회의 준비"}]\n```')[0].title, "회의 준비", "코드펜스를 벗겨야 한다");
assert.equal(
  plugin.parseDraftJson('알겠습니다!\n[{"title":"장보기"}]\n도움이 되었길').length,
  1,
  "모델의 앞뒤 수다를 건너뛰어야 한다",
);
assert.equal(plugin.parseDraftJson('[{"title":"x","due":"미정"}]')[0].due, "", "날짜가 아닌 due는 버린다");
assert.equal(plugin.parseDraftJson('[{"title":"x","due":"2026-08-03 14:30"}]')[0].due, "2026-08-03T14:30");
assert.deepEqual(plugin.parseDraftJson("죄송해요, 찾지 못했습니다"), [], "JSON이 없으면 빈 배열");
assert.deepEqual(plugin.parseDraftJson("[not json"), []);
assert.deepEqual(plugin.parseDraftJson(null), []);
assert.deepEqual(plugin.parseDraftJson('[{"notes":"제목 없음"}]'), [], "제목 없는 초안은 버린다");
assert.ok(plugin.parseDraftJson(`[${Array.from({ length: 40 }, (_, i) => `{"title":"t${i}"}`).join(",")}]`).length <= 20);
assert.match(plugin.extractionPrompt("메모", "2026-08-02"), /2026-08-02/, "프롬프트에 오늘 날짜가 들어가야 상대 날짜를 푼다");

/* ── 중요도 ── */
assert.equal(plugin.normalizeTask({ title: "x", priority: "high" }, now).priority, "high");
assert.equal(plugin.normalizeTask({ title: "x", priority: "urgent" }, now).priority, "", "모르는 중요도는 버린다");
assert.equal(plugin.normalizeTask({ title: "x" }, now).priority, "", "기본은 '없음'");
{
  const one = plugin.applyCommand([], { type: "add", task: { title: "a", priority: "low" } }, now);
  assert.equal(plugin.applyCommand(one, { type: "edit", id: one[0].id, priority: "high" }, now)[0].priority, "high");
  // 빈 문자열은 "없음으로 되돌리기"라는 유효한 값이다 — includes 검사에 걸려 무시되면 안 된다.
  assert.equal(plugin.applyCommand(one, { type: "edit", id: one[0].id, priority: "" }, now)[0].priority, "");
  assert.equal(plugin.applyCommand(one, { type: "edit", id: one[0].id, priority: "bogus" }, now)[0].priority, "low");
  assert.deepEqual(
    plugin.applyCommand(one, { type: "edit", id: one[0].id, tags: ["업무", " 급함 ", ""] }, now)[0].tags,
    ["업무", "급함"],
  );
}

/* ── 상태표시줄 수치 ── */
{
  const t = (over) => plugin.normalizeTask({ title: "t", ...over }, now);
  const bag = [
    t({ title: "a", due: "2026-08-02T14:00", priority: "high" }),
    t({ title: "b", status: "doing" }),
    t({ title: "c", status: "done" }),
    t({ title: "d", due: "2026-07-20" }),
  ];
  const s = plugin.stats(bag, now);
  assert.equal(s.total, 4);
  assert.equal(s.todo, 2);
  assert.equal(s.doing, 1);
  assert.equal(s.done, 1);
  assert.equal(s.today, 1);
  assert.equal(s.overdue, 1);
  assert.equal(s.high, 1);
  assert.equal(s.percent, 25);
  const empty = plugin.stats([], now);
  assert.equal(empty.percent, 0, "0건일 때 0으로 나누면 안 된다");
  assert.equal(plugin.stats([t({ status: "done" })], now).percent, 100);
  // 완료된 항목은 지난 마감/중요 집계에 들어가면 안 된다.
  assert.equal(plugin.stats([t({ due: "2026-07-20", status: "done", priority: "high" })], now).overdue, 0);
  assert.equal(plugin.stats([t({ due: "2026-07-20", status: "done", priority: "high" })], now).high, 0);
}

/* ── 로컬 힌트 파서 (노션 페이지 자동 채우기) ── */
{
  const base = new Date(2026, 7, 2, 9, 0); // 2026-08-02 (일요일) 09:00
  const h = (s) => plugin.parseHints(s, base);

  assert.deepEqual(h(""), {}, "빈 입력은 아무것도 채우지 않는다");
  assert.deepEqual(h("그냥 메모"), {}, "단서가 없으면 키 자체를 안 만든다");

  assert.equal(h("오늘까지 정리").due, "2026-08-02");
  assert.equal(h("내일 보고서").due, "2026-08-03");
  assert.equal(h("모레 회의").due, "2026-08-04");
  assert.equal(h("8/5 마감").due, "2026-08-05");
  assert.equal(h("8월 15일 휴가").due, "2026-08-15");
  assert.equal(h("2026-09-01 시작").due, "2026-09-01");
  // 8/2(일) 기준: 이번주 월요일 = 7/27, 다음주 월요일 = 8/3
  assert.equal(h("이번주 월요일").due, "2026-07-27");
  assert.equal(h("다음주 월요일").due, "2026-08-03");
  assert.equal(h("담주 금요일").due, "2026-08-07");
  assert.equal(h("화요일까지").due, "2026-08-04", "수식어 없는 요일은 다음 도래일");

  assert.equal(h("내일 14:30 미팅").due, "2026-08-03T14:30");
  assert.equal(h("내일 오후 3시").due, "2026-08-03T15:00");
  assert.equal(h("내일 오전 9시 반").due, "2026-08-03T09:30");
  assert.equal(h("내일 저녁 7시").due, "2026-08-03T19:00");
  assert.equal(h("14시에 회의").due, "2026-08-02T14:00", "날짜 없이 시각만 = 오늘");
  assert.equal(h("오후 12시").due, "2026-08-02T12:00", "오후 12시는 24시가 아니다");
  assert.equal(h("오전 12시").due, "2026-08-02T00:00", "오전 12시는 자정이다");
  assert.equal(h("99시").due, undefined, "말이 안 되는 시각은 무시");

  assert.equal(h("이거 긴급해").priority, "high");
  assert.equal(h("중요한 일").priority, "high");
  assert.equal(h("ASAP 처리").priority, "high");
  assert.equal(h("나중에 해도 됨").priority, "low");
  assert.equal(h("보통 정도").priority, "medium");
  assert.equal(h("평범한 메모").priority, undefined);

  assert.deepEqual(h("정리 #업무 #보고서").tags, ["업무", "보고서"]);
  assert.deepEqual(h("#업무 #업무").tags, ["업무"], "중복 태그는 합친다");
  assert.equal(h("색상은 #ff0000").tags[0], "ff0000");

  const full = h("내일 오후 3시까지 급하게 보고서 정리 #업무");
  assert.equal(full.due, "2026-08-03T15:00");
  assert.equal(full.priority, "high");
  assert.deepEqual(full.tags, ["업무"]);
}

/* ── 등록 시 AI 정리 병합 ── */
{
  const user = { title: "보고서", notes: "내일까지 급함", due: "2026-08-03T15:00", priority: "high", tags: ["업무"] };
  const ai = { title: "보고서 정리", notes: "3분기 실적 정리", due: "2026-08-10", priority: "low", tags: ["기타"] };
  const merged = plugin.mergeComposed(user, ai);
  assert.equal(merged.title, "보고서 정리", "제목은 AI 정리본을 쓴다");
  assert.equal(merged.notes, "3분기 실적 정리");
  assert.equal(merged.due, "2026-08-03T15:00", "사용자가 정한 마감을 AI가 덮으면 안 된다");
  assert.equal(merged.priority, "high", "사용자가 정한 중요도를 AI가 덮으면 안 된다");
  assert.deepEqual(merged.tags, ["업무"]);

  // 빈 칸은 AI가 채운다
  const sparse = plugin.mergeComposed({ title: "메모", notes: "내일 회의" }, ai);
  assert.equal(sparse.due, "2026-08-10");
  assert.equal(sparse.priority, "low");
  assert.deepEqual(sparse.tags, ["기타"]);

  // AI가 죽어도 사용자가 친 내용은 그대로 살아남아야 한다 (등록 실패 = 최악)
  const fallback = plugin.mergeComposed(user, null);
  assert.equal(fallback.title, "보고서");
  assert.equal(fallback.notes, "내일까지 급함");
  assert.equal(fallback.due, "2026-08-03T15:00");
  assert.equal(fallback.priority, "high");
  assert.ok(plugin.normalizeTask(fallback, now), "병합 결과는 그대로 저장 가능해야 한다");
  assert.match(plugin.composePrompt(user, "2026-08-02"), /2026-08-02/);
  assert.match(plugin.composePrompt(user, "2026-08-02"), /보고서/);
}

/* ── 채팅/음성 발화에서 본문 뽑기 ── */
{
  const T = ["할 일 추가", "할일 추가", "할 일 등록", "투두 추가"];
  const s = (x) => plugin.stripTrigger(x, T);
  assert.equal(s("할 일 추가 우유 사기"), "우유 사기");
  assert.equal(s("할일 추가 내일 3시 보고서"), "내일 3시 보고서");
  assert.equal(s("투두 추가: 장보기"), "장보기");
  assert.equal(s("할 일 등록 회의 준비 해줘"), "회의 준비");
  assert.equal(s("우유 사기 할 일 추가"), "우유 사기", "트리거가 뒤에 붙어도 떼어낸다");
  assert.equal(s("할 일 추가"), "", "트리거만 말하면 본문이 없다");
  assert.equal(s(""), "");
  assert.equal(s(null), "");
  // "할 일 추가"가 "할 일"에 먼저 걸려 "추가"가 남으면 안 된다(긴 트리거 우선).
  assert.equal(plugin.stripTrigger("할 일 추가 우유", ["할 일", "할 일 추가"]), "우유");
}

// 등록 시 AI가 여러 건으로 쪼갤 수 있어야 한다(메일 한 통 → 할 일 N건).
assert.equal(
  plugin.parseDraftJson('[{"title":"a"},{"title":"b"},{"title":"c"}]').length,
  3,
  "compose 응답이 여러 건이면 확인 카드로 넘어간다",
);
// 칸반 컬럼에서 추가하면 그 상태로 들어가야 한다 (AI가 정할 값이 아니다).
assert.equal(plugin.mergeComposed({ title: "x", status: "doing" }, { title: "y" }).status, "doing");
assert.equal(plugin.mergeComposed({ title: "x" }, { title: "y" }).status, undefined);
assert.equal(
  plugin.applyCommand([], { type: "add", task: plugin.mergeComposed({ title: "x", status: "doing" }, null) }, now)[0].status,
  "doing",
);

// 추출 파서도 중요도를 읽어야 한다
assert.equal(plugin.parseDraftJson('[{"title":"x","priority":"high"}]')[0].priority, "high");
assert.equal(plugin.parseDraftJson('[{"title":"x","priority":"매우높음"}]')[0].priority, "", "모르는 값은 버린다");

/* ── AI 요약 / 브리핑 ── */
const t = (over) => plugin.normalizeTask({ title: "t", ...over }, now);
assert.equal(plugin.summarizeForAi([], now), "", "할 일이 없으면 컨텍스트를 낭비하지 않는다");
assert.equal(plugin.summarizeForAi([t({ title: "a", status: "done" })], now), "");
assert.match(plugin.summarizeForAi([t({ title: "a" }), t({ title: "b" })], now), /미완 2건/);
assert.match(
  plugin.summarizeForAi([t({ title: "보고서", due: "2026-08-02T14:00" })], now),
  /오늘 마감: 보고서/,
);
assert.match(
  plugin.summarizeForAi([t({ title: "지난것", due: "2026-07-20" })], now),
  /지난 마감 1건/,
);
const longSummary = plugin.summarizeForAi(
  Array.from({ length: 30 }, (_, i) => t({ title: `아주긴제목${i}`, due: "2026-08-02" })),
  now,
);
assert.ok(longSummary.length <= 120, `aiContext 한 줄은 120자 이하여야 한다 (실제 ${longSummary.length})`);

assert.equal(plugin.briefingLine([], now), "", "알릴 게 없으면 빈 문자열 — 펫이 조용히 넘어간다");
assert.match(plugin.briefingLine([t({ title: "a" })], now), /할 일 1건/);
assert.match(plugin.briefingLine([t({ title: "보고서", due: "2026-08-02T14:00" })], now), /오늘까지: 보고서/);
assert.ok(plugin.briefingLine(Array.from({ length: 40 }, (_, i) => t({ title: `할일${i}`, due: "2026-08-02" })), now).length <= 300);

/* ── 마감 알림 선별 ── */
const soonTask = t({ title: "회의", due: "2026-08-02T09:05" });
const laterTask = t({ title: "나중", due: "2026-08-02T18:00" });
const doneTask = t({ title: "끝남", due: "2026-08-02T09:05", status: "done" });
assert.deepEqual(plugin.dueSoon([soonTask, laterTask, doneTask], now, 10, {}).map((x) => x.title), ["회의"]);
assert.deepEqual(plugin.dueSoon([soonTask], now, 10, { [soonTask.id]: soonTask.due }), [], "같은 마감은 한 번만 알린다");
assert.deepEqual(
  plugin.dueSoon([soonTask], now, 10, { [soonTask.id]: "2026-08-01T09:00" }).map((x) => x.title),
  ["회의"],
  "마감을 고쳐 다시 다가오면 재알림",
);
assert.deepEqual(plugin.dueSoon([t({ title: "마감없음" })], now, 10, {}), [], "마감 없는 항목은 알리지 않는다");
assert.deepEqual(plugin.dueSoon([t({ title: "깨진날짜", due: "언젠가" })], now, 10, {}), []);
// 이미 지난 마감도 여전히 미완이면 알린다(마감 시각 <= now + lead).
assert.equal(plugin.dueSoon([t({ title: "지남", due: "2026-08-02T08:00" })], now, 10, {}).length, 1);

console.log("dap-todo check: OK");
