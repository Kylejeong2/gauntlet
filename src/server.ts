import { run } from "probot";
import app from "./app.js";
import { createLogger } from "./logging.js";

await run(app, { log: createLogger() });
