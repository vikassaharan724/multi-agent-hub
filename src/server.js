import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { initSubagents, runSubagents } from "./patterns/subagents.js";
import { initRouter, runRouter } from "./patterns/router.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: config.corsOrigins.includes("*") ? true : config.corsOrigins }));

function requireApiKey(req, res, next) {
  if (!config.apiKey) return next();
  if (req.headers["x-api-key"] !== config.apiKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "multi-agent-hub",
    patterns: {
      subagents: "POST /v1/subagents/chat",
      router: "POST /v1/router/chat",
      handoffs: "POST /v1/handoffs/chat (Day 2)",
      skills: "POST /v1/skills/chat (Day 2)",
      workflow: "POST /v1/workflow/chat (Day 2)",
    },
    specialists: {
      weather: config.weatherSpecialistUrl,
      news: config.newsSpecialistUrl || "(not set)",
      fx: config.fxSpecialistUrl || "(not set)",
    },
  });
});

app.post("/v1/subagents/chat", requireApiKey, async (req, res) => {
  try {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "message is required" });
    const threadId = String(req.body?.threadId ?? randomUUID());
    res.json(await runSubagents({ message, threadId }));
  } catch (err) {
    console.error("subagents", err);
    res.status(500).json({ error: "Subagents failed", detail: err.message });
  }
});

app.post("/v1/router/chat", requireApiKey, async (req, res) => {
  try {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return res.status(400).json({ error: "message is required" });
    const threadId = String(req.body?.threadId ?? randomUUID());
    res.json(await runRouter({ message, threadId }));
  } catch (err) {
    console.error("router", err);
    res.status(500).json({ error: "Router failed", detail: err.message });
  }
});

await initSubagents();
initRouter();

app.listen(config.port, () => {
  console.log(`Multi-agent hub http://localhost:${config.port}`);
  console.log("  POST /v1/subagents/chat");
  console.log("  POST /v1/router/chat");
});
