/**
 * Agent 4's own operational/audit record — one document per dial attempt,
 * same role as Agent 2's CallAttempt. Cadence/MAX_CALL_ATTEMPTS are counted
 * from these, every tool call resolves its context from vapiCallId here, and
 * the end-of-call handler writes the outcome + MDR result-push status here.
 *
 * Unique {outreachContactId, attemptNumber} makes dial creation idempotent: a
 * duplicate-key error means another dispatch run already claimed that slot.
 */
import { Schema, model } from "mongoose";

const callAttemptSchema = new Schema(
  {
    outreachContactId: { type: Number, required: true, index: true },
    attemptNumber: { type: Number, required: true },

    scheduledFor: { type: Date, required: true },
    // True when this attempt was dialed at a broker-requested callback time
    // (see dispatch.ts) rather than computed by the normal cadence.
    isCallback: { type: Boolean, default: false },
    // Indexed: every tool-call and end-of-call webhook looks the attempt up by this.
    vapiCallId: { type: String, index: true, sparse: true },
    // Timezone used for the calling window/greeting on this attempt.
    timezone: String,
    phoneDialed: String,

    status: {
      type: String,
      enum: ["in_progress", "completed", "no_answer", "voicemail", "failed"],
      default: "in_progress",
      index: true,
    },

    // Set by tool calls mid-call; filled in by end-of-call if no tool fired.
    callResult: {
      type: String,
      enum: ["rep_assigned", "declined", "callback", "connected", "voicemail"],
    },

    // Rep assignment (assign_existing_rep / create_new_rep).
    assignedRep: {
      name: String,
      email: String,
      phone: String,
      taiSalesRepId: String,
      isNewRep: Boolean,
      mdrSalesRepId: Number, // broker_sales_reps[].id, for an existing rep
    },
    mdrRepSubmission: { type: String, enum: ["submitted", "failed"] },
    mdrRepError: String,

    declineReason: String,
    declineNote: String,

    // schedule_callback
    callbackAt: Date,
    callbackReason: String,
    // A new rep whose details were collected but whose TAI ID wasn't known
    // yet — carried into the callback call so the agent only asks for the ID.
    pendingRep: {
      name: String,
      email: String,
      phone: String,
      // true = already in broker_sales_reps (only the TAI ID was missing) →
      // the callback finishes with assign_existing_rep, not create_new_rep.
      isExistingRep: Boolean,
    },

    // End-of-call artifacts
    transcript: String,
    recordingUrl: String,
    summary: String,
    endedReason: String,
    startedAt: Date,
    endedAt: Date,
    durationSeconds: { type: Number, default: 0 },
    vapiCost: Number,
    twilioCallSid: String,
    twilioCost: Number,

    // MDR /shipment-opportunity/result push — set once, so a retried
    // end-of-call-report webhook never double-reports the same call.
    mdrResultStatus: String,
    mdrResultSubmittedAt: Date,
    mdrResultError: String,
  },
  { timestamps: true }
);

callAttemptSchema.index({ outreachContactId: 1, attemptNumber: 1 }, { unique: true });

export const CallAttempt = model("CallAttempt", callAttemptSchema);
