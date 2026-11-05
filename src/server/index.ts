import express from "express";
import { connectDB } from "../db/connection.js";
import { mdrWebhookRouter } from "./mdrWebhook.js";

// Same safety net as Agent 2: log and keep the process alive rather than
// crash on one bad code path.
process.on("uncaughtException", (err) => {
  console.error("uncaughtException (process kept alive):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection (process kept alive):", reason);
});

const app = express();
// Webhook payloads can be large (Vapi end-of-call reports especially) —
// Express's 100kb default silently 413s them.
app.use(express.json({ limit: "10mb" }));

app.use("/webhooks/mdr", mdrWebhookRouter);

// Vapi server messages (tool-calls, end-of-call-report, status-update).
// TODO: route Agent 4's tools + end-of-call handling here once they exist —
// for now just ack so Vapi doesn't see errors.
app.post("/vapi/tool-calls", (req, res) => {
  const type = req.body?.message?.type;
  if (type && type !== "status-update") {
    console.log(`vapi: received ${type} for call ${req.body?.message?.call?.id ?? "?"} (not handled yet)`);
  }
  res.status(200).json({ ok: true });
});

app.get("/health", (_req, res) => res.json({ ok: true, agent: process.env.AGENT_NAME ?? "Agent 4" }));

// Clean JSON errors (e.g. malformed JSON body) instead of Express's HTML page.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled Express error:", err);
  if (res.headersSent) return;
  const status = err?.status ?? err?.statusCode ?? 500;
  res.status(status).json({ ok: false, error: err?.message ?? "Internal server error" });
});

const PORT = process.env.PORT ?? 3003;

async function main() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`Webhook server listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
