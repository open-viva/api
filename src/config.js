import dotenv from "dotenv";

dotenv.config();

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: toNumber(process.env.PORT, 3000),
  classevivaBaseUrl: process.env.CLASSEVIVA_BASE_URL || "https://web.spaggiari.eu/rest",
  version: process.env.VERSION || "1.0.0",
  classevivaUserAgent: process.env.CLASSEVIVA_USER_AGENT || "CVVS/std/4.1.7 Android/10",
  classevivaDevApiKey: process.env.CLASSEVIVA_DEV_API_KEY || "Tg1NWEwNGIgIC0K",
  classevivaContentsDiaryType:
    process.env.CLASSEVIVA_CONTENTS_DIARY_TYPE || "application/json",
  requestTimeoutMs: toNumber(process.env.REQUEST_TIMEOUT_MS, 15000)
};
