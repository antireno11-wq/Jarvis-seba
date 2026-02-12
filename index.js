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

const TZ = "America/Santiago";
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

const userTokens = new Map();
const pendingMeetings = new Map(); // 🧠 memoria por chat

function getGoogleAuth(userId) {
  const tokens = userTokens.get(String(userId));
  if (!tokens) return null;
  const client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
  client.setCredentials(tokens);
  return client;
}

function parseDate(text) {
  const results = chrono.parse(text, new Date(), { forwardDate: true });
  if (!results.length) return null;
  return results[0].start.date();
}

function hasTime(text) {
  return /\b(\d{1,2})(:\d{2})?\b/.test(text);
}

function addMinutes(date, m) {
  return new Date(date.getTime() + m * 60000);
}

app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/oauth2callback", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;

  const { tokens } = await oauth2Client.getToken(code);
  userTokens.set(String(state), tokens);

  res.send("Autorizado. Vuelve a Telegram.");
});

bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    if (!text || text.startsWith("/")) return;

    const auth = getGoogleAuth(msg.from.id);
    if (!auth) {
      return bot.sendMessage(chatId, "Primero usa /login");
    }

    // 🧠 SI HAY REUNIÓN PENDIENTE Y RESPONDE CON HORA
    if (pendingMeetings.has(chatId) && hasTime(text)) {
      const pending = pendingMeetings.get(chatId);

      const hourMatch = text.match(/(\d{1,2})(:\d{2})?/);
      const hour = parseInt(hourMatch[1], 10);
      const minute = hourMatch[2] ? parseInt(hourMatch[2].replace(":", ""), 10) : 0;

      const date = new Date(pending.date);
      date.setHours(hour, minute, 0, 0);

      const calendar = google.calendar({ version: "v3", auth });

      const event = {
        summary: pending.title,
        start: { dateTime: date.toISOString(), timeZone: TZ },
        end: { dateTime: addMinutes(date, 60).toISOString(), timeZone: TZ },
      };

      const resp = await calendar.events.insert({
        calendarId: "primary",
        requestBody: event,
      });

      pendingMeetings.delete(chatId);

      return bot.sendMessage(chatId, `📅 Reunión creada\n${resp.data.htmlLink}`);
    }

    // Detectar reunión
    if (text.toLowerCase().includes("reunión")) {
      const parsed = parseDate(text);

      if (!parsed) {
        return bot.sendMessage(chatId, "¿Para qué día?");
      }

      if (!hasTime(text)) {
        pendingMeetings.set(chatId, {
          title: text,
          date: parsed,
        });

        return bot.sendMessage(chatId, "¿A qué hora?");
      }

      const calendar = google.calendar({ version: "v3", auth });

      const event = {
        summary: text,
        start: { dateTime: parsed.toISOString(), timeZone: TZ },
        end: { dateTime: addMinutes(parsed, 60).toISOString(), timeZone: TZ },
      };

      const resp = await calendar.events.insert({
        calendarId: "primary",
        requestBody: event,
      });

      return bot.sendMessage(chatId, `📅 Reunión creada\n${resp.data.htmlLink}`);
    }

    // Si no es reunión → tarea
    const tasks = google.tasks({ version: "v1", auth });

    await tasks.tasks.insert({
      tasklist: "@default",
      requestBody: { title: text },
    });

    bot.sendMessage(chatId, "✅ Lo dejé como tarea.");
  } catch (err) {
    console.error(err);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`Server running on port ${PORT}`)
);
