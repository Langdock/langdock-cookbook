import type { Request, Response } from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { sendVirtualAgentMessage } from "../servicenow/client.js";
import { resolveCurrentUser } from "../servicenow/currentUser.js";
import { OttoConversations, type OttoUpdate } from "./conversations.js";

export const OTTO_CALLBACK_PATH = "/servicenow/va/callback";
export const OTTO_CALLBACK_HEADER = "x-otto-callback-secret";
export const OTTO_MAX_WAIT_SECONDS = 25;
export const OTTO_DISABLED_MESSAGE =
  "Otto chat is not configured on this server. Set SERVICENOW_VA_CALLBACK_SECRET and point the ServiceNow Virtual Agent API response endpoint at this server.";

export const ottoConversations = new OttoConversations();

export function isOttoEnabled(): boolean {
  return Boolean(process.env.SERVICENOW_VA_CALLBACK_SECRET);
}

export interface OttoTicketContext {
  number: string;
  table?: string;
  sysId?: string;
  title?: string;
}

export interface OttoSendInput {
  conversationId?: string;
  after?: number;
  text: string;
  /** What the transcript shows instead of `text`, e.g. an option label. */
  label?: string;
  /** False when `text` is the value of an option Otto offered. */
  typed?: boolean;
  action?: "AGENT" | "END_CONVERSATION";
  ticket?: OttoTicketContext;
  timezone?: string;
}

async function ottoCaller(token: string, headers: Record<string, string>) {
  if (!isOttoEnabled()) throw new Error(OTTO_DISABLED_MESSAGE);
  let user;
  try {
    user = await resolveCurrentUser(token, headers);
  } catch (error) {
    throw new Error(
      `Could not identify your ServiceNow user for Otto. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!user.userName) {
    throw new Error("Your ServiceNow user has no user name, which Otto needs.");
  }
  return { user, owner: `user:${user.sysId}` };
}

function ticketKey(ticket: OttoTicketContext | undefined): string | undefined {
  return ticket ? `${ticket.table ?? ""}:${ticket.sysId || ticket.number}` : undefined;
}

/**
 * Send a message as the signed-in user. Otto's user id and email always come
 * from the caller's own token so one user cannot speak as another.
 */
export async function sendToOtto(
  input: OttoSendInput,
  token: string,
  headers: Record<string, string>,
): Promise<OttoUpdate> {
  const { user, owner } = await ottoCaller(token, headers);
  const conversationId =
    input.conversationId ?? ottoConversations.create(owner, user);
  const conversation = ottoConversations.get(conversationId, owner);
  const ending = input.action === "END_CONVERSATION";
  const typed = input.typed !== false;
  const contextKey = ticketKey(input.ticket);
  const introducesTicket =
    Boolean(input.ticket) && typed && !input.action && contextKey !== conversation.contextKey;

  let text = input.text.trim();
  if (introducesTicket && input.ticket) {
    const title = input.ticket.title ? ` ("${input.ticket.title}")` : "";
    text = `I have a question about ${input.ticket.number}${title}. ${text}`;
  }

  if (!ending) {
    ottoConversations.addUserMessage(conversationId, {
      text: input.label?.trim() || input.text.trim(),
      context: introducesTicket ? input.ticket?.number : undefined,
      contextKey: introducesTicket ? contextKey : undefined,
    });
  }

  try {
    const reply = await sendVirtualAgentMessage(
      {
        requestId: randomUUID(),
        clientSessionId: conversationId,
        action: input.action,
        message: {
          text: ending ? "" : text,
          typed,
          clientMessageId: randomUUID(),
        },
        userId: conversation.user.userName,
        emailId: conversation.user.email || undefined,
        timezone: input.timezone,
        contextVariables: input.ticket
          ? {
              ticket_number: input.ticket.number,
              ticket_table: input.ticket.table ?? "",
              ticket_sys_id: input.ticket.sysId ?? "",
            }
          : undefined,
        clientVariables: { conversationId },
      },
      token,
      headers,
      process.env.SERVICENOW_VA_TOKEN,
    );
    if (Array.isArray(reply?.body)) {
      ottoConversations.ingest(reply, conversationId);
    }
  } catch (error) {
    if (ending) throw error;
    ottoConversations.fail(
      conversationId,
      `Otto couldn't receive that message. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (ending) ottoConversations.end(conversationId);
  return ottoConversations.updatesSince(conversationId, owner, input.after ?? 0);
}

/** Long-poll for transcript changes after `after`. */
export async function pollOtto(
  conversationId: string,
  after: number,
  waitSeconds: number,
  token: string,
  headers: Record<string, string>,
): Promise<OttoUpdate> {
  const { owner } = await ottoCaller(token, headers);
  return ottoConversations.waitForUpdates(
    conversationId,
    owner,
    after,
    Math.min(Math.max(waitSeconds, 0), OTTO_MAX_WAIT_SECONDS) * 1000,
  );
}

function secretMatches(provided: string | undefined): boolean {
  const expected = process.env.SERVICENOW_VA_CALLBACK_SECRET;
  if (!expected || !provided) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

/** Response endpoint for the Virtual Agent API. ServiceNow posts Otto's replies here. */
export function handleOttoCallback(req: Request, res: Response): void {
  if (!isOttoEnabled()) {
    res.status(404).end();
    return;
  }
  const authorization = req.get("authorization");
  const provided =
    req.get(OTTO_CALLBACK_HEADER) ??
    (authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined);
  if (!secretMatches(provided)) {
    res.status(401).json({ status: "failure", error: "unauthorized" });
    return;
  }
  if (!ottoConversations.ingest(req.body)) {
    console.warn("Otto callback did not match a conversation", {
      requestId: req.body?.requestId,
    });
  }
  res.json({ status: "success" });
}
