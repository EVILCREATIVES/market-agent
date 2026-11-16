const requiredHeaders = {
  specVersion: "ce-specversion",
  type: "ce-type",
  source: "ce-source",
  executionId: "ce-id",
  scheduleId: "x-vercel-schedule-id",
  name: "x-vercel-schedule-name",
  namespace: "x-vercel-schedule-namespace",
  scheduledAt: "x-vercel-schedule-scheduled-at",
  scheduleSource: "x-vercel-schedule-source",
  expression: "x-vercel-schedule-expression",
};

function requiredHeader(request, name) {
  const value = request.headers.get(name);
  if (!value) throw new Error(`Missing schedule header: ${name}`);
  return value;
}

export function handleSchedule(handler) {
  return async (request) => {
    try {
      const values = Object.fromEntries(Object.entries(requiredHeaders).map(([key, name]) => [key, requiredHeader(request, name)]));
      if (values.specVersion !== "1.0" || values.type !== "com.vercel.schedule.v1beta") {
        return Response.json({ error: "Unsupported schedule event." }, { status: 400 });
      }
      const scheduledAt = new Date(values.scheduledAt);
      if (Number.isNaN(scheduledAt.getTime())) return Response.json({ error: "Invalid scheduled time." }, { status: 400 });
      await handler({ ...values, scheduledAt }, request);
      return new Response(null, { status: 200 });
    } catch (error) {
      const message = String(error?.message || "Invalid schedule event.");
      return Response.json({ error: message }, { status: message.startsWith("Missing schedule header") ? 400 : 500 });
    }
  };
}
