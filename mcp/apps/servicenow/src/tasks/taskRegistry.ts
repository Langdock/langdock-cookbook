import {
  isTerminal,
  type CreateTaskOptions,
  type TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import type { Result, Task } from "@modelcontextprotocol/sdk/types.js";
import { randomBytes } from "node:crypto";

const LIST_PAGE_SIZE = 20;

export interface TaskCredentials {
  token: string;
  headers: Record<string, string>;
}

export interface TaskRequestContext {
  /** Stable identity of the caller; tasks are only visible to their owner. */
  resolveOwner: () => Promise<string>;
  credentials: TaskCredentials;
}

interface TaskRecord {
  owner: string;
  task: Task;
  credentials: TaskCredentials;
  result?: Result;
  abort: AbortController;
  cleanupTimer?: NodeJS.Timeout;
}

/**
 * Task state shared by every per-request McpServer.
 *
 * The SDK's InMemoryTaskStore ignores session IDs and lists every task, and
 * this server runs without MCP sessions. Each request therefore gets a
 * TaskStore view bound to its ServiceNow user, while background work reads
 * and updates tasks directly through the registry.
 *
 * In-memory only: tasks are lost on restart and are not shared across
 * replicas. Back this with Redis or a database for production.
 */
export class TaskRegistry {
  private readonly records = new Map<string, TaskRecord>();

  forRequest(context: TaskRequestContext): TaskStore {
    const owned = async (taskId: string): Promise<TaskRecord> => {
      const record = this.records.get(taskId);
      if (!record || record.owner !== (await context.resolveOwner())) {
        throw new Error(`Task ${taskId} not found`);
      }
      // Background work keeps running on the newest token the owner presents,
      // so a client-side token refresh does not break a long-running task.
      record.credentials = context.credentials;
      return record;
    };

    return {
      createTask: async (params: CreateTaskOptions) =>
        this.create(
          await context.resolveOwner(),
          context.credentials,
          params,
        ),
      getTask: async (taskId) => {
        const record = await owned(taskId).catch(() => undefined);
        return record ? { ...record.task } : null;
      },
      storeTaskResult: async (taskId, status, result) => {
        await owned(taskId);
        this.finish(taskId, status, result);
      },
      getTaskResult: async (taskId) => {
        const record = await owned(taskId);
        if (!record.result) {
          throw new Error(`Task ${taskId} has no result yet`);
        }
        return record.result;
      },
      updateTaskStatus: async (taskId, status, statusMessage) => {
        await owned(taskId);
        this.setStatus(taskId, status, statusMessage);
      },
      listTasks: async (cursor) => {
        const owner = await context.resolveOwner();
        const tasks = [...this.records.values()]
          .filter((record) => record.owner === owner)
          .map((record) => ({ ...record.task }));
        const start = cursor
          ? tasks.findIndex((task) => task.taskId === cursor) + 1
          : 0;
        if (cursor && start === 0) {
          throw new Error(`Invalid cursor: ${cursor}`);
        }
        const page = tasks.slice(start, start + LIST_PAGE_SIZE);
        return {
          tasks: page,
          nextCursor:
            start + LIST_PAGE_SIZE < tasks.length
              ? page[page.length - 1]?.taskId
              : undefined,
        };
      },
    };
  }

  /** Latest credentials for a task, or undefined once the task is gone. */
  credentials(taskId: string): TaskCredentials | undefined {
    return this.records.get(taskId)?.credentials;
  }

  /** Aborts when the task reaches a terminal state, including cancellation. */
  signal(taskId: string): AbortSignal {
    return this.records.get(taskId)?.abort.signal ?? AbortSignal.abort();
  }

  /** Publish a progress update while the task keeps working. */
  report(taskId: string, statusMessage: string): void {
    const record = this.records.get(taskId);
    if (!record || isTerminal(record.task.status)) return;
    record.task.statusMessage = statusMessage;
    record.task.lastUpdatedAt = new Date().toISOString();
  }

  /** Store the final result. Ignored if the task was cancelled meanwhile. */
  finish(
    taskId: string,
    status: "completed" | "failed",
    result: Result,
    statusMessage?: string,
  ): void {
    const record = this.records.get(taskId);
    if (!record || isTerminal(record.task.status)) return;
    record.result = result;
    this.setStatus(taskId, status, statusMessage);
  }

  private create(
    owner: string,
    credentials: TaskCredentials,
    params: CreateTaskOptions,
  ): Task {
    const now = new Date().toISOString();
    const task: Task = {
      taskId: randomBytes(16).toString("hex"),
      status: "working",
      ttl: params.ttl ?? null,
      createdAt: now,
      lastUpdatedAt: now,
      pollInterval: params.pollInterval ?? 5000,
    };
    const record: TaskRecord = {
      owner,
      task,
      credentials,
      abort: new AbortController(),
    };
    this.records.set(task.taskId, record);
    this.scheduleCleanup(record);
    return { ...task };
  }

  private setStatus(
    taskId: string,
    status: Task["status"],
    statusMessage?: string,
  ): void {
    const record = this.records.get(taskId);
    if (!record) return;
    if (isTerminal(record.task.status)) {
      throw new Error(
        `Task ${taskId} is already ${record.task.status} and cannot change state`,
      );
    }
    record.task.status = status;
    if (statusMessage) record.task.statusMessage = statusMessage;
    record.task.lastUpdatedAt = new Date().toISOString();
    if (isTerminal(status)) {
      record.abort.abort();
      this.scheduleCleanup(record);
    }
  }

  /** TTL runs from creation and restarts when the task finishes. */
  private scheduleCleanup(record: TaskRecord): void {
    if (!record.task.ttl) return;
    clearTimeout(record.cleanupTimer);
    record.cleanupTimer = setTimeout(() => {
      record.abort.abort();
      this.records.delete(record.task.taskId);
    }, record.task.ttl);
    record.cleanupTimer.unref();
  }
}
