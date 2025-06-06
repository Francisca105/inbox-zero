import { parseMessages } from "@/utils/mail";
import type { gmail_v1 } from "@googleapis/gmail";
import { GmailLabel } from "@/utils/gmail/label";
import { isDefined } from "@/utils/types";
import prisma from "@/utils/prisma";
import { getCategory } from "@/utils/redis/category";
import {
  getThreadsBatch,
  getThreadsWithNextPageToken,
} from "@/utils/gmail/thread";
import { decodeSnippet } from "@/utils/gmail/decode";
import type { ThreadsQuery } from "@/app/api/google/threads/validation";
import { ExecutedRuleStatus } from "@prisma/client";
import { SafeError } from "@/utils/error";
import { Client } from "@microsoft/microsoft-graph-client";

export type ThreadsResponse = Awaited<ReturnType<typeof getThreads>>;
export type OutlookThreadsResponse = Awaited<
  ReturnType<typeof getOutlookThreads>
>;

export async function getThreads({
  query,
  gmail,
  accessToken,
  emailAccountId,
}: {
  query: ThreadsQuery;
  gmail: gmail_v1.Gmail;
  accessToken: string;
  emailAccountId: string;
}) {
  if (!accessToken) throw new SafeError("Missing access token");

  function getQuery() {
    if (query.q) {
      return query.q;
    }
    if (query.fromEmail) {
      return `from:${query.fromEmail}`;
    }
    if (query.type === "archive") {
      return `-label:${GmailLabel.INBOX}`;
    }
    return undefined;
  }

  const { threads: gmailThreads, nextPageToken } =
    await getThreadsWithNextPageToken({
      gmail,
      q: getQuery(),
      labelIds: query.labelId ? [query.labelId] : getLabelIds(query.type),
      maxResults: query.limit || 50,
      pageToken: query.nextPageToken || undefined,
    });

  const threadIds = gmailThreads?.map((t) => t.id).filter(isDefined) || [];

  const [threads, plans] = await Promise.all([
    getThreadsBatch(threadIds, accessToken), // may have been faster not using batch method, but doing 50 getMessages in parallel
    prisma.executedRule.findMany({
      where: {
        emailAccountId,
        threadId: { in: threadIds },
        status: {
          // TODO probably want to show applied rules here in the future too
          in: [ExecutedRuleStatus.PENDING, ExecutedRuleStatus.SKIPPED],
        },
      },
      select: {
        id: true,
        messageId: true,
        threadId: true,
        rule: true,
        actionItems: true,
        status: true,
        reason: true,
      },
    }),
  ]);

  const threadsWithMessages = await Promise.all(
    threads.map(async (thread) => {
      const id = thread.id;
      if (!id) return;
      const messages = parseMessages(thread, { withoutIgnoredSenders: true });

      const plan = plans.find((p) => p.threadId === id);

      return {
        id,
        messages,
        snippet: decodeSnippet(thread.snippet),
        plan,
        category: await getCategory({ emailAccountId, threadId: id }),
      };
    }) || [],
  );

  return {
    threads: threadsWithMessages.filter(isDefined),
    nextPageToken,
  };
}

export async function getOutlookThreads({
  query,
  graphClient,
  accessToken,
  emailAccountId,
}: {
  query: {
    q?: string;
    fromEmail?: string;
    type?: string;
    limit?: number;
    nextPageToken?: string;
    folderId?: string;
  };
  graphClient: Client;
  accessToken: string;
  emailAccountId: string;
}) {
  if (!accessToken) throw new SafeError("Missing access token");

  // Build filter string for Microsoft Graph
  function getFilter() {
    const filters: string[] = [];
    if (query.q) {
      filters.push(`contains(subject,'${query.q}')`);
    }
    if (query.fromEmail) {
      filters.push(`from/emailAddress/address eq '${query.fromEmail}'`);
    }
    // Add more filters as needed for type, etc.
    return filters.length ? filters.join(" and ") : undefined;
  }

  // Use /me/conversations to get threads
  let request = graphClient.api("/me/conversations").top(query.limit || 50);

  if (query.nextPageToken) {
    request = request.header("skipToken", query.nextPageToken);
  }
  const filter = getFilter();
  if (filter) {
    request = request.filter(filter);
  }

  const response = await request.get();
  const conversations = response.value || [];
  const nextPageToken = response["@odata.nextLink"] || null;

  const conversationIds = conversations.map((c: any) => c.id);

  const plans = await prisma.executedRule.findMany({
    where: {
      emailAccountId,
      threadId: { in: conversationIds },
      status: {
        in: [ExecutedRuleStatus.PENDING, ExecutedRuleStatus.SKIPPED],
      },
    },
    select: {
      id: true,
      messageId: true,
      threadId: true,
      rule: true,
      actionItems: true,
      status: true,
      reason: true,
    },
  });

  const threadsWithMessages = await Promise.all(
    conversations.map(async (conv: any) => {
      const id = conv.id;
      // Get messages in the conversation
      const messagesRes = await graphClient
        .api(`/me/conversations/${id}/threads`)
        .get();
      const messages = messagesRes.value || [];

      const plan = plans.find((p) => p.threadId === id);

      return {
        id,
        messages,
        snippet: messages[0]?.bodyPreview || "",
        plan,
        category: await getCategory({ emailAccountId, threadId: id }),
      };
    }),
  );

  return {
    threads: threadsWithMessages,
    nextPageToken,
  };
}

function getLabelIds(type?: string | null) {
  switch (type) {
    case "inbox":
      return [GmailLabel.INBOX];
    case "sent":
      return [GmailLabel.SENT];
    case "draft":
      return [GmailLabel.DRAFT];
    case "trash":
      return [GmailLabel.TRASH];
    case "spam":
      return [GmailLabel.SPAM];
    case "starred":
      return [GmailLabel.STARRED];
    case "important":
      return [GmailLabel.IMPORTANT];
    case "unread":
      return [GmailLabel.UNREAD];
    case "archive":
      return undefined;
    case "all":
      return undefined;
    default:
      if (!type || type === "undefined" || type === "null")
        return [GmailLabel.INBOX];
      return [type];
  }
}
