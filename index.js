import TelegramBot from "node-telegram-bot-api";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

if (!TG_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!DEEPSEEK_KEY) throw new Error("Missing DEEPSEEK_API_KEY");

const bot = new TelegramBot(TG_TOKEN, { polling: true });

async function deepseekChat(userText) {
  const resp = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DEEPSEEK_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: userText }
      ]
    })
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`DeepSeek HTTP ${resp.status}: ${t.slice(0, 300)}`);
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || "(empty)";
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "我已上线 ✅ 直接发消息给我即可。");
});

bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith("/start")) return;

  const chatId = msg.chat.id;

  try {
    await bot.sendChatAction(chatId, "typing");
    const reply = await deepseekChat(msg.text);
    await bot.sendMessage(chatId, reply);
  } catch (e) {
    await bot.sendMessage(chatId, `出错了：${e.message}`);
  }
});

console.log("Bot is running...");
