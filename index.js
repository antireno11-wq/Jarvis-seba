import express from "express";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("No TELEGRAM_BOT_TOKEN found.");
  process.exit(1);
}

// Configuración webhook
const bot = new TelegramBot(token, { webHook: true });

// Endpoint webhook FIJO (sin token en URL)
app.post("/webhook", (req, res) => {
  console.log("Incoming update:", JSON.stringify(req.body));
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Endpoint raíz
app.get("/", (req, res) => {
  res.status(200).send("Jarvis is alive");
});

// Endpoint healthcheck para Railway
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// Comando /start
bot.onText(/\/start/i, (msg) => {
  bot.sendMessage(msg.chat.id, "Jarvis operativo. Dime 'hola' para probar.");
});

// Respuesta básica
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  if (text.toLowerCase().includes("hola")) {
    bot.sendMessage(chatId, "Hola Seba. Jarvis operativo.");
  } else {
    bot.sendMessage(chatId, `Recibido: ${text}`);
  }
});

const PORT = process.env.PORT || 8080;

// MUY IMPORTANTE: escuchar en 0.0.0.0
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
