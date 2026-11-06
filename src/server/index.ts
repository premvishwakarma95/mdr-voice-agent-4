import express from "express";
import cron from "node-cron";
import { connectDB } from "../db/connection.js";
import { mdrWebhookRouter } from "./mdrWebhook.js";
import { dispatchRouter, runDispatchCycle } from "./dispatch.js";
import { handleToolCalls, handleEndOfCallReport } from "./webhookHandlers.js";
import { requireVapiSecret } from "./auth.js";
import { recordingsRouter } from "./recordings.js";

// Same safety net as Agent 2: log and keep the process alive rather than
// crash on one bad code path.
process.on("uncaughtException", (err) => {
  console.error("uncaughtException (process kept alive):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection (process kept alive):", reason);
});

const app = express();
// Vapi end-of-call reports carry full transcripts — Express's 100kb default 413s them.
app.use(express.json({ limit: "10mb" }));

app.use("/webhooks/mdr", mdrWebhookRouter);
app.use("/dispatch", dispatchRouter);
app.use("/recordings", recordingsRouter);

/** Vapi sends arguments as a JSON string or an already-parsed object (seen on Agent 2). Never throws. */
function parseArguments(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object") return raw as Record<string, any>;
  if (typeof raw === "string" && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch {
      console.warn(`tool-calls: unparseable arguments ${raw.slice(0, 200)}`);
    }
  }
  return {};
}

app.post("/vapi/tool-calls", requireVapiSecret, async (req, res) => {
  const message = req.body?.message;
  try {
    if (message?.type === "tool-calls") {
      const toolCallList = (message?.toolCallList ?? []).map((call: any) => ({
        id: call?.id,
        name: call?.function?.name,
        parameters: parseArguments(call?.function?.arguments),
      }));
      const results = await handleToolCalls(toolCallList, message?.call?.id);
      res.json({ results });
      return;
    }
    if (message?.type === "end-of-call-report") {
      await handleEndOfCallReport(message);
      res.status(200).json({ ok: true });
      return;
    }
    // status-update etc. — ack and ignore.
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("vapi webhook handler error:", err);
    res.status(500).json({ ok: false, error: (err as Error)?.message });
  }
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

async function scheduledDispatchTick() {
  const result = await runDispatchCycle(false);
  if (result.ok) console.log("Scheduled dispatch cycle:", result.summary);
  else console.error("Scheduled dispatch cycle failed:", result.error);
}

async function main() {
  await connectDB();
  app.listen(PORT, () => console.log(`Webhook server listening on port ${PORT}`));

  // Follow-up attempts (2-4) only — attempt 1 is placed from the webhook.
  // Once on startup, then every 5 minutes. Set
  // DISPATCH_CRON_ENABLED=false to run the server without auto-dialing.
  if (process.env.DISPATCH_CRON_ENABLED === "false") {
    console.log("Dispatch cron disabled (DISPATCH_CRON_ENABLED=false) — use POST /dispatch/run");
    return;
  }
  await scheduledDispatchTick();
  cron.schedule("*/5 * * * *", scheduledDispatchTick);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
