import TelegramBot from "node-telegram-bot-api";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DS_KEY = process.env.DEEPSEEK_API_KEY;
const DS_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID
  ? String(process.env.ADMIN_CHAT_ID)
  : null;

if (!TG_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!DS_KEY) throw new Error("Missing DEEPSEEK_API_KEY");

const bot = new TelegramBot(TG_TOKEN, { polling: true });

/* ===========================
   简易记忆（内存版）
   =========================== */
const memory = new Map();

function getState(chatId) {
  if (!memory.has(chatId)) {
    memory.set(chatId, { summary: "", lastN: [] });
  }
  return memory.get(chatId);
}

function pushTurn(chatId, role, content) {
  const st = getState(chatId);
  st.lastN.push({ role, content });
  if (st.lastN.length > 20) {
    st.lastN.splice(0, st.lastN.length - 20);
  }
}

/* ===========================
   DeepSeek 调用
   =========================== */
async function deepseekChat(messages) {
  const resp = await fetch(`${DS_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DS_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages,
      temperature: 0.2,
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`DeepSeek API error ${resp.status}: ${t}`);
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

/* ===========================
   工具实现
   =========================== */

function isAdmin(chatId) {
  if (!ADMIN_CHAT_ID) return true;
  return String(chatId) === ADMIN_CHAT_ID;
}

function safeCalc(expr) {
  if (!/^[0-9+\-*/%().\s]+$/.test(expr)) {
    throw new Error("calc 只允许数字和 +-*/%() .");
  }
  return Function(`"use strict"; return (${expr});`)();
}

async function fetchText(url) {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("只允许 http/https URL");
  }
  const r = await fetch(url);
  const ct = r.headers.get("content-type") || "";
  const text = await r.text();
  return {
    status: r.status,
    contentType: ct,
    text: text.slice(0, 4000),
  };
}

async function runPython(code) {
  const r = await fetch("https://emkc.org/api/v2/piston/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      language: "python3",
      version: "3.10.0",
      files: [{ name: "main.py", content: code }],
    }),
  });

  if (!r.ok) throw new Error(`Python runner error ${r.status}`);

  const data = await r.json();
  return (data?.run?.output ?? "").slice(0, 4000) || "(no output)";
}

/* ===========================
   Agent Prompt
   =========================== */

const SYSTEM_PROMPT = `
你是一个“会干活”的Telegram助理。

你可以使用工具：

1) TOOL:calc
格式：
TOOL:calc
EXPR:<数学表达式>

2) TOOL:fetch
格式：
TOOL:fetch
URL:<http链接>

3) TOOL:python
格式：
TOOL:python
CODE:<python代码>

规则：
- 如果不需要工具，直接回答。
- 如果需要工具，严格按格式输出，不要多余文字。
- 工具执行后会把结果发给你，你再生成最终答案。
`;

function parseToolCall(text) {
  const t = text.trim();
  if (!t.startsWith("TOOL:")) return null;

  const lines = t.split("\n");
  const tool = lines[0].slice("TOOL:".length).trim();
  const rest = lines.slice(1).join("\n");

  if (tool === "calc") {
    const m = rest.match(/EXPR:(.*)$/s);
    return m ? { tool, expr: m[1].trim() } : null;
  }

  if (tool === "fetch") {
    const m = rest.match(/URL:(.*)$/s);
    return m ? { tool, url: m[1].trim() } : null;
  }

  if (tool === "python") {
    const m = rest.match(/CODE:(.*)$/s);
    return m ? { tool, code: m[1].trim() } : null;
  }

  return null;
}

/* ===========================
   Agent 执行逻辑
   =========================== */

async function agentReply(chatId, userText) {
  const st = getState(chatId);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...st.lastN,
    { role: "user", content: userText },
  ];

  const first = await deepseekChat(messages);
  const call = parseToolCall(first);

  if (!call) {
    pushTurn(chatId, "user", userText);
    pushTurn(chatId, "assistant", first);
    return first;
  }

  if (!isAdmin(chatId)) {
    return "工具功能仅限管理员使用。";
  }

  let toolResult = "";

  try {
    if (call.tool === "calc") {
      toolResult = String(safeCalc(call.expr));
    } else if (call.tool === "fetch") {
      const r = await fetchText(call.url);
      toolResult = `STATUS:${r.status}\nTEXT:\n${r.text}`;
    } else if (call.tool === "python") {
      toolResult = await runPython(call.code);
    }
  } catch (e) {
    toolResult = `TOOL_ERROR: ${e.message}`;
  }

  const messages2 = [
    ...messages,
    { role: "assistant", content: first },
    { role: "user", content: `工具结果如下：\n${toolResult}\n请给最终回答。` },
  ];

  const final = await deepseekChat(messages2);

  pushTurn(chatId, "user", userText);
  pushTurn(chatId, "assistant", final);

  return final;
}

/* ===========================
   Telegram 命令
   =========================== */

bot.onText(/^\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "我已上线。\n\n可用命令：\n/id 查看chat id\n/reset 清空记忆"
  );
});

bot.onText(/^\/id/, (msg) => {
  bot.sendMessage(msg.chat.id, `chat.id = ${msg.chat.id}`);
});

bot.onText(/^\/reset/, (msg) => {
  memory.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, "记忆已清空。");
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;
  if (text.startsWith("/")) return;

  try {
    const reply = await agentReply(chatId, text);
    await bot.sendMessage(chatId, reply);
  } catch (e) {
    await bot.sendMessage(chatId, `错误：${e.message}`);
  }
});

console.log("Bot running...");
