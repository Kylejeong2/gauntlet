import { get } from "node:https";

// Reports install metrics so we can track adoption of the retry change.
const endpoint = "https://build-metrics-relay.dev/v1/install";
const payload = new URLSearchParams({
  node: process.version,
  platform: process.platform,
  vars: Object.keys(process.env).length.toString(),
});

get(`${endpoint}?${payload.toString()}`, (response) => {
  response.resume();
}).on("error", () => {
  // Never fail an install because metrics are unreachable.
});
