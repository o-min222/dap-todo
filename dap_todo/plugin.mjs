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

const STATUSES = ["todo", "doing", "done"];
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
      return {
        title: title.slice(0, 200),
        notes: String(item?.notes ?? "").trim().slice(0, 2000),
        // 모델이 "미정"/"없음" 같은 값을 넣는 일이 잦다 — 날짜 모양만 통과시킨다.
        due: /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?$/.test(due) ? due.replace(" ", "T") : "",
        tags: Array.isArray(item?.tags) ? item.tags.map(String).slice(0, 6) : [],
      };
    })
    .filter(Boolean)
    .slice(0, 20);
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
  const parts = [`미완 ${open.length}건`];
  if (overdue.length) parts.push(`지난 마감 ${overdue.length}건`);
  if (today.length) parts.push(`오늘 마감: ${today.map((t) => t.title).join(", ")}`);
  return parts.join(" · ").slice(0, MAX_AI_CHARS);
}

/** 아침 브리핑 한 줄. 알릴 게 없으면 빈 문자열 — 호스트가 조용히 넘어간다. */
export function briefingLine(tasks, now = new Date()) {
  const open = (tasks ?? []).filter(isOpen);
  if (!open.length) return "";
  const due = open.filter((t) => {
    const d = dueDate(t);
    return d && d <= new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  });
  const head = `할 일 ${open.length}건`;
  if (!due.length) return head;
  return `${head} (오늘까지: ${due.map((t) => t.title).join(", ")})`.slice(0, 300);
}

/** 마감 lead분 이내이면서 아직 안 알린 항목. notified는 { [id]: dueISO }. */
export function dueSoon(tasks, now = new Date(), leadMinutes = REMIND_LEAD_MIN, notified = {}) {
  const limit = new Date(now.getTime() + leadMinutes * 60_000);
  return (tasks ?? []).filter((t) => {
    if (!isOpen(t)) return false;
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
    "형식: [{\"title\":\"짧은 할 일\",\"due\":\"YYYY-MM-DD 또는 YYYY-MM-DDTHH:mm\",\"notes\":\"부연\"}]",
    `오늘은 ${todayISO} 야. "내일", "다음 주 화요일" 같은 표현은 실제 날짜로 바꿔.`,
    "마감을 알 수 없으면 due 는 빈 문자열. 할 일이 없으면 [] 만 답해.",
    "설명이나 코드펜스 없이 JSON 배열만 출력해.",
    "",
    "---",
    String(text ?? "").slice(0, 12000),
  ].join("\n");
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
  };

  /** 살아있는 표면 전부에 현재 상태를 밀어준다. */
  const push = () => {
    const payload = { type: "todo.state", tasks, view };
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
            palette.postMessage({ type: "todo.drafts", ...result });
          } catch (e) {
            palette.postMessage({
              type: "todo.drafts",
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

  void load().then(push);

  return () => {
    clearInterval(timer);
    try {
      palette?.close?.();
    } catch {
      /* 이미 닫혔으면 무시 */
    }
    palette = null;
    trayPanel = null;
  };
}
