/**
 * Pattern 2: Router
 * Classify → dispatch to specialist(s) in parallel → synthesize.
 * @see https://docs.langchain.com/oss/javascript/langchain/multi-agent/router
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { initChatModel } from "langchain";
import * as z from "zod";
import { config } from "../config.js";
import { callSpecialist } from "../specialists/client.js";

const RouteSchema = z.object({
  routes: z
    .array(
      z.object({
        agent: z.enum(["news", "fx", "weather"]),
        query: z.string().describe("Focused sub-question for this specialist"),
      })
    )
    .describe("Specialists to call in parallel. Empty if no specialist is needed."),
  directReply: z
    .string()
    .optional()
    .describe("Short reply when routes is empty (greetings, off-topic, clarify)."),
});

function specialistRegistry() {
  return {
    news: { url: config.newsSpecialistUrl, label: "Hacker News" },
    fx: { url: config.fxSpecialistUrl, label: "currency exchange" },
    weather: { url: config.weatherSpecialistUrl, label: "weather" },
  };
}

let chatModel = null;

async function getModel() {
  if (!chatModel) {
    chatModel = await initChatModel(config.model);
  }
  return chatModel;
}

async function classify(message) {
  const model = (await getModel()).withStructuredOutput(RouteSchema);
  return model.invoke([
    new SystemMessage(`You are a query router. Split the user message into specialist tasks.

Specialists:
- news: Hacker News tech stories, AI/tech headlines, startup news
- fx: currency exchange rates, conversions (USD, EUR, GBP, etc.)
- weather: real-time weather in a city

Rules:
- Return one route per specialist needed. Use focused sub-questions in "query".
- Multi-domain questions → multiple routes (e.g. fx + news).
- Greetings or "what can you do?" → routes: [], set directReply.
- Do not route to weather unless the user clearly asks about weather.

Examples:
- "USD to EUR rate" → routes: [{ agent: "fx", query: "USD to EUR exchange rate" }]
- "HN stories about OpenAI" → routes: [{ agent: "news", query: "Hacker News stories about OpenAI" }]
- "USD to GBP and HN news on LangChain" → routes: [fx route, news route]
- "Hello" → routes: [], directReply: brief friendly greeting`),
    new HumanMessage(message),
  ]);
}

async function dispatchRoutes(routes) {
  const registry = specialistRegistry();
  const tasks = routes.map(async ({ agent, query }) => {
    const spec = registry[agent];
    if (!spec?.url) {
      return { agent, query, reply: `Error: ${agent} specialist URL not configured on hub.` };
    }
    try {
      const reply = await callSpecialist({ baseUrl: spec.url, message: query });
      return { agent, query, reply };
    } catch (err) {
      return { agent, query, reply: `Error calling ${agent}: ${err.message}` };
    }
  });
  return Promise.all(tasks);
}

async function synthesize(message, results) {
  const blocks = results
    .map((r) => `### ${r.agent} specialist\nQuestion: ${r.query}\nAnswer:\n${r.reply}`)
    .join("\n\n");

  const model = await getModel();
  const res = await model.invoke([
    new SystemMessage(
      "Synthesize specialist answers into one clear reply. Keep facts from specialists; do not invent data."
    ),
    new HumanMessage(`User asked: ${message}\n\n${blocks}\n\nWrite one combined answer:`),
  ]);

  const content = res.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
  }
  return String(content);
}

export function initRouter() {
  console.log("Router pattern ready (classify → parallel dispatch → synthesize)");
}

export async function runRouter({ message, threadId }) {
  const classification = await classify(message);
  const routes = classification.routes ?? [];

  if (routes.length === 0) {
    return {
      pattern: "router",
      reply:
        classification.directReply?.trim() ||
        "I can help with Hacker News tech stories, currency rates, or weather. What would you like?",
      routedTo: [],
      threadId,
      steps: { classify: classification, dispatch: [], synthesized: false },
    };
  }

  const results = await dispatchRoutes(routes);
  const routedTo = results.map((r) => r.agent);

  let reply;
  let synthesized = false;
  if (results.length === 1) {
    reply = results[0].reply;
  } else {
    reply = await synthesize(message, results);
    synthesized = true;
  }

  return {
    pattern: "router",
    reply,
    routedTo,
    threadId,
    steps: {
      classify: classification,
      dispatch: results.map(({ agent, query }) => ({ agent, query })),
      synthesized,
    },
  };
}
