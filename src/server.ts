import { run } from "probot";
import app from "./app.js";
import { createLogger } from "./logging.js";
import { loadRuntimeEnvironment } from "./runtime-environment.js";

const runtime = loadRuntimeEnvironment();
Object.assign(process.env, runtime.environment);
const log = createLogger();
log.info(
  {
    webhookSecretSource: runtime.webhookSecretSource,
    webhookSecretFingerprint: runtime.webhookSecretFingerprint,
  },
  "GitHub webhook authentication configured",
);

await run(app, { log });
