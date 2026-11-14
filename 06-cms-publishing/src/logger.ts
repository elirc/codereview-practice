import pino from "pino";
import { getEnv } from "@/env";

export const logger = pino({
  level: getEnv().LOG_LEVEL,
  base: { service: "cms-web" },
  redact: {
    paths: [
      "password",
      "*.password",
      "token",
      "*.token",
      "*.authorization",
      "*.cookie",
      "headers.authorization",
      "headers.cookie",
    ],
    censor: "[redacted]",
  },
});
