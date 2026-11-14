import pino from "pino";
import { env } from "./env";

export type { Logger } from "pino";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "clinic-booking" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "password",
      "*.password",
      "passwordHash",
      "*.passwordHash",
      "token",
      "*.token",
      "headers.cookie",
      "*.headers.cookie",
    ],
    censor: "[redacted]",
  },
});
