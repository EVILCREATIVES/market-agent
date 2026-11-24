import { createHash } from "node:crypto";
import { sendBatch } from "@vercel/queue";

export const BACKGROUND_TOPIC = "market-agent-background";
const MAX_QUEUE_DELAY_SECONDS = 7 * 24 * 60 * 60;
const MAX_BATCH_SIZE = 100;

export function backgroundQueueEnabled(env = process.env) {
  return Boolean(env.VERCEL) && env.DISABLE_BACKGROUND_QUEUE !== "true";
}

export function backgroundWakePlan(wake, now = Date.now()) {
  const scheduledAt = new Date(String(wake?.scheduledAt || ""));
  if (!Number.isFinite(scheduledAt.getTime())) throw queueError("A background task needs a valid scheduled time.");
  const delaySeconds = Math.max(0, Math.min(MAX_QUEUE_DELAY_SECONDS, Math.ceil((scheduledAt.getTime() - Number(now)) / 1_000)));
  const payload = { ...wake, scheduledAt: scheduledAt.toISOString() };
  const identity = [payload.type, payload.jobId, payload.userId, payload.projectId, payload.scheduledAt].map((value) => String(value || "")).join(":");
  return {
    payload,
    delaySeconds,
    retentionSeconds: Math.max(60, Math.min(MAX_QUEUE_DELAY_SECONDS, delaySeconds + 300)),
    idempotencyKey: createHash("sha256").update(identity).digest("hex"),
  };
}

export async function enqueueBackgroundWakes(wakes, env = process.env) {
  const values = (Array.isArray(wakes) ? wakes : []).filter(Boolean);
  if (!values.length || !backgroundQueueEnabled(env)) return { queued: 0, disabled: !backgroundQueueEnabled(env) };
  const messages = values.map((wake) => backgroundWakePlan(wake));
  let queued = 0;
  for (let index = 0; index < messages.length; index += MAX_BATCH_SIZE) {
    const batch = messages.slice(index, index + MAX_BATCH_SIZE);
    const results = await sendBatch(BACKGROUND_TOPIC, batch);
    const failed = results.filter((result) => result.status === "failed");
    if (failed.length) throw queueError(`${failed.length} scheduled task${failed.length === 1 ? " was" : "s were"} not accepted by the delivery queue.`);
    queued += results.length;
  }
  return { queued, disabled: false };
}

export function nextDailyRoutineAt(schedule = {}, now = Date.now()) {
  const current = new Date(Number(now));
  const today = current.toISOString().slice(0, 10);
  const lastRunDay = String(schedule?.lastRunAt || "").slice(0, 10);
  const todayAtNoon = new Date(`${today}T12:00:00.000Z`);
  if (lastRunDay !== today && current.getTime() < todayAtNoon.getTime()) return todayAtNoon.toISOString();
  return new Date(todayAtNoon.getTime() + 24 * 60 * 60_000).toISOString();
}

export async function enqueueEnabledRoutineWakes(userId, state, env = process.env) {
  const projects = Array.isArray(state?.projects) ? state.projects : [];
  const wakes = projects.flatMap((project) => {
    const schedule = state?.schedules?.[project.id];
    return schedule?.enabled ? [{ type: "autonomy", userId, projectId: project.id, scheduledAt: nextDailyRoutineAt(schedule) }] : [];
  });
  return enqueueBackgroundWakes(wakes, env);
}

function queueError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = "BACKGROUND_QUEUE_UNAVAILABLE";
  return error;
}
