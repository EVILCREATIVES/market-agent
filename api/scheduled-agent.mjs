import { runAutonomyCycles } from "../server/autonomy.mjs";
import { handleSchedule } from "../server/schedule-handler.mjs";

export const POST = handleSchedule(async () => {
  await runAutonomyCycles(process.env, 5);
});
