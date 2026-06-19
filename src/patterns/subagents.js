/**
 * Pattern 1: Subagents
 * Main supervisor coordinates specialist agents as tools.
 * @see https://docs.langchain.com/oss/javascript/langchain/multi-agent/subagents
 */
import { MemorySaver } from "@langchain/langgraph";
import { createAgent, tool } from "langchain";
import * as z from "zod";
import { config } from "../config.js";
import { callSpecialist } from "../specialists/client.js";

const checkpointer = new MemorySaver();
let supervisor = null;

function specialistTool(name, description, baseUrl) {
  return tool(
    async ({ query }) => {
      if (!baseUrl) return `Error: ${name} specialist URL not configured on hub.`;
      return callSpecialist({ baseUrl, message: query });
    },
    {
      name,
      description,
      schema: z.object({
        query: z.string().describe("Question or task for this specialist"),
      }),
    }
  );
}

export async function initSubagents() {
  const tools = [
    specialistTool(
      "weather_specialist",
      "Expert for real-time weather in any city. Use for temperature, conditions, forecasts.",
      config.weatherSpecialistUrl
    ),
    specialistTool(
      "news_specialist",
      "Expert for Hacker News tech stories. Use for headlines, AI/tech news search.",
      config.newsSpecialistUrl
    ),
    specialistTool(
      "fx_specialist",
      "Expert for currency exchange rates and conversions (ECB data).",
      config.fxSpecialistUrl
    ),
  ];

  supervisor = createAgent({
    model: config.model,
    tools,
    checkpointer,
    systemPrompt: `You are a supervisor assistant coordinating three specialists:
- weather_specialist: real weather data
- news_specialist: Hacker News tech news
- fx_specialist: currency exchange rates

For each user question, decide which specialist(s) to call. You may call multiple in parallel if the question spans domains.
Combine their answers into one clear response for the user.`,
  });

  console.log("Subagents pattern ready (supervisor + 3 specialist tools)");
}

function lastAssistantText(result) {
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const msg = result.messages[i];
    const type = msg._getType?.() ?? msg.type;
    if (type === "ai" || type === "AIMessage") {
      const c = msg.content;
      if (typeof c === "string" && c.trim()) return c;
      if (Array.isArray(c)) {
        return c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
      }
    }
  }
  return "";
}

export async function runSubagents({ message, threadId = "default" }) {
  if (!supervisor) throw new Error("Subagents not initialized");
  const result = await supervisor.invoke(
    { messages: [{ role: "user", content: message }] },
    { configurable: { thread_id: threadId } }
  );
  return {
    pattern: "subagents",
    reply: lastAssistantText(result),
    threadId,
    messageCount: result.messages?.length ?? 0,
  };
}
