import pino, { type DestinationStream, type Logger } from "pino";

export const REDACTED_LOG_PATHS = [
  "err.event.payload",
  "err.event.signature",
  "err.event.event.payload",
  "err.event.event.signature",
  "err.aggregateErrors[*].event.payload",
  "err.aggregateErrors[*].event.signature",
  "event.payload",
  "event.signature",
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.x-hub-signature-256",
  "headers.authorization",
  "headers.cookie",
  "headers.x-hub-signature-256",
] as const;

export const createLogger = (destination?: DestinationStream): Logger =>
  pino(
    {
      level: process.env.LOG_LEVEL ?? "info",
      redact: { paths: [...REDACTED_LOG_PATHS], censor: "[REDACTED]" },
    },
    destination,
  );
