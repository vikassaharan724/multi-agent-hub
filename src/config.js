import "dotenv/config";

const required = ["OPENAI_API_KEY"];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

export const config = {
  port: Number(process.env.PORT ?? 3010),
  model: process.env.MODEL ?? "openai:gpt-4o-mini",
  apiKey: process.env.API_KEY ?? "",
  specialistApiKey: process.env.SPECIALIST_API_KEY ?? process.env.API_KEY ?? "",
  weatherSpecialistUrl:
    process.env.WEATHER_SPECIALIST_URL ?? "https://weather-agent-37xd.onrender.com",
  newsSpecialistUrl: process.env.NEWS_SPECIALIST_URL ?? "",
  fxSpecialistUrl: process.env.FX_SPECIALIST_URL ?? "",
  corsOrigins: (process.env.CORS_ORIGINS ?? "*").split(",").map((s) => s.trim()),
};
