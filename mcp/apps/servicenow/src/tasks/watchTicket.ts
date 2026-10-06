import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { setTimeout as sleep } from "node:timers/promises";

import {
  getActivity,
  getRecord,
  getRecordWithTaskFallback,
  type ActivityEntry,
  type TicketRecord,
} from "../servicenow/client.js";
import { getInstanceUrl } from "../utils/getInstanceUrl.js";
import type { TaskRegistry } from "./taskRegistry.js";

export const WATCH_CONDITIONS = [
  "any_update",
  "state_change",
  "new_activity",
  "resolved_or_closed",
] as const;
export type WatchCondition = (typeof WATCH_CONDITIONS)[number];

export const DEFAULT_WATCH_MINUTES = 10;
/** ServiceNow access tokens default to a 30-minute lifespan. */
export const MAX_WATCH_MINUTES = 30;
/** MCP clients commonly time out a request after 60 seconds. */
export const INLINE_WATCH_MS = 40_000;
export const WATCH_POLL_MS =
  (Number(process.env.SERVICENOW_WATCH_POLL_SECONDS) || 10) * 1000;

const MAX_CONSECUTIVE_FAILURES = 3;

const WATCH_FIELDS = [
  "sys_id",
  "number",
  "short_description",
  "state",
  "active",
  "priority",
  "assigned_to",
  "assignment_group",
  "sys_updated_on",
  "sys_updated_by",
  "sys_mod_count",
];

const TRACKED_FIELDS: ReadonlyArray<[field: string, label: string]> = [
  ["state", "State"],
  ["priority", "Priority"],
  ["assigned_to", "Assigned to"],
  ["assignment_group", "Assignment group"],
  ["short_description", "Short description"],
];

export interface WatchTarget {
  /** Concrete task class, used for journal entries and the record link. */
  table: string;
  /** Table the user can read the record through (may be the parent `task`). */
  recordTable: string;
  sysId: string;
  number: string;
  recordUrl: string;
  initial: TicketRecord;
  initialActivity: ActivityEntry[];
}

export interface WatchSettings {
  until: WatchCondition;
  targetStates?: string[];
  deadline: number;
  pollMs: number;
  /** Appended to the result when the watch window ends without a match. */
  windowNote?: string;
}

interface WatchEvent {
  at: string;
  text: string;
}

export async function loadWatchTarget(
  table: string | undefined,
  id: string,
  token: string,
  headers: Record<string, string>,
): Promise<WatchTarget> {
  let concreteTable = table;
  let lookupId = id;
  if (!concreteTable) {
    const base = await getRecord("task", id, token, headers, [
      "sys_id",
      "sys_class_name",
    ]);
    concreteTable = base.values.sys_class_name?.value || "task";
    lookupId = base.sysId;
  }
  const { record, recordTable } = await getRecordWithTaskFallback(
    concreteTable,
    lookupId,
    token,
    headers,
    WATCH_FIELDS,
  );
  const initialActivity = await getActivity(
    concreteTable,
    record.sysId,
    token,
    headers,
  );
  return {
    table: concreteTable,
    recordTable,
    sysId: record.sysId,
    number: record.number || record.sysId,
    recordUrl: `${getInstanceUrl()}/nav_to.do?uri=${encodeURIComponent(
      `${concreteTable}.do?sys_id=${record.sysId}`,
    )}`,
    initial: record,
    initialActivity,
  };
}

export function describeWatchStart(
  target: WatchTarget,
  settings: WatchSettings,
): string {
  const seconds = Math.round(settings.pollMs / 1000);
  return [
    `Watching ${target.number} ${describeCondition(settings)}.`,
    `State: ${display(target.initial, "state")}.`,
    `Checking every ${seconds} second${seconds === 1 ? "" : "s"} until ${clockTime(settings.deadline)}.`,
  ].join(" ");
}

/**
 * Poll a ticket until the stop condition matches or the window ends. Each
 * intermediate change becomes the task's status message; the final result
 * summarizes every change observed while watching.
 */
export async function runTicketWatch(
  registry: TaskRegistry,
  taskId: string,
  target: WatchTarget,
  settings: WatchSettings,
): Promise<void> {
  const signal = registry.signal(taskId);
  const seenActivity = new Set(target.initialActivity.map(activityKey));
  const events: WatchEvent[] = [];
  let previous = target.initial;
  let failures = 0;

  const fail = (message: string): void =>
    registry.finish(
      taskId,
      "failed",
      {
        content: [
          {
            type: "text",
            text: `Stopped watching ${target.number}: ${message}`,
          },
        ],
        isError: true,
      },
      message,
    );
  const complete = (summary: string, current: TicketRecord): void =>
    registry.finish(
      taskId,
      "completed",
      buildResult(target, summary, events, current),
      summary,
    );

  try {
    const alreadyMatched = endStateReason(settings, target.initial);
    if (alreadyMatched) {
      complete(
        `The ticket already matched when the watch started: ${alreadyMatched}.`,
        target.initial,
      );
      return;
    }

    while (Date.now() < settings.deadline) {
      try {
        await sleep(
          Math.min(settings.pollMs, settings.deadline - Date.now()),
          undefined,
          { signal },
        );
      } catch {
        return;
      }
      const credentials = registry.credentials(taskId);
      if (!credentials) return;

      let current: TicketRecord;
      let newEntries: ActivityEntry[] = [];
      try {
        current = await getRecord(
          target.recordTable,
          target.sysId,
          credentials.token,
          credentials.headers,
          WATCH_FIELDS,
        );
        if (version(current) !== version(previous)) {
          const activity = await getActivity(
            target.table,
            target.sysId,
            credentials.token,
            credentials.headers,
          );
          newEntries = activity.filter(
            (entry) => !seenActivity.has(activityKey(entry)),
          );
          newEntries.forEach((entry) => seenActivity.add(activityKey(entry)));
        }
        failures = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = /ServiceNow API error \((\d{3})\)/.exec(message)?.[1];
        if (status === "401") {
          fail(
            "the ServiceNow session expired. Reconnect ServiceNow, then start a new watch.",
          );
          return;
        }
        if (status === "403" || status === "404") {
          fail(`the ticket is no longer accessible (HTTP ${status}).`);
          return;
        }
        if (++failures >= MAX_CONSECUTIVE_FAILURES) {
          fail(`ServiceNow kept failing: ${message}`);
          return;
        }
        continue;
      }

      if (version(current) === version(previous) && !newEntries.length) {
        continue;
      }

      const updatedAt = current.values.sys_updated_on?.display ?? "";
      const updatedBy = current.values.sys_updated_by?.value;
      const fieldChanges = TRACKED_FIELDS.filter(
        ([field]) => current.values[field]?.value !== previous.values[field]?.value,
      ).map(
        ([field, label]) =>
          `${label}: ${display(previous, field)} → ${display(current, field)}`,
      );
      if (fieldChanges.length) {
        events.push({
          at: updatedAt,
          text: `${fieldChanges.join("; ")}${updatedBy ? ` (by ${updatedBy})` : ""}`,
        });
      }
      for (const entry of newEntries) {
        events.push({
          at: entry.createdOn,
          text: `${entry.field === "work_notes" ? "Work note" : "Comment"} by ${entry.createdBy}: "${truncate(entry.value)}"`,
        });
      }
      if (!fieldChanges.length && !newEntries.length) {
        events.push({
          at: updatedAt,
          text: `Other fields updated${updatedBy ? ` by ${updatedBy}` : ""}`,
        });
      }

      const reason = changeReason(settings, previous, current, newEntries);
      previous = current;
      if (reason) {
        complete(`The watch ended because ${reason}.`, current);
        return;
      }
      registry.report(
        taskId,
        [
          `Watching ${target.number} ${describeCondition(settings)}.`,
          `State: ${display(current, "state")}.`,
          `${events.length} update${events.length === 1 ? "" : "s"} so far; latest: ${events[events.length - 1].text}.`,
          `Watch ends at ${clockTime(settings.deadline)}.`,
        ].join(" "),
      );
    }

    complete(
      [
        `Nothing matched (${describeCondition(settings)}) before the watch window ended.`,
        settings.windowNote,
      ]
        .filter(Boolean)
        .join(" "),
      previous,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function describeCondition(settings: WatchSettings): string {
  if (settings.targetStates?.length) {
    return `until its state is ${settings.targetStates.join(" or ")}`;
  }
  switch (settings.until) {
    case "state_change":
      return "until its state changes";
    case "new_activity":
      return "until a new comment or work note is added";
    case "resolved_or_closed":
      return "until it is resolved or closed";
    default:
      return "until it is updated";
  }
}

function endStateReason(
  settings: WatchSettings,
  record: TicketRecord,
): string | undefined {
  const state = record.values.state;
  if (settings.targetStates?.length) {
    const wanted = settings.targetStates.map((value) =>
      value.trim().toLowerCase(),
    );
    const matches =
      state != null &&
      (wanted.includes(state.value.toLowerCase()) ||
        wanted.includes(state.display.toLowerCase()));
    return matches ? `its state is ${display(record, "state")}` : undefined;
  }
  if (settings.until === "resolved_or_closed") {
    const closed =
      record.values.active?.value === "false" ||
      /resolved|closed|cancel/i.test(state?.display ?? "");
    return closed ? `it is ${display(record, "state")}` : undefined;
  }
  return undefined;
}

function changeReason(
  settings: WatchSettings,
  previous: TicketRecord,
  current: TicketRecord,
  newEntries: ActivityEntry[],
): string | undefined {
  if (settings.targetStates?.length || settings.until === "resolved_or_closed") {
    return endStateReason(settings, current);
  }
  switch (settings.until) {
    case "state_change":
      return current.values.state?.value !== previous.values.state?.value
        ? `its state changed from ${display(previous, "state")} to ${display(current, "state")}`
        : undefined;
    case "new_activity":
      if (!newEntries.length) return undefined;
      return newEntries.length === 1
        ? `a new ${newEntries[0].field === "work_notes" ? "work note" : "comment"} was added`
        : `${newEntries.length} new comments or work notes were added`;
    default:
      return "it was updated";
  }
}

function buildResult(
  target: WatchTarget,
  summary: string,
  events: WatchEvent[],
  current: TicketRecord,
): CallToolResult {
  const title = [target.number, current.values.short_description?.display]
    .filter(Boolean)
    .join(" — ")
    .replace(/[\\[\]]/g, "\\$&");
  const currentValues = TRACKED_FIELDS.filter(
    ([field]) => field !== "short_description",
  )
    .map(([field, label]) => `${label}: ${display(current, field)}`)
    .join("; ");
  const text = [
    `[${title}](${target.recordUrl})`,
    summary,
    events.length
      ? `Changes observed while watching:\n${events.map((event) => `- ${event.at} — ${event.text}`).join("\n")}`
      : "No changes were observed while watching.",
    `Current values — ${currentValues}.`,
  ].join("\n\n");
  return { content: [{ type: "text", text }] };
}

/** Adding a comment or work note also bumps the parent record's mod count. */
function version(record: TicketRecord): string {
  return (
    record.values.sys_mod_count?.value ||
    record.values.sys_updated_on?.value ||
    ""
  );
}

function activityKey(entry: ActivityEntry): string {
  return [entry.field, entry.createdOn, entry.createdBy, entry.value].join("|");
}

function display(record: TicketRecord, field: string): string {
  const value = record.values[field];
  return value?.display || value?.value || "(empty)";
}

function truncate(text: string, max = 300): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function clockTime(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(11, 16)} UTC`;
}
