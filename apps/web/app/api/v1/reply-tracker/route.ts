import { type NextRequest, NextResponse } from "next/server";
import { withError } from "@/utils/middleware";
import { createScopedLogger } from "@/utils/logger";
import {
  replyTrackerQuerySchema,
  type ReplyTrackerResponse,
} from "./validation";
import { validateApiKeyAndGetGmailClient } from "@/utils/api-auth";
import { ThreadTrackerType } from "@prisma/client";
import { getPaginatedThreadTrackers } from "@/app/(app)/reply-zero/fetch-trackers";
import { getThreadsBatchAndParse } from "@/utils/gmail/thread";

const logger = createScopedLogger("api/v1/reply-tracker");

export const GET = withError(async (request: NextRequest) => {
  const { accessToken, userId } =
    await validateApiKeyAndGetGmailClient(request);

  const { searchParams } = new URL(request.url);
  const queryResult = replyTrackerQuerySchema.safeParse(
    Object.fromEntries(searchParams),
  );

  if (!queryResult.success) {
    return NextResponse.json(
      { error: "Invalid query parameters" },
      { status: 400 },
    );
  }

  try {
    function getType(type: "needs-reply" | "needs-follow-up") {
      if (type === "needs-reply") return ThreadTrackerType.NEEDS_REPLY;
      if (type === "needs-follow-up") return ThreadTrackerType.AWAITING;
      throw new Error("Invalid type");
    }

    const { trackers, count } = await getPaginatedThreadTrackers({
      userId,
      type: getType(queryResult.data.type),
      page: queryResult.data.page,
      timeRange: queryResult.data.timeRange,
    });

    const threads = await getThreadsBatchAndParse(
      trackers.map((tracker) => tracker.threadId),
      accessToken,
      false,
    );

    const response: ReplyTrackerResponse = {
      emails: threads.threads.map((thread) => ({
        threadId: thread.id,
        subject: thread.messages[thread.messages.length - 1]?.headers.subject,
        from: thread.messages[thread.messages.length - 1]?.headers.from,
        date: thread.messages[thread.messages.length - 1]?.headers.date,
        snippet: thread.messages[thread.messages.length - 1]?.snippet,
      })),
      count,
    };

    logger.info("Retrieved emails needing reply", {
      userId,
      count: response.emails.length,
    });

    return NextResponse.json(response);
  } catch (error) {
    logger.error("Error retrieving emails needing reply", {
      userId,
      error,
    });
    return NextResponse.json(
      { error: "Failed to retrieve emails" },
      { status: 500 },
    );
  }
});
