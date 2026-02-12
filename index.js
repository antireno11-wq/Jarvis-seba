import express from "express";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { google } from "googleapis";

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

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI
);

const userTokens = new Map(); // telegramUserId -> tokens

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

// ======= PARSER ESPAÑOL (fecha) =======
const MONTHS = {
  ene: 0, enero: 0,
  feb: 1, febrero: 1,
  mar: 2, marzo: 2,
  abr: 3, abril: 3,
  may: 4, mayo: 4,
  jun: 5, junio: 5,
  jul: 6, julio: 6,
  ago: 7, agosto: 7,
  sep: 8, sept: 8, septiembre: 8,
  oct: 9, octubre: 9,
  nov: 10, noviembre: 10,
  dic: 11, diciembre: 11,
};

const WEEKDAYS = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3, miércoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6, sábado: 6,
};

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function nextWeekday(fromDate, weekdayIndex) {
  const d = startOfDay(fromDate);
  const diff = (weekdayIndex - d.getDay() + 7) % 7;
  return addDays(d, diff === 0 ? 7 : diff); // próximo, no hoy mismo
}

function parseSpanishDate(text) {
  if (!text) return null;
  const t = text.toLowerCase().trim();

  const today = startOfDay(new Date());

  // relativos
  if (/\bhoy\b/.test(t)) return today;
  if (/\bpasado\s+mañana\b/.test(t)) return addDays(today, 2);
  if (/\bmañana\b/.test(t)) return addDays(today, 1);

  // día de semana
  for (const [name, idx] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name}\\b`, "i").test(t)) {
      return nextWeekday(today, idx);
    }
  }

  // formatos numéricos: dd/mm o dd-mm (con o sin año)
  // 12/02, 12-02, 12/02/2026
  let m = t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    let year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
    if (year < 100) year += 2000;

    const d = new Date(year, month, day);
    if (!isNaN(d.getTime())) return startOfDay(d);
  }

  // "12 de febrero" / "12 febrero" / "12 feb" (con o sin año)
  // admite: 12 de febrero, 12 febrero 2026, 12 feb
  m = t.match(/\b(\d{1,2})\s*(?:de\s*)?([a-záéíóúñ]+)\s*(?:de\s*)?(\d{4})?\b/i);
  if (m) {
    const day = parseInt(m[1], 10);
    const monthKey = m[2].normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // saca tildes
    const month = MONTHS[monthKey];
    if (month !== undefined) {
      const year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) return startOfDay(d);
    }
  }

  return null;
}

// ======= PARSER HORA =======
function hasTime(text) {
  return /\b(\d{1,2})(:\d{2})?\s*(am|pm)?\b/i.test(text);
}

function extractHourMinute(text) {
  // acepta: "11", "11:00", "a las 11", "11 am"
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]?.toLowerCase();
  if (minute < 0 || minute > 59) return null;

  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  if (hour < 0 || hour > 23) return null;
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
        { method: "popup", minutes: 1440 },
        { method: "popup", minutes: 60 },
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

  const dueTasks = tasks.filter((t) => {
    if (!t.due) return false;
    const due = new Date(t.due);
    return due >= start && due <= end;
  });

  const noDueTasks = tasks.filter((t) => !t.due).slice(0, 5);
  return { events, dueTasks, noDueTasks };
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
    const state = req.query.state;
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
    "Jarvis operativo ✅\n\n1) /login\n\nEjemplos:\n- Reunión mañana con Flesan\n- Reunión 12 de febrero con Flesan\n- ¿Qué tengo hoy?\n- ¿Qué tengo mañana?\n- Recuérdame enviar propuesta el viernes"
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
    if (!auth) return bot.sendMessage(chatId, "Primero conéctate con /login.");

    const text = textRaw;
    const lower = text.toLowerCase();

    // 1) Consultas naturales de agenda
    const asksToday =
      /\b(qué|que)\b.*\b(tengo|hay)\b.*\b(hoy)\b/i.test(lower) ||
      /\b(agenda|calendario)\b.*\b(hoy)\b/i.test(lower);

    const asksTomorrow =
      /\b(qué|que)\b.*\b(tengo|hay)\b.*\b(mañana)\b/i.test(lower) ||
      /\b(agenda|calendario)\b.*\b(mañana)\b/i.test(lower);

    if (asksToday || asksTomorrow) {
      const offset = asksTomorrow ? 1 : 0;
      const label = asksTomorrow ? "mañana" : "hoy";

      const { events, dueTasks, noDueTasks } = await getAgendaAndTasks(auth, offset);

      let out = `📌 Resumen de ${label}:\n\n`;
      out += `📅 Reuniones (${events.length}):\n`;
      if (!events.length) out += "• (sin reuniones)\n";
      for (const e of events) {
        const when = e.start?.dateTime || e.start?.date;
        out += `• ${e.summary || "(sin título)"} — ${when ? fmtTime(when) : "sin hora"}\n`;
      }

      out += `\n🧾 Tareas que vencen ${label} (${dueTasks.length}):\n`;
      if (!dueTasks.length) out += "• (sin tareas)\n";
      for (const t of dueTasks) out += `• ${t.title}\n`;

      out += `\n📝 Pendientes sin fecha (top ${noDueTasks.length}):\n`;
      if (!noDueTasks.length) out += "• (sin pendientes)\n";
      for (const t of noDueTasks) out += `• ${t.title}\n`;

      return bot.sendMessage(chatId, out);
    }

    // 2) Wizard de reunión en pasos (día → hora)
    if (meetingWizard.has(chatId)) {
      const state = meetingWizard.get(chatId);

      if (state.stage === "need_date") {
        const d = parseSpanishDate(text);
        if (!d) return bot.sendMessage(chatId, 'No caché el día 😅. Ej: "mañana", "viernes", "12 feb", "12/02".');

        state.dateObj = d;
        state.stage = "need_time";
        meetingWizard.set(chatId, state);
        return bot.sendMessage(chatId, 'Perfecto. ¿A qué hora? Ej: "11", "11:00", "14:30".');
      }

      if (state.stage === "need_time") {
        const hm = extractHourMinute(text);
        if (!hm) return bot.sendMessage(chatId, 'No entendí la hora 😅. Ej: "11", "11:00", "14:30".');

        const start = new Date(state.dateObj);
        start.setHours(hm.hour, hm.minute, 0, 0);

        const link = await createCalendarEvent(auth, state.title, start);
        meetingWizard.delete(chatId);
        return bot.sendMessage(chatId, `📅 Reunión creada ✅\n${link}`);
      }
    }

    // 3) Detectar reunión (mucho más flexible)
    const wantsMeeting =
      /\b(reuni[oó]n|agendar|agenda|llamada|call|cita|bloquea|bloquear)\b/i.test(lower);

    if (wantsMeeting) {
      const dateOnly = parseSpanishDate(text);
      const timePresent = hasTime(text);

      // Si no viene fecha -> preguntar fecha
      if (!dateOnly) {
        meetingWizard.set(chatId, { title: text, stage: "need_date" });
        return bot.sendMessage(chatId, '¿Para qué día? Ej: "mañana", "viernes", "12 feb", "12/02".');
      }

      // Si viene fecha pero no hora -> preguntar hora
      if (!timePresent) {
        meetingWizard.set(chatId, { title: text, stage: "need_time", dateObj: dateOnly });
        return bot.sendMessage(chatId, 'Perfecto. ¿A qué hora? Ej: "11", "11:00", "14:30".');
      }

      // Fecha + hora en el mismo mensaje -> crear evento
      const hm = extractHourMinute(text);
      if (!hm) {
        meetingWizard.set(chatId, { title: text, stage: "need_time", dateObj: dateOnly });
        return bot.sendMessage(chatId, 'Entendí el día, pero no la hora. Ej: "11", "11:00".');
      }

      const start = new Date(dateOnly);
      start.setHours(hm.hour, hm.minute, 0, 0);

      const link = await createCalendarEvent(auth, text, start);
      return bot.sendMessage(chatId, `📅 Evento creado ✅\n${link}`);
    }

    // 4) Si no es reunión ni agenda → tarea (pero con fecha si detecta)
    const tasksApi = google.tasks({ version: "v1", auth });
    const dTask = parseSpanishDate(text);
    const taskBody = { title: text };
    if (dTask) taskBody.due = dTask.toISOString();

    await tasksApi.tasks.insert({
      tasklist: "@default",
      requestBody: taskBody,
    });

    return bot.sendMessage(chatId, `✅ Listo, lo dejé como tarea${dTask ? " con fecha" : ""}.`);
  } catch (err) {
    console.error("Assistant error:", err);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
