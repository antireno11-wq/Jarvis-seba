import express from "express";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { google } from "googleapis";
import * as chrono from "chrono-node";

dotenv.config();

const app = express();
app.use(express.json());

// ===== ENV =====
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!GOOGLE_CLIENT_ID) throw new Error("Missing GOOGLE_CLIENT_ID");
if (!GOOGLE_CLIENT_SECRET) throw new Error("Missing GOOGLE_CLIENT_SECRET");
if (!GOOGLE_REDIRECT_URI) throw new Error("Missing GOOGLE_REDIRECT_URI");

const TZ = "America/Santiago";

// ===== TELEGRAM =====
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

// ===== GOOGLE OAUTH =====
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

// Tokens en memoria (ok si te da lo mismo reloguearte)
const userTokens = new Map(); // telegramUserId -> tokens

// 🧠 Wizard para reuniones: guarda contexto día/hora
// chatId -> { title, dateObj?: Date, stage: "need_date"|"need_time" }
const meetingWizard = new Map();

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

// ===== Helpers =====
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

function dayRange(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);

  const start = new Date(d);
  start.setHours(0, 0, 0, 0);

  const end = new Date(d);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

async function createCalendarEvent(auth, title, startDate) {
  const calendar = google.calendar({ version: "v3", auth });
  const endDate = addMinutes(startDate, 60);

  const event = {
    summary: title,
    start: { dateTime: startDate.toISOString(), timeZone: TZ },
    end: { dateTime: endDate.toISOString(), timeZone: TZ },
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

  return resp.data.htmlLink;
}

async function getAgendaAndTasks(auth, offsetDays = 0) {
  const calendar = google.calendar({ version: "v3", auth });
  const tasksApi = google.tasks({ version: "v1", auth });

  const { start, end } = dayRange(offsetDays);

  const evResp = await calendar.events.list({
    calendarId: "primary",
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
  });

  const events = evResp.data.items || [];

  const tResp = await tasksApi.tasks.list({
    tasklist: "@default",
    showCompleted: false,
    maxResults: 50,
  });

  const tasks = tResp.data.items || [];

  // Filtrar tareas con due dentro del día
  const dueTasks = tasks.filter((t) => {
    if (!t.due) return false;
    const due = new Date(t.due);
    return due >= start && due <= end;
  });

  // Pendientes sin fecha (top 5)
  const noDueTasks = tasks.filter((t) => !t.due).slice(0, 5);

  return { events, dueTasks, noDueTasks };
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  } catch {
    return iso;
  }
}

// ===== WEBHOOK + HEALTH =====
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("Jarvis is alive"));
app.get("/health", (req, res) => res.send("ok"));

// ===== OAUTH CALLBACK =====
app.get("/oauth2callback", async (req, res) => {
  try {
    const code = req.query.code;
    const state = req.query.state; // telegramUserId
    if (!code || !state) return res.status(400).send("Missing code/state");

    const { tokens } = await oauth2Client.getToken(code);
    userTokens.set(String(state), tokens);

    res.send("✅ Listo. Vuelve a Telegram.");
  } catch (err) {
    console.error("OAuth callback error:", err?.response?.data || err);
    res.status(500).send("OAuth error");
  }
});

// ===== COMMANDS =====
bot.onText(/\/start/i, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Jarvis operativo ✅\n\n1) Conecta Google: /login\n\nLuego habla normal:\n- Reunión mañana con Flesan\n- ¿Qué tengo hoy?\n- ¿Qué tengo mañana?\n- Recuérdame enviar propuesta el lunes"
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

// ===== MAIN ASSISTANT =====
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const textRaw = msg.text?.trim();
    if (!textRaw) return;
    if (textRaw.startsWith("/")) return;

    const auth = getGoogleAuth(msg.from.id);
    if (!auth) return bot.sendMessage(chatId, "Primero conéctate a Google con /login.");

    const text = textRaw;
    const lower = text.toLowerCase();

    // ========= 1) Consultas naturales de agenda =========
    const asksToday =
      /\b(qué|que)\b.*\b(tengo|hay)\b.*\b(hoy)\b/i.test(lower) ||
      /\b(agenda|calendario)\b.*\b(hoy)\b/i.test(lower) ||
      /\b(hoy)\b.*\b(reuniones|tareas|agenda)\b/i.test(lower);

    const asksTomorrow =
      /\b(qué|que)\b.*\b(tengo|hay)\b.*\b(mañana)\b/i.test(lower) ||
      /\b(agenda|calendario)\b.*\b(mañana)\b/i.test(lower) ||
      /\b(mañana)\b.*\b(reuniones|tareas|agenda)\b/i.test(lower);

    if (asksToday || asksTomorrow) {
      const offset = asksTomorrow ? 1 : 0;
      const label = asksTomorrow ? "mañana" : "hoy";

      const { events, dueTasks, noDueTasks } = await getAgendaAndTasks(auth, offset);

      let out = `📌 Tu resumen de ${label}:\n\n`;

      out += `📅 Reuniones (${events.length}):\n`;
      if (!events.length) out += "• (sin reuniones)\n";
      for (const e of events) {
        const when = e.start?.dateTime || e.start?.date;
        out += `• ${e.summary || "(sin título)"} — ${when ? fmtTime(when) : "sin hora"}\n`;
      }

      out += `\n🧾 Tareas con vencimiento ${label} (${dueTasks.length}):\n`;
      if (!dueTasks.length) out += "• (sin tareas con vencimiento)\n";
      for (const t of dueTasks) out += `• ${t.title}\n`;

      out += `\n📝 Pendientes (sin fecha) top ${noDueTasks.length}:\n`;
      if (!noDueTasks.length) out += "• (sin pendientes)\n";
      for (const t of noDueTasks) out += `• ${t.title}\n`;

      return bot.sendMessage(chatId, out);
    }

    // ========= 2) Wizard de reunión (día/hora en pasos) =========
    // Si estamos en medio de completar una reunión
    if (meetingWizard.has(chatId)) {
      const state = meetingWizard.get(chatId);

      // Si necesita día
      if (state.stage === "need_date") {
        const parsedDate = parseDateTime(text);
        if (!parsedDate) {
          return bot.sendMessage(chatId, 'No caché el día 😅. Ej: "mañana", "viernes", "12 feb".');
        }
        state.dateObj = parsedDate;

        // Si el mensaje del usuario ya traía hora, avanzamos directo
        if (hasTime(text)) {
          // pero chrono a veces pone hora si viene en el texto; si no, pedimos hora igual
          if (!hasTime(text)) {
            state.stage = "need_time";
            meetingWizard.set(chatId, state);
            return bot.sendMessage(chatId, '¿A qué hora? Ej: "11" o "11:00".');
          }
        }

        state.stage = "need_time";
        meetingWizard.set(chatId, state);
        return bot.sendMessage(chatId, 'Perfecto. ¿A qué hora? Ej: "11" o "11:00".');
      }

      // Si necesita hora
      if (state.stage === "need_time") {
        const hm = extractHourMinute(text);
        if (!hm) {
          return bot.sendMessage(chatId, 'No entendí la hora 😅. Ej: "11", "11:00", "14:30".');
        }
        const start = new Date(state.dateObj);
        start.setHours(hm.hour, hm.minute, 0, 0);

        const link = await createCalendarEvent(auth, state.title, start);
        meetingWizard.delete(chatId);
        return bot.sendMessage(chatId, `📅 Reunión creada ✅\n${link}`);
      }
    }

    // Detectar intención de reunión
    const wantsMeeting =
      /\b(reuni[oó]n|agendar|agenda|llamada|call|cita|bloquea|bloquear)\b/i.test(lower);

    if (wantsMeeting) {
      // 1) Intentar parsear todo de una vez
      const parsed = parseDateTime(text);

      // Si no encontró ni fecha
      if (!parsed) {
        meetingWizard.set(chatId, { title: text, stage: "need_date" });
        return bot.sendMessage(chatId, '¿Para qué día? Ej: "mañana", "viernes", "12 feb".');
      }

      // Si encontró fecha pero no hora => wizard a pedir hora
      if (!hasTime(text)) {
        meetingWizard.set(chatId, { title: text, stage: "need_time", dateObj: parsed });
        return bot.sendMessage(chatId, 'Perfecto. ¿A qué hora? Ej: "11" o "11:00".');
      }

      // Si encontró fecha y hora => crear evento directo
      const link = await createCalendarEvent(auth, text, parsed);
      return bot.sendMessage(chatId, `📅 Evento creado ✅\n${link}`);
    }

    // ========= 3) Si no es reunión ni agenda => tarea =========
    const tasksApi = google.tasks({ version: "v1", auth });
    const parsedForTask = parseDateTime(text);
    const taskBody = { title: text };

    // si detecta fecha, la ponemos como due; si no, queda sin fecha
    if (parsedForTask) taskBody.due = parsedForTask.toISOString();

    await tasksApi.tasks.insert({
      tasklist: "@default",
      requestBody: taskBody,
    });

    return bot.sendMessage(chatId, `✅ Listo, lo dejé como tarea${parsedForTask ? " con fecha" : ""}.`);
  } catch (err) {
    console.error("Assistant error:", err);
  }
});

// ===== SERVER =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
