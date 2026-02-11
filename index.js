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

// Webhook mode
const bot = new TelegramBot(token);

app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Health check
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// Root
app.get("/", (req, res) => {
  res.send("Jarvis is alive");
});

bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;

    if (text.toLowerCase().includes("hola")) {
      await bot.sendMessage(chatId, "Hola Seba. Jarvis operativo.");
    } else {
      await bot.sendMessage(chatId, `Recibido: ${text}`);
    }
  } catch (err) {
    console.error("Error sending message:", err);
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
