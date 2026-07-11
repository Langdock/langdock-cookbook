import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTicketQuery,
  deleteAttachment,
  discoverTickets,
  getRecord,
  matchesChoiceFilters,
  updateRecord,
  type TicketSummary,
} from "../src/servicenow/client.js";

function ticket(
  stateValue: string,
  state: string,
): TicketSummary {
  return {
    table: "incident",
    tableLabel: "Incident",
    sysId: "0123456789abcdef0123456789abcdef",
    recordUrl: "https://example.service-now.com/",
    number: "INC0000001",
    shortDescription: "Example",
    state,
    stateValue,
    priority: "",
    priorityValue: "",
    impact: "",
    impactValue: "",
    urgency: "",
    urgencyValue: "",
    severity: "",
    severityValue: "",
    category: "",
    caller: "",
    assignedTo: "",
    assignmentGroup: "",
    configurationItem: "",
    openedBy: "",
    openedAt: "",
    closedAt: "",
    createdAt: "",
    updatedAt: "",
    active: "",
    activeValue: "",
  };
}

test("choice verification uses the per-record display label", () => {
  const requested = { state: ["Closed"] };

  assert.equal(matchesChoiceFilters(ticket("3", "On Hold"), requested), false);
  assert.equal(matchesChoiceFilters(ticket("3", "Closed"), requested), true);
});

test("choice verification also accepts stored values", () => {
  assert.equal(
    matchesChoiceFilters(ticket("7", "Closed"), { state: ["7"] }),
    true,
  );
});

test("discovery verifies identical cross-table state values by display label", async () => {
  const previousInstance = process.env.SERVICENOW_INSTANCE;
  const previousFetch = globalThis.fetch;
  process.env.SERVICENOW_INSTANCE = "dev12345";
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        result: [
          {
            sys_id: { value: "0123456789abcdef0123456789abcdef", display_value: "0123456789abcdef0123456789abcdef" },
            sys_class_name: { value: "incident", display_value: "Incident" },
            number: { value: "INC0000001", display_value: "INC0000001" },
            state: { value: "3", display_value: "On Hold" },
          },
          {
            sys_id: { value: "fedcba9876543210fedcba9876543210", display_value: "fedcba9876543210fedcba9876543210" },
            sys_class_name: { value: "change_request", display_value: "Change Request" },
            number: { value: "CHG0000001", display_value: "CHG0000001" },
            state: { value: "3", display_value: "Closed" },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  try {
    const result = await discoverTickets({ state: "Closed" }, "token");
    assert.deepEqual(
      result.tickets.map(({ number }) => number),
      ["CHG0000001"],
    );
    assert.equal(result.query.includes("state="), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousInstance == null) {
      delete process.env.SERVICENOW_INSTANCE;
    } else {
      process.env.SERVICENOW_INSTANCE = previousInstance;
    }
  }
});

test("encoded-query filters reject separators and JavaScript expressions", () => {
  assert.throws(
    () => buildTicketQuery({ shortDescription: "safe^NQactive=true" }),
    /cannot contain \^/,
  );
  assert.throws(
    () => buildTicketQuery({ assignedTo: "javascript:gs.getUserID()" }),
    /JavaScript expressions/,
  );
});

test("table paths and write sys_ids are validated before requests", async () => {
  const previousInstance = process.env.SERVICENOW_INSTANCE;
  process.env.SERVICENOW_INSTANCE = "dev12345";
  try {
    await assert.rejects(
      getRecord("../../now/attachment", "INC0000001", "token"),
      /Invalid ServiceNow table name/,
    );
    await assert.rejects(
      updateRecord("incident", "not-a-sys-id", {}, "token"),
      /32-character ServiceNow sys_id/,
    );
  } finally {
    if (previousInstance == null) {
      delete process.env.SERVICENOW_INSTANCE;
    } else {
      process.env.SERVICENOW_INSTANCE = previousInstance;
    }
  }
});

test("attachment deletion verifies ownership through the visible ticket list", async () => {
  const previousInstance = process.env.SERVICENOW_INSTANCE;
  const previousFetch = globalThis.fetch;
  const ticketSysId = "0123456789abcdef0123456789abcdef";
  const attachmentSysId = "fedcba9876543210fedcba9876543210";
  const calls: Array<{ url: string; method: string }> = [];
  process.env.SERVICENOW_INSTANCE = "dev12345";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    calls.push({ url, method });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response(
      JSON.stringify({
        result: [
          {
            sys_id: attachmentSysId,
            file_name: "example.txt",
            content_type: "text/plain",
            size_bytes: "7",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    await deleteAttachment(
      "incident",
      ticketSysId,
      attachmentSysId,
      "token",
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, "DELETE");
    assert.match(calls[1].url, new RegExp(attachmentSysId));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousInstance == null) {
      delete process.env.SERVICENOW_INSTANCE;
    } else {
      process.env.SERVICENOW_INSTANCE = previousInstance;
    }
  }
});
