/**
 * Creates (or updates, if EVERLY_ASSISTANT_ID is set) the Agent 4 assistant in Vapi.
 *
 * Usage:
 *   npm run assistant:create
 *
 * Every setting below (LLM, voice/TTS, transcriber/STT, voicemail detection,
 * hooks, speaking plans, timeouts, recording) is copied as-is from Agent 2's
 * live staging assistant (verified against Vapi on 2026-11-04) — see Agent 2's
 * src/assistant/create.ts for the full history/reasoning behind each value.
 * Only the prompt (prompt.ts) and tools (tools.ts) differ for Agent 4.
 *
 * After running, re-read the assistant from Vapi (GET /assistant/<id>) and
 * check name, server.url and every tool's server.url — Agent 2's server once
 * silently failed to apply a change on the first attempt.
 */
import { vapi, VapiError } from "../vapi/client.js";
import { VOICEMAIL_MESSAGE, SYSTEM_PROMPT } from "./prompt.js";
import { TOOLS, serverConfig } from "./tools.js";

const assistantPayload = {
  // Dashboard label only — never spoken on calls.
  name: process.env.AGENT_NAME ?? "Agent 4",
  firstMessage: "",
  firstMessageMode: "assistant-waits-for-user",
  silenceTimeoutSeconds: 60,
  hooks: [
    {
      on: "customer.speech.timeout",
      options: { timeoutSeconds: 30, triggerMaxCount: 1, triggerResetMode: "onUserSpeech" },
      do: [{ type: "say", exact: "Hello? Are you there?" }],
    },
  ],
  voicemailMessage: VOICEMAIL_MESSAGE,
  voicemailDetection: {
    provider: "vapi",
    backoffPlan: { startAtSeconds: 2, frequencySeconds: 2.5, maxRetries: 5 },
    beepMaxAwaitSeconds: 20,
  },
  // LLM
  model: {
    provider: "openai",
    model: "gpt-4.1",
    temperature: 0.4,
    messages: [{ role: "system", content: SYSTEM_PROMPT }],
    tools: TOOLS,
  },
  // TTS
  voice: {
    provider: "11labs",
    voiceId: "gE0owC0H9C8SzfDyIUtB",
    model: "eleven_v3",
    speed: 1.0,
    stability: 0.3,
    similarityBoost: 0.8,
    style: 0.65,
  },
  // STT
  transcriber: {
    provider: "deepgram",
    model: "nova-3",
    language: "en",
  },
  startSpeakingPlan: {
    waitSeconds: 0.8,
    smartEndpointingPlan: { provider: "vapi" },
  },
  stopSpeakingPlan: {
    numWords: 2,
    voiceSeconds: 0.2,
    backoffSeconds: 1,
  },
  endCallMessage: "Thank you for your time today. Have a great rest of your day.",
  maxDurationSeconds: 900,
  // Explicitly [] (not omitted) — Vapi's PATCH leaves omitted fields unchanged.
  endCallPhrases: [],
  artifactPlan: {
    recordingEnabled: true,
    transcriptPlan: { enabled: true },
  },
  // Set on Agent 2's live assistant (not in its create.ts) — copied to match.
  analysisPlan: {
    summaryPlan: { enabled: false },
    successEvaluationPlan: { enabled: false },
  },
  // Includes server.secret when VAPI_SERVER_SECRET is set (checked in index.ts).
  server: serverConfig(),
  serverMessages: ["end-of-call-report", "status-update"],
};

async function main() {
  const existingId = process.env.EVERLY_ASSISTANT_ID;

  try {
    if (existingId) {
      const updated = await vapi.patch<{ id: string }>(`/assistant/${existingId}`, assistantPayload);
      console.log(`Updated existing Agent 4 assistant: ${updated.id}`);
    } else {
      const created = await vapi.post<{ id: string }>("/assistant", assistantPayload);
      console.log(`Created Agent 4 assistant: ${created.id}`);
      console.log(`Add this to .env: EVERLY_ASSISTANT_ID=${created.id}`);
    }
  } catch (err) {
    if (err instanceof VapiError) {
      console.error(`Vapi rejected the assistant payload (status ${err.status}):`);
      console.error(JSON.stringify(err.body, null, 2));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

main();
