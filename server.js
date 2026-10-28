
const express = require("express");
const path = require("path");

const app = express();

app.use(express.json({ limit: "10kb" }));
app.use(express.static(__dirname));

app.post("/api/lead", async (req, res) => {
  const email = String(req.body.email || "").trim();

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return res.status(400).json({
      ok: false,
      message: "Проверь адрес электронной почты."
    });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return res.status(500).json({
      ok: false,
      message: "Сервис пока не настроен."
    });
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `🔔 Новая заявка VetaStart\nEmail: ${email}`
        })
      }
    );

    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error("Telegram sendMessage failed");
    }

    return res.json({
      ok: true,
      message: "Заявка отправлена!"
    });
  } catch (error) {
    console.error("Не удалось отправить заявку в Telegram");
    return res.status(502).json({
      ok: false,
      message: "Не получилось отправить заявку. Попробуй позже."
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const port = process.env.PORT || 10000;
app.listen(port, "0.0.0.0", () => {
  console.log(`VetaStart запущен на порту ${port}`);
});
