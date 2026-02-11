import express from "express";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { google } from "googleapis";

dotenv.config();

const app = express();
app.use(express.json());

// ===== Env =====
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const APP_BASE_URL = process.env.APP_BASE_URL;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!GOOGLE_CLIENT_ID) throw new Error("Missing GOOGLE_CLIENT_ID");
if (!GOOGLE_CLIENT_SECRET) throw new Error("Missing GOOGLE_CLIENT_SECRET");
if (!GOOGLE_REDIRECT_URI) throw new Error("Missing GOOGLE_REDIRECT_URI");
if (!APP_BASE_URL) throw new Error("Missing APP_BASE_URL");

// ===== Telegram =====
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// ===== Google OAuth =====
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// MVP storage: tokens en memoria (temporal)
const userTokens = new Map(); // telegramUserId -> tokens

function getGoogleAuth(telegramUserId) {
  const tokens = userTokens.get(String(telegramUserId));
  if (!tokens) return null;

  const client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  client.setCredentials(tokens);
  return client;
}

// ===== Telegram Webhook endpoint =====
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ===== Health / Root =====
app.get("/health", (req, res) => res.status(200).send("ok"));
app.get("/", (req, res) => res.status(200).send("Jarvis is alive"));

// ===== OAuth callback =====
app.get("/oauth2callback", async (req, res) => {
  try {
    const code = req.query.code;
    const state = req.query.state; // telegramUserId

    if (!code || !state) return res.status(400).send("Missing code/state");

    const { tokens } = await oauth2Client.getToken(code);
    userTokens.set(String(state), tokens);

    return res
      .status(200)
      .send("Listo. Jarvis quedó autorizado. Vuelve a Telegram y usa /agenda_hoy o /pendientes.");
  } catch (err) {
    console.error("OAuth callback error:", err);
    return res.status(500).send("OAuth error");
  }
});

// ===== Telegram commands =====
bot.onText(/\/start/i, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Jarvis operativo ✅\n\n1) Conecta Google: /login\n2) Ver agenda hoy: /agenda_hoy\n3) Crear tarea: /task texto | fecha(opcional)\n4) Ver pendientes: /pendientes"
  );
});

bot.onText(/\/login/i, (msg) => {
  const telegramUserId = String(msg.from.id);

  const scopes = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/tasks"
  ];

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    state: telegramUserId
  });

  bot.sendMessage(
    msg.chat.id,
    `Autoriza Google (usa tu cuenta de trabajo):\n${url}\n\nCuando termines, vuelve y usa /agenda_hoy`
  );
});

// Agenda de hoy (primary por ahora)
bot.onText(/\/agenda_hoy/i, async (msg) => {
  const chatId = msg.chat.id;
  const auth = getGoogleAuth(msg.from.id);

  if (!auth) return bot.sendMessage(chatId, "No estás logueado. Usa /login.");

  try {
    const calendar = google.calendar({ version: "v3", auth });

    const start = new Date();
    start.setHours(0, 0, 0, 0);

    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const resp = await calendar.events.list({
      calendarId: "primary",
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 20
    });

    const items = resp.data.items || [];
    if (!items.length) return bot.sendMessage(chatId, "Hoy no tienes eventos en tu calendario.");

    const lines = items.map((e) => {
      const when = e.start?.dateTime || e.start?.date || "sin hora";
      return `• ${e.summary || "(sin título)"} — ${when}`;
    });

    bot.sendMessage(chatId, `📅 Agenda de hoy:\n${lines.join("\n")}`);
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "Error leyendo tu calendario.");
  }
});

// Crear tarea: /task texto | 2026-02-15 (fecha opcional)
bot.onText(/\/task (.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const auth = getGoogleAuth(msg.from.id);

  if (!auth) return bot.sendMessage(chatId, "No estás logueado. Usa /login.");

  try {
    const input = match[1].trim();
    const [titleRaw, dateRaw] = input.split("|").map((s) => s.trim());

    const tasks = google.tasks({ version: "v1", auth });

    const taskBody = { title: titleRaw };
    if (dateRaw) taskBody.due = new Date(dateRaw).toISOString();

    await tasks.tasks.insert({
      tasklist: "@default",
      requestBody: taskBody
    });

    bot.sendMessage(chatId, `✅ Tarea creada: ${titleRaw}${dateRaw ? ` (vence ${dateRaw})` : ""}`);
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "Error creando la tarea. Usa: /task texto | 2026-02-15");
  }
});

// Listar pendientes
bot.onText(/\/pendientes/i, async (msg) => {
  const chatId = msg.chat.id;
  const auth = getGoogleAuth(msg.from.id);

  if (!auth) return bot.sendMessage(chatId, "No estás logueado. Usa /login.");

  try {
    const tasks = google.tasks({ version: "v1", auth });

    const resp = await tasks.tasks.list({
      tasklist: "@default",
      showCompleted: false,
      maxResults: 20
    });

    const items = resp.data.items || [];
    if (!items.length) return bot.sendMessage(chatId, "✅ No tienes pendientes en la lista default.");

    const lines = items.map((t) => `• ${t.title}${t.due ? ` (vence ${t.due.slice(0, 10)})` : ""}`);
    bot.sendMessage(chatId, `📝 Pendientes:\n${lines.join("\n")}`);
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "Error listando tareas.");
  }
});

// ===== Server =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
