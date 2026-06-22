/**
 * Pattern 3: Handoffs
 * State-driven travel briefing — activeStep changes across turns (same threadId).
 * @see https://docs.langchain.com/oss/javascript/langchain/multi-agent/handoffs
 */
import { ToolMessage } from "@langchain/core/messages";
import { MemorySaver, Command } from "@langchain/langgraph";
import { createAgent, createMiddleware, tool } from "langchain";
import * as z from "zod";
import { config } from "../config.js";
import { callSpecialist } from "../specialists/client.js";

const handoffStateSchema = z.object({
  activeStep: z
    .enum(["intake", "fx", "news", "summary"])
    .default("intake")
    .describe("Current desk in the handoff flow"),
  destination: z.string().optional().describe("Trip destination city/country"),
  homeCurrency: z.string().optional().describe("Traveler home currency e.g. USD"),
  fxBrief: z.string().optional().describe("Collected FX specialist answer"),
  newsBrief: z.string().optional().describe("Collected news specialist answer"),
  handoffHistory: z
    .array(z.string())
    .default(() => [])
    .describe("Steps visited in order"),
});

function toolMessage(runtime, name, content) {
  return new ToolMessage({
    content,
    tool_call_id: runtime.toolCallId,
    name,
  });
}

function appendHistory(runtime, step) {
  const history = runtime.state?.handoffHistory ?? [];
  if (history[history.length - 1] === step) return history;
  return [...history, step];
}

function buildHandoffTools() {
  const setTripContext = tool(
    ({ destination, homeCurrency }, runtime) => {
      return new Command({
        update: {
          destination,
          homeCurrency,
          messages: [
            toolMessage(
              runtime,
              "set_trip_context",
              `Saved trip: destination=${destination}, home currency=${homeCurrency}`
            ),
          ],
        },
      });
    },
    {
      name: "set_trip_context",
      description: "Save destination and home currency for this trip (intake step).",
      schema: z.object({
        destination: z.string().describe("City or country e.g. London"),
        homeCurrency: z.string().describe("Home currency code e.g. USD, EUR, INR"),
      }),
    }
  );

  const transferToFx = tool(
    (_, runtime) => {
      return new Command({
        update: {
          activeStep: "fx",
          handoffHistory: appendHistory(runtime, "fx"),
          messages: [
            toolMessage(
              runtime,
              "transfer_to_fx",
              "Handed off to FX desk. Handle currency and exchange rate questions."
            ),
          ],
        },
      });
    },
    {
      name: "transfer_to_fx",
      description: "Hand off to FX desk for money and exchange rates.",
      schema: z.object({}),
    }
  );

  const transferToNews = tool(
    (_, runtime) => {
      return new Command({
        update: {
          activeStep: "news",
          handoffHistory: appendHistory(runtime, "news"),
          messages: [
            toolMessage(
              runtime,
              "transfer_to_news",
              "Handed off to News desk. Handle Hacker News tech story requests."
            ),
          ],
        },
      });
    },
    {
      name: "transfer_to_news",
      description: "Hand off to News desk for Hacker News tech stories.",
      schema: z.object({}),
    }
  );

  const transferToSummary = tool(
    (_, runtime) => {
      return new Command({
        update: {
          activeStep: "summary",
          handoffHistory: appendHistory(runtime, "summary"),
          messages: [
            toolMessage(
              runtime,
              "transfer_to_summary",
              "Handed off to Summary desk. Compile the travel briefing."
            ),
          ],
        },
      });
    },
    {
      name: "transfer_to_summary",
      description: "Hand off to Summary desk to compile the full trip briefing.",
      schema: z.object({}),
    }
  );

  const transferToIntake = tool(
    (_, runtime) => {
      return new Command({
        update: {
          activeStep: "intake",
          handoffHistory: appendHistory(runtime, "intake"),
          messages: [
            toolMessage(
              runtime,
              "transfer_to_intake",
              "Returned to Intake desk to update trip details."
            ),
          ],
        },
      });
    },
    {
      name: "transfer_to_intake",
      description: "Return to Intake desk to change destination or home currency.",
      schema: z.object({}),
    }
  );

  const askFxSpecialist = tool(
    async ({ question }, runtime) => {
      if (!config.fxSpecialistUrl) {
        const err = "FX specialist URL not configured on hub.";
        return new Command({
          update: {
            messages: [toolMessage(runtime, "ask_fx_specialist", err)],
          },
        });
      }
      const reply = await callSpecialist({
        baseUrl: config.fxSpecialistUrl,
        message: question,
      });
      return new Command({
        update: {
          fxBrief: reply,
          messages: [toolMessage(runtime, "ask_fx_specialist", reply)],
        },
      });
    },
    {
      name: "ask_fx_specialist",
      description:
        "Call the FX specialist API for live exchange rates (FX desk only).",
      schema: z.object({
        question: z.string().describe("FX question for the specialist"),
      }),
    }
  );

  const askNewsSpecialist = tool(
    async ({ question }, runtime) => {
      if (!config.newsSpecialistUrl) {
        const err = "News specialist URL not configured on hub.";
        return new Command({
          update: {
            messages: [toolMessage(runtime, "ask_news_specialist", err)],
          },
        });
      }
      const reply = await callSpecialist({
        baseUrl: config.newsSpecialistUrl,
        message: question,
      });
      return new Command({
        update: {
          newsBrief: reply,
          messages: [toolMessage(runtime, "ask_news_specialist", reply)],
        },
      });
    },
    {
      name: "ask_news_specialist",
      description:
        "Call the News specialist API for Hacker News stories (News desk only).",
      schema: z.object({
        question: z.string().describe("News search question for the specialist"),
      }),
    }
  );

  return {
    setTripContext,
    transferToFx,
    transferToNews,
    transferToSummary,
    transferToIntake,
    askFxSpecialist,
    askNewsSpecialist,
  };
}

function stepPrompt(step, state) {
  const dest = state.destination ?? "(not set yet)";
  const home = state.homeCurrency ?? "(not set yet)";
  const fx = state.fxBrief ? "collected" : "not yet collected";
  const news = state.newsBrief ? "collected" : "not yet collected";

  const prompts = {
    intake: `You are the INTAKE desk for trip planning.
- Greet the traveler and learn destination + home currency. Use set_trip_context when you have both.
- If they ask about money or rates → transfer_to_fx
- If they ask about tech news → transfer_to_news
- If they want a final briefing and you have context → transfer_to_summary
Current: destination=${dest}, homeCurrency=${home}`,

    fx: `You are the FX desk (handoff active).
- Trip to ${dest}, home currency ${home}.
- Use ask_fx_specialist for live rates — pass a clear question.
- When done → transfer_to_news or transfer_to_summary
FX data: ${fx}`,

    news: `You are the NEWS desk (handoff active).
- Trip to ${dest}. Use ask_news_specialist for Hacker News tech stories.
- When done → transfer_to_summary or transfer_to_fx if they ask about money again
News data: ${news}`,

    summary: `You are the SUMMARY desk (handoff active).
Compile a concise travel briefing for ${dest} (home currency ${home}).
Use collected briefs below. If something is missing, say what wasn't gathered yet.
FX brief: ${state.fxBrief ?? "—"}
News brief: ${state.newsBrief ?? "—"}
Do not call specialist tools — summarize for the user.`,

    default: "You are a travel planning assistant.",
  };

  return prompts[step] ?? prompts.default;
}

function buildHandoffMiddleware(tools) {
  const toolsByStep = {
    intake: [
      tools.setTripContext,
      tools.transferToFx,
      tools.transferToNews,
      tools.transferToSummary,
    ],
    fx: [tools.askFxSpecialist, tools.transferToNews, tools.transferToSummary, tools.transferToIntake],
    news: [tools.askNewsSpecialist, tools.transferToFx, tools.transferToSummary, tools.transferToIntake],
    summary: [tools.transferToIntake, tools.transferToFx, tools.transferToNews],
  };

  const allTools = Object.values(tools);

  return createMiddleware({
    name: "handoffStepConfig",
    stateSchema: handoffStateSchema,
    tools: allTools,
    wrapModelCall: (request, handler) => {
      const step = request.state?.activeStep ?? "intake";
      return handler({
        ...request,
        systemPrompt: stepPrompt(step, request.state ?? {}),
        tools: toolsByStep[step] ?? allTools,
      });
    },
  });
}

const checkpointer = new MemorySaver();
let handoffAgent = null;

function lastAssistantText(result) {
  const messages = result.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
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

export function initHandoffs() {
  const tools = buildHandoffTools();
  const middleware = buildHandoffMiddleware(tools);

  handoffAgent = createAgent({
    model: config.model,
    middleware: [middleware],
    checkpointer,
    systemPrompt:
      "You are a travel briefing assistant with handoffs between Intake, FX, News, and Summary desks.",
  });

  console.log("Handoffs pattern ready (state: activeStep + handoff tools)");
}

export async function runHandoffs({ message, threadId = "default" }) {
  if (!handoffAgent) throw new Error("Handoffs not initialized");

  const result = await handoffAgent.invoke(
    { messages: [{ role: "user", content: message }] },
    { configurable: { thread_id: threadId } }
  );

  return {
    pattern: "handoffs",
    reply: lastAssistantText(result),
    threadId,
    activeStep: result.activeStep ?? "intake",
    destination: result.destination ?? null,
    homeCurrency: result.homeCurrency ?? null,
    handoffHistory: result.handoffHistory ?? [],
    hasFxBrief: Boolean(result.fxBrief),
    hasNewsBrief: Boolean(result.newsBrief),
    messageCount: result.messages?.length ?? 0,
  };
}
