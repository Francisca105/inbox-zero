import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import { getOutlookThreads } from "@/app/api/outlook/threads/controller"; // <-- Use your Outlook controller
import { threadsQuery } from "@/app/api/google/threads/validation";
import { getGraphClientAndAccessTokenForEmail } from "@/utils/account"; // <-- You need to implement this

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = withEmailAccount(async (request) => {
  const emailAccountId = request.auth.emailAccountId;
  console.log("emailAccountId", emailAccountId); // Add this line

  const { searchParams } = new URL(request.url);
  const limit = searchParams.get("limit");
  const fromEmail = searchParams.get("fromEmail");
  const type = searchParams.get("type");
  const nextPageToken = searchParams.get("nextPageToken");
  const q = searchParams.get("q");
  const folderId = searchParams.get("folderId");
  const query = threadsQuery.parse({
    limit,
    fromEmail,
    type,
    nextPageToken,
    q,
    folderId,
  });

  // Get Microsoft Graph client and access token
  const { graphClient, accessToken } =
    await getGraphClientAndAccessTokenForEmail({
      emailAccountId,
    });

  if (!accessToken) return NextResponse.json({ error: "Account not found" });

  const threads = await getOutlookThreads({
    query,
    emailAccountId,
    graphClient,
    accessToken,
  });
  return NextResponse.json(threads);
});
