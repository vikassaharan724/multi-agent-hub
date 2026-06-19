import { randomUUID } from "node:crypto";
import { config } from "../config.js";

/**
 * Call a deployed specialist agent (weather-agent, news-specialist, fx-specialist).
 * Subagents are stateless — fresh thread per call unless threadId passed.
 */
export async function callSpecialist({ baseUrl, message, threadId }) {
  const url = baseUrl.replace(/\/$/, "") + "/v1/chat";
  const headers = { "Content-Type": "application/json" };
  if (config.specialistApiKey) {
    headers["x-api-key"] = config.specialistApiKey;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message,
      threadId: threadId ?? randomUUID(),
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Specialist ${baseUrl} failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.reply ?? JSON.stringify(data);
}
