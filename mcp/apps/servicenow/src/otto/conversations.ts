import { randomBytes } from "node:crypto";

import type { CurrentUser } from "../servicenow/client.js";

const IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const SWEEP_MS = 10 * 60 * 1000;
const MAX_MESSAGES = 300;
/** Without any callback for this long, the reply is considered lost. */
export const OTTO_STALL_MS = 90_000;

export type OttoAuthor = "user" | "otto" | "agent" | "system";

export interface OttoLink {
  label: string;
  url: string;
  description?: string;
}

export interface OttoOption {
  label: string;
  value: string;
  description?: string;
  image?: string;
}

export interface OttoCard {
  title?: string;
  subtitle?: string;
  description?: string;
  image?: string;
  url?: string;
  fields?: { label: string; value: string }[];
  table?: string;
  sysId?: string;
}

export interface OttoMessage {
  id: string;
  seq: number;
  from: OttoAuthor;
  kind:
    | "text"
    | "html"
    | "image"
    | "link"
    | "links"
    | "card"
    | "choice"
    | "prompt"
    | "progress"
    | "notice";
  text?: string;
  html?: string;
  url?: string;
  header?: string;
  author?: string;
  context?: string;
  citations?: (OttoLink & { ref?: string })[];
  links?: OttoLink[];
  options?: OttoOption[];
  multiSelect?: boolean;
  input?: "text" | "secret" | "date" | "time" | "datetime";
  steps?: { message: string; status: string }[];
  card?: OttoCard;
  pending?: string;
  streaming?: boolean;
  at: number;
}

export interface OttoUpdate {
  conversationId: string;
  cursor: number;
  waiting: boolean;
  typing: boolean;
  liveAgent: boolean;
  ended: boolean;
  messages: OttoMessage[];
}

interface Conversation {
  id: string;
  owner: string;
  user: CurrentUser;
  messages: OttoMessage[];
  seq: number;
  waiting: boolean;
  typing: boolean;
  liveAgent: boolean;
  ended: boolean;
  contextKey?: string;
  lastCallback: number;
  lastActivity: number;
  streams: Map<string, Map<number, string>>;
  waiters: Set<() => void>;
}

type VaItem = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function httpUrl(value: unknown): string | undefined {
  const url = text(value).trim();
  return /^https?:\/\//i.test(url) ? url : undefined;
}

function record(value: unknown): VaItem | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as VaItem)
    : undefined;
}

function list(value: unknown): VaItem[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is VaItem => Boolean(item))
    : [];
}

function parseJson(value: unknown): VaItem | undefined {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function citationsOf(item: VaItem): (OttoLink & { ref?: string })[] {
  return list(item.citations).flatMap((citation) => {
    const url = httpUrl(citation.citationHref);
    if (!url) return [];
    return [
      {
        label: text(citation.citationLabel) || text(citation.description) || url,
        url,
        ref: text(citation.citationRef) || undefined,
      },
    ];
  });
}

/** Otto repeats its sources as "[1] [label](url)" lines; the UI shows them as chips instead. */
function withoutCitationFooter(value: string): string {
  return value
    .split("\n")
    .filter((line) => !/^\s*\[\d+\]\s*\[[^\]]*\]\([^)]*\)\s*$/.test(line))
    .join("\n")
    .trimEnd();
}

function optionsOf(item: VaItem): OttoOption[] {
  return list(item.options).flatMap((option) => {
    const value = text(option.value) || text(option.label);
    if (!value) return [];
    return [
      {
        label: text(option.label) || value,
        value,
        description: text(option.description) || undefined,
        image: httpUrl(option.attachment),
      },
    ];
  });
}

function cardOf(item: VaItem): OttoCard | undefined {
  const data = parseJson(item.data);
  if (!data) return undefined;
  const fields = list(data.fields)
    .map((field) => ({
      label: text(field.fieldLabel),
      value: text(field.fieldValue),
    }))
    .filter((field) => field.label || field.value);
  return {
    title: text(data.title) || undefined,
    subtitle: text(data.subtitle) || undefined,
    description: text(data.description) || undefined,
    image: httpUrl(data.image),
    url: httpUrl(data.url) ?? httpUrl(data.link),
    fields: fields.length ? fields : undefined,
    table: text(data.table_name) || undefined,
    sysId: text(data.sys_id) || undefined,
  };
}

const INPUT_KINDS: Record<string, OttoMessage["input"]> = {
  InputText: "text",
  Date: "date",
  Time: "time",
  DateTime: "datetime",
};

/**
 * Otto conversations held in memory. Virtual Agent replies arrive on the
 * callback endpoint, get normalized into chat messages, and wake any app
 * frame long-polling for updates.
 */
export class OttoConversations {
  private conversations = new Map<string, Conversation>();
  private latestByUser = new Map<string, string>();

  constructor() {
    setInterval(() => this.sweep(), SWEEP_MS).unref();
  }

  create(owner: string, user: CurrentUser): string {
    const id = randomBytes(16).toString("hex");
    this.conversations.set(id, {
      id,
      owner,
      user,
      messages: [],
      seq: 0,
      waiting: false,
      typing: false,
      liveAgent: false,
      ended: false,
      lastCallback: Date.now(),
      lastActivity: Date.now(),
      streams: new Map(),
      waiters: new Set(),
    });
    this.latestByUser.set(user.userName, id);
    return id;
  }

  /** Conversation details for the owner. Anyone else gets "not found". */
  get(id: string, owner: string) {
    const conversation = this.conversations.get(id);
    if (!conversation || conversation.owner !== owner) {
      throw new Error("Otto conversation not found. Start a new chat.");
    }
    return {
      user: conversation.user,
      ended: conversation.ended,
      contextKey: conversation.contextKey,
    };
  }

  /** Record what the user sent and wait for Otto. */
  addUserMessage(
    id: string,
    message: { text: string; context?: string; contextKey?: string },
    expectReply = true,
  ): void {
    const conversation = this.require(id);
    conversation.ended = false;
    conversation.waiting = expectReply && !conversation.liveAgent;
    conversation.lastCallback = Date.now();
    if (message.contextKey) conversation.contextKey = message.contextKey;
    this.upsert(conversation, this.nextId("user"), {
      from: "user",
      kind: "text",
      text: message.text,
      context: message.context,
    });
    this.notify(conversation);
  }

  end(id: string): void {
    const conversation = this.require(id);
    conversation.ended = true;
    conversation.waiting = false;
    conversation.typing = false;
    conversation.liveAgent = false;
    this.bump(conversation);
    this.notify(conversation);
  }

  fail(id: string, reason: string): void {
    const conversation = this.require(id);
    conversation.waiting = false;
    this.upsert(conversation, this.nextId("notice"), {
      from: "system",
      kind: "notice",
      text: reason,
    });
    this.notify(conversation);
  }

  /**
   * Apply a Virtual Agent response body. Returns false when it belongs to no
   * known conversation.
   */
  ingest(payload: unknown, conversationId?: string): boolean {
    const body = record(payload);
    if (!body) return false;
    const conversation = this.route(body, conversationId);
    if (!conversation) return false;

    conversation.lastCallback = Date.now();
    let answered = false;
    for (const item of list(body.body)) {
      answered = this.apply(conversation, item) || answered;
    }
    if (body.agentChat === true) conversation.liveAgent = true;
    if (body.completed === true || body.takeControl === true) {
      conversation.ended = true;
      conversation.liveAgent = false;
      conversation.typing = false;
      answered = true;
    }
    if (answered && body.streamActive !== true) {
      conversation.waiting = false;
      conversation.typing = false;
    }
    this.bump(conversation);
    this.notify(conversation);
    return true;
  }

  updatesSince(id: string, owner: string, after: number): OttoUpdate {
    const conversation = this.require(id, owner);
    this.checkStalled(conversation);
    return this.snapshot(conversation, after);
  }

  /** Resolve as soon as anything changes after `after`, or when `waitMs` ends. */
  waitForUpdates(
    id: string,
    owner: string,
    after: number,
    waitMs: number,
  ): Promise<OttoUpdate> {
    const conversation = this.require(id, owner);
    this.checkStalled(conversation);
    if (conversation.seq > after || waitMs <= 0) {
      return Promise.resolve(this.snapshot(conversation, after));
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        conversation.waiters.delete(done);
        this.checkStalled(conversation);
        resolve(this.snapshot(conversation, after));
      };
      const timer = setTimeout(done, waitMs);
      conversation.waiters.add(done);
    });
  }

  private snapshot(conversation: Conversation, after: number): OttoUpdate {
    return {
      conversationId: conversation.id,
      cursor: conversation.seq,
      waiting: conversation.waiting,
      typing: conversation.typing,
      liveAgent: conversation.liveAgent,
      ended: conversation.ended,
      messages: conversation.messages.filter((message) => message.seq > after),
    };
  }

  private require(id: string, owner?: string): Conversation {
    const conversation = this.conversations.get(id);
    if (!conversation || (owner !== undefined && conversation.owner !== owner)) {
      throw new Error("Otto conversation not found. Start a new chat.");
    }
    conversation.lastActivity = Date.now();
    return conversation;
  }

  private route(body: VaItem, conversationId?: string): Conversation | undefined {
    const userId = text(body.userId);
    const candidates = [
      conversationId,
      text(record(body.clientVariables)?.conversationId),
      text(body.clientSessionId),
      userId ? this.latestByUser.get(userId) : undefined,
    ];
    for (const candidate of candidates) {
      const conversation = candidate
        ? this.conversations.get(candidate)
        : undefined;
      if (conversation && (!userId || conversation.user.userName === userId)) {
        conversation.lastActivity = Date.now();
        return conversation;
      }
    }
    return undefined;
  }

  /** Map one response body item onto the transcript. Returns true for a user-facing reply. */
  private apply(conversation: Conversation, item: VaItem): boolean {
    const agentInfo = record(item.agentInfo);
    const fromAgent = agentInfo?.sentFromAgent === true;
    const base = {
      from: (fromAgent ? "agent" : "otto") as OttoAuthor,
      author: fromAgent ? text(agentInfo?.agentName) || "Live agent" : undefined,
    };
    const id = text(item.messageId) || this.nextId("otto");
    const streamId = text(item.streamId);
    const label = text(item.label) || text(item.promptMsg);

    switch (text(item.uiType)) {
      case "StreamStart": {
        conversation.streams.set(streamId, new Map());
        this.upsert(conversation, `stream:${streamId}`, {
          ...base,
          kind: "text",
          text: "",
          streaming: true,
          pending: text(item.value) || undefined,
        });
        return false;
      }
      case "StreamChunk": {
        const chunks = conversation.streams.get(streamId) ?? new Map();
        conversation.streams.set(streamId, chunks);
        chunks.set(Number(item.streamSequence) || chunks.size + 2, text(item.value));
        const joined = [...chunks.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, chunk]) => chunk)
          .join("");
        this.upsert(conversation, `stream:${streamId}`, {
          ...base,
          kind: "text",
          text: joined,
          streaming: true,
          pending: undefined,
        });
        return false;
      }
      case "OutputText": {
        const citations = citationsOf(item);
        const value = text(item.value);
        if (streamId) conversation.streams.delete(streamId);
        this.upsert(conversation, streamId ? `stream:${streamId}` : id, {
          ...base,
          kind: "text",
          text: citations.length ? withoutCitationFooter(value) : value,
          citations: citations.length ? citations : undefined,
          streaming: false,
          pending: undefined,
        });
        return true;
      }
      case "OutputHtml": {
        const links = list(item.links).flatMap((link) => {
          const url = httpUrl(link.link);
          return url ? [{ label: text(link.label) || url, url }] : [];
        });
        this.upsert(conversation, id, {
          ...base,
          kind: "html",
          html: text(item.value),
          links: links.length ? links : undefined,
        });
        return true;
      }
      case "OutputImage": {
        const url = httpUrl(item.value);
        if (!url) return false;
        this.upsert(conversation, id, {
          ...base,
          kind: "image",
          url,
          text: text(item.altText) || undefined,
        });
        return true;
      }
      case "OutputLink": {
        const url = httpUrl(record(item.value)?.action);
        if (!url) return false;
        this.upsert(conversation, id, {
          ...base,
          kind: "link",
          url,
          text: label || url,
          header: text(item.header) || undefined,
        });
        return true;
      }
      case "GroupedPartsOutputControl": {
        const links = list(item.values).flatMap((value) => {
          const url = httpUrl(value.action);
          return url
            ? [
                {
                  label: text(value.label) || url,
                  url,
                  description: text(value.description) || undefined,
                },
              ]
            : [];
        });
        this.upsert(conversation, id, {
          ...base,
          kind: "links",
          header: text(item.header) || undefined,
          links,
        });
        return true;
      }
      case "OutputCard": {
        const card = cardOf(item);
        if (!card) return false;
        this.upsert(conversation, id, { ...base, kind: "card", card });
        return true;
      }
      case "MultiPartOutput": {
        const content = record(item.content);
        if (content) this.apply(conversation, { ...content, agentInfo });
        this.upsert(conversation, this.nextId("more"), {
          ...base,
          kind: "choice",
          options: [
            {
              label: text(item.navigationBtnLabel) || "Show more",
              value: "click_for_more",
            },
          ],
        });
        return true;
      }
      case "Picker":
      case "Boolean":
      case "TopicPickerControl": {
        this.upsert(conversation, id, {
          ...base,
          kind: "choice",
          text: label || undefined,
          options: optionsOf(item),
          multiSelect: item.multiSelect === true,
        });
        return true;
      }
      case "InputText":
      case "Date":
      case "Time":
      case "DateTime": {
        this.upsert(conversation, id, {
          ...base,
          kind: "prompt",
          text: label || "Otto needs more information.",
          input:
            item.maskType === "SECURE" ? "secret" : INPUT_KINDS[text(item.uiType)],
        });
        return true;
      }
      case "FileUpload": {
        this.upsert(conversation, id, {
          ...base,
          kind: "notice",
          text: `${label || "Otto asked for a file."} File uploads aren't supported in this chat, so attach it in ServiceNow instead.`,
        });
        return true;
      }
      case "ActionMsg":
        return this.applyAction(conversation, item, base);
      default: {
        const fallback = label || text(item.value);
        if (!fallback) return false;
        this.upsert(conversation, id, { ...base, kind: "text", text: fallback });
        return true;
      }
    }
  }

  private applyAction(
    conversation: Conversation,
    item: VaItem,
    base: Pick<OttoMessage, "from" | "author">,
  ): boolean {
    switch (text(item.actionType)) {
      case "DynamicLoader": {
        const key = text(item.parentMessageId) || text(item.messageId);
        this.upsert(conversation, `steps:${key || this.nextId("steps")}`, {
          ...base,
          kind: "progress",
          header: text(item.header) || text(item.defaultHeader) || "AI steps",
          steps: list(item.progressMessages).map((step) => ({
            message: text(step.message),
            status: text(step.status) || "IN_PROGRESS",
          })),
        });
        return false;
      }
      case "StartSpinner":
        this.upsert(conversation, this.nextId("notice"), {
          from: "system",
          kind: "notice",
          text: text(item.message) || "Connecting you to a live agent…",
        });
        conversation.typing = true;
        return false;
      case "StartTypingIndicator":
        conversation.typing = true;
        return false;
      case "EndTypingIndicator":
        conversation.typing = false;
        return false;
      default:
        return false;
    }
  }

  private upsert(
    conversation: Conversation,
    id: string,
    patch: Omit<OttoMessage, "id" | "seq" | "at">,
  ): void {
    const seq = this.bump(conversation);
    const existing = conversation.messages.find((message) => message.id === id);
    if (existing) {
      Object.assign(existing, patch, { seq });
      return;
    }
    conversation.messages.push({ ...patch, id, seq, at: Date.now() });
    if (conversation.messages.length > MAX_MESSAGES) {
      conversation.messages.splice(0, conversation.messages.length - MAX_MESSAGES);
    }
  }

  private bump(conversation: Conversation): number {
    conversation.lastActivity = Date.now();
    return ++conversation.seq;
  }

  private notify(conversation: Conversation): void {
    for (const waiter of [...conversation.waiters]) waiter();
  }

  private checkStalled(conversation: Conversation): void {
    if (
      !conversation.waiting ||
      Date.now() - conversation.lastCallback < OTTO_STALL_MS
    ) {
      return;
    }
    this.fail(
      conversation.id,
      "Otto hasn't answered. Try again, and if this keeps happening ask your ServiceNow admin to check the Virtual Agent API response endpoint.",
    );
  }

  private nextId(prefix: string): string {
    return `${prefix}:${randomBytes(6).toString("hex")}`;
  }

  private sweep(): void {
    const cutoff = Date.now() - IDLE_TTL_MS;
    for (const [id, conversation] of this.conversations) {
      if (conversation.lastActivity >= cutoff || conversation.waiters.size) {
        continue;
      }
      this.conversations.delete(id);
      if (this.latestByUser.get(conversation.user.userName) === id) {
        this.latestByUser.delete(conversation.user.userName);
      }
    }
  }
}
