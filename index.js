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

const bot = new TelegramBot(token);

app.post(`/webhook/${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

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

app.get("/", (req, res) => {
  res.send("Jarvis is alive");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
