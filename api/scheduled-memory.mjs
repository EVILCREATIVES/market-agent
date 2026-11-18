import { archiveCompletedConversationDays } from "../server/conversation-memory.mjs";
import { handleSchedule } from "../server/schedule-handler.mjs";

export const POST = handleSchedule(async () => {
  await archiveCompletedConversationDays(process.env, 100);
});
