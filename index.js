import express from "express";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { google } from "googleapis";
import * as chrono from "chrono-node";

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

const TZ = "America/Santiago";

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

// ===== Helpers: lenguaje natural =====
function hasTimeHint(text) {
  // detecta "9", "9:30", "14:00", "9am", "9 pm"
  return /\b(\d{1,2})(:\d{2})?\s*(am|pm)?\b/i.test(text);
}

function parseDateTime(text) {
  // chrono interpreta muchas cosas en español (mañana, lunes, etc.) de forma razonable
  const results = chrono.parse(text, new Date(), { forwardDate: true });
  if (!results.length) return null;
  return results[0].start.date(); // Date (con hora si la detecta)
}

function addMinutes(dateObj, minutes) {
  return new Date(dateObj.getTime() + minutes * 60 * 1000);
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
      .send("Listo. Jarvis quedó autorizado. Vuelve a Telegram.");
  } catch (err) {
    console.error("OAuth callback error:", err?.response?.data || err);
    return res.status(500).send("OAuth error");
  }
});

// ===== Commands =====
bot.onText(/\/start/i, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Jarvis operativo ✅\n\nConecta Google: /login\n\nComandos:\n- /agenda_hoy\n- /pendientes\n\nModo asistente (sin /):\n- reunión con BHP mañana 9\n- recordar enviar propuesta el lunes\n- llamar a René"
  );
});

bot.onText(/\/login/i, (msg) => {
  const telegramUserId = String(msg.from.id);

  const scopes = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/tasks",
  ];

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    state: telegramUserId,
  });

  bot.sendMessage(
    msg.chat.id,
    `Autoriza Google (cuenta de trabajo):\n${url}\n\nLuego vuelve y prueba /agenda_hoy o escribe “reunión con ...”`
  );
});

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
      maxResults: 20,
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

bot.onText(/\/pendientes/i, async (msg) => {
  const chatId = msg.chat.id;
  const auth = getGoogleAuth(msg.from.id);
  if (!auth) return bot.sendMessage(chatId, "No estás logueado. Usa /login.");

  try {
    const tasks = google.tasks({ version: "v1", auth });

    const resp = await tasks.tasks.list({
      tasklist: "@default",
      showCompleted: false,
      maxResults: 20,
    });

    const items = resp.data.items || [];
    if (!items.length) return bot.sendMessage(chatId, "✅ No tienes pendientes (lista default).");

    const lines = items.map((t) => `• ${t.title}${t.due ? ` (vence ${t.due.slice(0, 10)})` : ""}`);
    bot.sendMessage(chatId, `📝 Pendientes:\n${lines.join("\n")}`);
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "Error listando tareas.");
  }
});

// ===== Asistente conversacional (sin comandos) =====
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    if (!text) return;

    // ignora comandos
    if (text.startsWith("/")) return;

    const auth = getGoogleAuth(msg.from.id);
    if (!auth) return bot.sendMessage(chatId, "Primero conéctate a Google con /login.");

    const lower = text.toLowerCase();

    const wantsMeeting =
      /\b(reuni[oó]n|agenda|agendar|bloquea|bloquear|llamada|call|cita)\b/i.test(lower);

    const parsed = parseDateTime(text);
    const timePresent = hasTimeHint(text);

    if (wantsMeeting) {
      if (!parsed) {
        return bot.sendMessage(chatId, "¿Para qué día y hora? Ej: “mañana 09:00”");
      }
      if (!timePresent) {
        return bot.sendMessage(chatId, "Perfecto. ¿A qué hora? Ej: 09:00 o 14:30");
      }

      // Evento de 60 min por defecto
      const start = parsed;
      const end = addMinutes(start, 60);

      const calendar = google.calendar({ version: "v3", auth });

      const event = {
        summary: text,
        start: { dateTime: start.toISOString(), timeZone: TZ },
        end: { dateTime: end.toISOString(), timeZone: TZ },
        reminders: {
          useDefault: false,
          overrides: [
            { method: "popup", minutes: 1440 }, // 1 día antes
            { method: "popup", minutes: 60 },   // 1 hora antes
          ],
        },
      };

      const resp = await calendar.events.insert({
        calendarId: "primary",
        requestBody: event,
      });

      return bot.sendMessage(chatId, `📅 Listo, agendado.\n${resp.data.htmlLink}`);
    }

    // Si no parece reunión, lo guardamos como tarea
    const tasks = google.tasks({ version: "v1", auth });
    const taskBody = { title: text };

    // Si detecta fecha, la usamos como due (aunque no haya hora)
    if (parsed) taskBody.due = parsed.toISOString();

    await tasks.tasks.insert({
      tasklist: "@default",
      requestBody: taskBody,
    });

    return bot.sendMessage(chatId, `✅ Listo, lo dejé como tarea${parsed ? " con fecha" : ""}.`);
  } catch (err) {
    console.error("Assistant error:", err);
  }
});

// ===== Server =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
