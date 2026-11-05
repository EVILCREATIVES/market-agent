import { handleUpload } from "@vercel/blob/client";
import { requireUser } from "../server/auth.mjs";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    const result = await handleUpload({
      request: req,
      body: req.body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = JSON.parse(clientPayload || "{}");
        const projectId = String(payload.projectId || "").trim().slice(0, 200);
        if (!projectId || !pathname.startsWith(`market-agent-assets/${encodeURIComponent(userId)}/${encodeURIComponent(projectId)}/`)) {
          throw new Error("The upload destination is invalid.");
        }
        return {
          maximumSizeInBytes: 150 * 1024 * 1024,
          addRandomSuffix: true,
          allowOverwrite: false,
          tokenPayload: JSON.stringify({ userId, projectId }),
        };
      },
    });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ error: error.message || "Asset upload could not start." });
  }
}
