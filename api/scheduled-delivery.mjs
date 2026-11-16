import { runScheduledDeliveryJobs } from "../server/delivery.mjs";
import { handleSchedule } from "../server/schedule-handler.mjs";

export const POST = handleSchedule(async () => {
  await runScheduledDeliveryJobs(process.env, 25);
});
