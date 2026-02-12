import express from "express";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { google } from "googleapis";
import * as chrono from "chrono-node";

dotenv.config();

const app = express();
app.use(express.json());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!GOOGLE_CLIENT_ID) throw new Error("Missing GOOGLE_CLIENT_ID");
if (!GOOGLE_CLIENT_SECRET) throw new Error("Missing GOOGLE_CLIENT_SECRET");
if (!GOOGLE_REDIRECT_URI) throw new Error("Missing GOOGLE_REDIRECT_URI");

const TZ = "America/Santiago";
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// OAuth client
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// ⚠️ tokens en memoria (se pierden si redeployas)
const userTokens = new Map(); // telegramUserId -> tokens

// 🧠 memoria de conversación para completar hora
const pendingMeetings = new Map(); // chatId -> { title, dateOnly: Date }

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

function parseDateTime(text) {
  const results = chrono.parse(text, new Date(), { forwardDate: true });
  if (!results.length) return null;
  return results[0].start.date();
}

function hasTime(text) {
  return /\b(\d{1,2})(:\d{2})?\s*(am|pm)?\b/i.test(text);
}

function extractHourMinute(text) {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\b/);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function addMinutes(date, m) {
  return new Date(date.getTime() + m * 60000);
}

// ===== Webhook Telegram =====
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("Jarvis is alive"));
app.get("/health", (req, res) => res.send("ok"));

// ===== OAuth callback =====
app.get("/oauth2callback", async (req, res) => {
  try {
    const code = req.query.code;
    const state = req.query.state; // telegramUserId
    if (!code || !state) return res.status(400).send("Missing code/state");

    const { tokens } = await oauth2Client.getToken(code);
    userTokens.set(String(state), tokens);

    res.send("✅ Autorizado. Vuelve a Telegram y escribe algo como: 'Reunión mañana con Flesan'.");
  } catch (err) {
    console.error("OAuth callback error:", err?.response?.data || err);
    res.status(500).send("OAuth error");
  }
});

// ===== Comandos =====
bot.onText(/\/start/i, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Jarvis operativo ✅\n\n1) Conecta Google: /login\n\nLuego escribe normal:\n- Reunión mañana con Flesan\n- Recordar enviar propuesta el lunes\n\nSi falta hora, te la preguntaré."
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

  bot.sendMessage(msg.chat.id, `Autoriza Google aquí:\n${url}`);
});

// ===== Asistente =====
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    if (!text) return;
    if (text.startsWith("/")) return;

    const auth = getGoogleAuth(msg.from.id);
    if (!auth) return bot.sendMessage(chatId, "Primero conéctate a Google con /login.");

    // ✅ Si está pendiente una reunión y responde con hora -> crear evento
    if (pendingMeetings.has(chatId)) {
      const hm = extractHourMinute(text);
      if (hm) {
        const pending = pendingMeetings.get(chatId);
        const start = new Date(pending.dateOnly);
        start.setHours(hm.hour, hm.minute, 0, 0);

        const end = addMinutes(start, 60);

        const calendar = google.calendar({ version: "v3", auth });
        const event = {
          summary: pending.title,
          start: { dateTime: start.toISOString(), timeZone: TZ },
          end: { dateTime: end.toISOString(), timeZone: TZ },
          reminders: {
            useDefault: false,
            overrides: [
              { method: "popup", minutes: 1440 },
              { method: "popup", minutes: 60 },
            ],
          },
        };

        const resp = await calendar.events.insert({
          calendarId: "primary",
          requestBody: event,
        });

        pendingMeetings.delete(chatId);
        return bot.sendMessage(chatId, `📅 Reunión creada.\n${resp.data.htmlLink}`);
      }

      // si respondió otra cosa, seguimos normal (sin borrar el pending)
    }

    const lower = text.toLowerCase();

    const wantsMeeting =
      /\b(reuni[oó]n|agendar|agenda|llamada|call|cita|bloquea|bloquear)\b/i.test(lower);

    const forceTask =
      /\b(tarea|pendiente|recordar|recuerda)\b/i.test(lower);

    const parsed = parseDateTime(text);
    const timePresent = hasTime(text);

    // ✅ Reglas:
    // - si es reunión o si hay hora (y no forzó tarea) => evento
    // - si es reunión con fecha pero sin hora => preguntar y guardar pending
    const shouldEvent = (wantsMeeting || timePresent) && !forceTask;

    if (shouldEvent) {
      if (!parsed) return bot.sendMessage(chatId, '¿Para qué día? Ej: "mañana"');

      if (wantsMeeting && !timePresent) {
        pendingMeetings.set(chatId, { title: text, dateOnly: parsed });
        return bot.sendMessage(chatId, 'Perfecto. ¿A qué hora? Ej: "11" o "11:00"');
      }

      // Crear evento directo (tiene hora o no es explícitamente reunión)
      if (!timePresent) {
        // si tiene fecha pero no hora y no es "reunión", lo tratamos como tarea para evitar eventos a 00:00
        const tasks = google.tasks({ version: "v1", auth });
        await tasks.tasks.insert({
          tasklist: "@default",
          requestBody: { title: text, due: parsed.toISOString() },
        });
        return bot.sendMessage(chatId, "✅ Lo dejé como tarea con fecha.");
      }

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
            { method: "popup", minutes: 1440 },
            { method: "popup", minutes: 60 },
          ],
        },
      };

      const resp = await calendar.events.insert({
        calendarId: "primary",
        requestBody: event,
      });

      return bot.sendMessage(chatId, `📅 Evento creado.\n${resp.data.htmlLink}`);
    }

    // Si no => Task
    const tasks = google.tasks({ version: "v1", auth });
    const body = { title: text };
    if (parsed) body.due = parsed.toISOString();

    await tasks.tasks.insert({
      tasklist: "@default",
      requestBody: body,
    });

    return bot.sendMessage(chatId, `✅ Listo, lo dejé como tarea${parsed ? " con fecha" : ""}.`);
  } catch (err) {
    console.error("Assistant error:", err);
  }
});

// ===== Server =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
