import { getInstanceUrl } from "../utils/getInstanceUrl.js";

export async function submitForm(
  table: string,
  data: Record<string, unknown>,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const instanceUrl = getInstanceUrl();
  const url = `${instanceUrl}/api/now/table/${table}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...extraHeaders,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ServiceNow API error (${response.status}): ${errorText}`);
  }

  const result = await response.json();
  return result.result;
}

export interface FormField {
  name: string;
  label: string;
  type: string;
  inputType:
    | "text"
    | "textarea"
    | "select"
    | "number"
    | "boolean"
    | "date"
    | "datetime"
    | "reference";
  required: boolean;
  readOnly: boolean;
  maxLength?: number;
  defaultValue?: string;
  choices?: Array<{ value: string; label: string }>;
  referenceTable?: string;
  hint?: string;
}

export interface FormSchema {
  table: string;
  fields: FormField[];
  /** Full table hierarchy (table + parent tables), child first. */
  hierarchy?: string[];
  /** True when the table extends `task` — enables ticket-aware UI. */
  isTaskTable?: boolean;
}

/** A single ServiceNow record, with both raw values and display labels. */
export interface TicketRecord {
  table: string;
  sysId: string;
  number?: string;
  displayValue?: string;
  /** Field name -> { value, display }. Uses `sysparm_display_value=all`. */
  values: Record<string, { value: string; display: string }>;
}

export interface DateRangeFilter {
  after?: string;
  before?: string;
}

export interface TicketFilters {
  number?: string;
  shortDescription?: string;
  state?: string | string[];
  priority?: string | string[];
  impact?: string | string[];
  urgency?: string | string[];
  severity?: string | string[];
  category?: string | string[];
  relatedUser?: string | string[];
  caller?: string | string[];
  assignedTo?: string | string[];
  assignedToMe?: boolean;
  assignmentGroup?: string | string[];
  configurationItem?: string | string[];
  openedBy?: string | string[];
  active?: boolean;
  openedAt?: DateRangeFilter;
  closedAt?: DateRangeFilter;
  createdAt?: DateRangeFilter;
  updatedAt?: DateRangeFilter;
  additionalFilters?: Record<string, string | string[]>;
}

export interface TicketSummary {
  table: string;
  tableLabel: string;
  sysId: string;
  recordUrl: string;
  number: string;
  shortDescription: string;
  state: string;
  stateValue: string;
  priority: string;
  priorityValue: string;
  impact: string;
  impactValue: string;
  urgency: string;
  urgencyValue: string;
  severity: string;
  severityValue: string;
  category: string;
  caller: string;
  assignedTo: string;
  assignmentGroup: string;
  configurationItem: string;
  openedBy: string;
  openedAt: string;
  closedAt: string;
  createdAt: string;
  updatedAt: string;
  active: string;
  activeValue: string;
}

export type TicketSortField =
  | "priority"
  | "severity"
  | "impact"
  | "urgency"
  | "state"
  | "opened_at"
  | "updated_at"
  | "created_at";

/** One comment or work-note entry from the record's activity stream. */
export interface ActivityEntry {
  field: "comments" | "work_notes";
  value: string;
  createdOn: string;
  createdBy: string;
}

export interface TicketAttachment {
  sysId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdOn: string;
  createdBy: string;
}

function classifyInputType(internalType: string): FormField["inputType"] {
  const t = (internalType || "").toLowerCase();
  if (t === "boolean") return "boolean";
  if (t === "choice" || t === "int_choice" || t === "string_choice")
    return "select";
  if (t === "reference" || t === "glide_list") return "reference";
  if (t === "glide_date") return "date";
  if (t === "glide_date_time") return "datetime";
  if (t === "integer" || t === "float" || t === "decimal") return "number";
  if (t === "journal" || t === "journal_input" || t === "html")
    return "textarea";
  return "text";
}

/**
 * Get the table hierarchy (table + all parent tables) for inherited fields.
 * ServiceNow tables can extend other tables, inheriting their fields.
 */
async function getTableHierarchy(
  table: string,
  headers: Record<string, string>,
  instanceUrl: string,
): Promise<string[]> {
  const tables: string[] = [table];

  try {
    // Query sys_db_object to get table hierarchy
    let currentTable = table;
    const maxDepth = 10; // Prevent infinite loops

    for (let i = 0; i < maxDepth; i++) {
      const url = `${instanceUrl}/api/now/table/sys_db_object`;
      const params = new URLSearchParams({
        sysparm_query: `name=${currentTable}`,
        sysparm_fields: "super_class",
        sysparm_limit: "1",
      });

      const response = await fetch(`${url}?${params}`, {
        method: "GET",
        headers,
      });
      if (!response.ok) break;

      const data = await response.json();
      const record = data.result?.[0];

      // super_class is a reference field - get the display value or linked table name
      const superClass = record?.super_class;
      if (!superClass) break;

      // super_class can be { link, value } or just a string
      const parentValue =
        typeof superClass === "object" ? superClass.value : superClass;
      if (!parentValue) break;

      // Need to resolve the sys_id to table name
      const parentUrl = `${instanceUrl}/api/now/table/sys_db_object/${parentValue}`;
      const parentResponse = await fetch(parentUrl, { method: "GET", headers });
      if (!parentResponse.ok) break;

      const parentData = await parentResponse.json();
      const parentName = parentData.result?.name;

      if (!parentName || tables.includes(parentName)) break;

      tables.push(parentName);
      currentTable = parentName;
    }
  } catch (e) {
    console.error("Error fetching table hierarchy:", e);
  }

  return tables;
}

export async function getFormFields(
  table: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<FormSchema> {
  const instanceUrl = getInstanceUrl();
  const headers = {
    ...extraHeaders,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // Get table hierarchy to include inherited fields
  const tableHierarchy = await getTableHierarchy(table, headers, instanceUrl);

  // Fetch field definitions from sys_dictionary for all tables in hierarchy
  const dictUrl = `${instanceUrl}/api/now/table/sys_dictionary`;
  const dictParams = new URLSearchParams({
    sysparm_query: `nameIN${tableHierarchy.join(",")}^elementISNOTEMPTY`,
    sysparm_fields:
      "element,column_label,mandatory,internal_type,reference,max_length,default_value,read_only,choice,name",
    sysparm_limit: "500",
  });

  const dictResponse = await fetch(`${dictUrl}?${dictParams}`, {
    method: "GET",
    headers,
  });

  if (!dictResponse.ok) {
    const errorText = await dictResponse.text();
    throw new Error(
      `Failed to fetch form fields (${dictResponse.status}): ${errorText}`,
    );
  }

  const dictData = await dictResponse.json();
  const dictRows = (dictData.result || []).filter(
    (r: Record<string, unknown>) => !String(r.element || "").startsWith("sys_"),
  );

  // Helper to get internal_type value (can be string or object with value property)
  const getInternalType = (val: unknown): string => {
    if (!val) return "";
    if (typeof val === "object" && val !== null && "value" in val) {
      return String((val as { value: unknown }).value || "");
    }
    return String(val);
  };

  // Collect choice fields
  const choiceFields = dictRows
    .filter((r: Record<string, unknown>) => {
      const t = getInternalType(r.internal_type).toLowerCase();
      return (
        t === "choice" ||
        t === "int_choice" ||
        t === "string_choice" ||
        r.choice
      );
    })
    .map((r: Record<string, unknown>) => r.element);

  // Fetch choices if any
  let choicesByField: Record<
    string,
    Array<{ value: string; label: string }>
  > = {};
  if (choiceFields.length > 0) {
    const choiceUrl = `${instanceUrl}/api/now/table/sys_choice`;
    // Query choices for all tables in hierarchy
    const choiceParams = new URLSearchParams({
      sysparm_query: `tableIN${tableHierarchy.join(",")}^elementIN${choiceFields.join(",")}^inactive=false`,
      sysparm_fields: "element,label,value,sequence",
      sysparm_limit: "500",
    });

    const choiceResponse = await fetch(`${choiceUrl}?${choiceParams}`, {
      method: "GET",
      headers,
    });

    if (choiceResponse.ok) {
      const choiceData = await choiceResponse.json();
      for (const ch of choiceData.result || []) {
        if (!choicesByField[ch.element]) {
          choicesByField[ch.element] = [];
        }
        choicesByField[ch.element].push({ value: ch.value, label: ch.label });
      }
      // Sort by sequence
      for (const field of Object.keys(choicesByField)) {
        choicesByField[field].sort((a, b) => a.label.localeCompare(b.label));
      }
    }
  }

  // Build form schema with deduplication (child table fields take precedence)
  // Sort by table hierarchy so child table fields come first
  const sortedRows = [...dictRows].sort((a, b) => {
    const aIdx = tableHierarchy.indexOf(String(a.name));
    const bIdx = tableHierarchy.indexOf(String(b.name));
    return aIdx - bIdx;
  });

  const seenFields = new Set<string>();
  const fields: FormField[] = [];

  for (const r of sortedRows) {
    const fieldName = String(r.element);
    // Skip duplicates - first occurrence (from child table) wins
    if (seenFields.has(fieldName)) continue;
    seenFields.add(fieldName);

    const internalType = getInternalType(r.internal_type) || "string";
    const inputType = classifyInputType(internalType);

    // Filter out calculated/script default values - these are server-side and shouldn't be shown
    let defaultValue: string | undefined;
    if (r.default_value) {
      const val = String(r.default_value);
      // Skip javascript: expressions (calculated defaults)
      // Skip date format placeholders like "dd.mm.yyyy"
      const isCalculated =
        val.startsWith("javascript:") ||
        val.startsWith("glide.") ||
        /^[dmy]{2,4}[.\-/][dmy]{2,4}[.\-/][dmy]{2,4}/i.test(val);
      if (!isCalculated) {
        defaultValue = val;
      }
    }

    const field: FormField = {
      name: fieldName,
      label: String(r.column_label || r.element),
      type: internalType,
      inputType,
      required: r.mandatory === "true" || r.mandatory === true,
      readOnly: r.read_only === "true" || r.read_only === true,
      maxLength: r.max_length ? Number(r.max_length) : undefined,
      defaultValue,
      referenceTable: r.reference ? String(r.reference) : undefined,
    };

    if (choicesByField[field.name]) {
      field.choices = choicesByField[field.name];
    }

    fields.push(field);
  }

  // Sort alphabetically by label
  fields.sort((a, b) => a.label.localeCompare(b.label));

  return {
    table,
    fields,
    hierarchy: tableHierarchy,
    isTaskTable: tableHierarchy.includes("task"),
  };
}

// ---------------------------------------------------------------------------
// Existing-record helpers (view / update / activity)
// ---------------------------------------------------------------------------

function buildHeaders(
  accessToken: string,
  extraHeaders: Record<string, string>,
): Record<string, string> {
  return {
    ...extraHeaders,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/** A 32-char hex string is a ServiceNow sys_id. */
function looksLikeSysId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value.trim());
}

/**
 * Normalize a Table API field value into { value, display }.
 * With `sysparm_display_value=all`, each field is { value, display_value }.
 */
function normalizeValue(raw: unknown): { value: string; display: string } {
  if (raw && typeof raw === "object") {
    const obj = raw as { value?: unknown; display_value?: unknown };
    const value = obj.value != null ? String(obj.value) : "";
    const display =
      obj.display_value != null ? String(obj.display_value) : value;
    return { value, display };
  }
  const str = raw == null ? "" : String(raw);
  return { value: str, display: str };
}

function toTicketRecord(
  table: string,
  raw: Record<string, unknown>,
): TicketRecord {
  const values: TicketRecord["values"] = {};
  for (const [key, val] of Object.entries(raw)) {
    values[key] = normalizeValue(val);
  }
  return {
    table,
    sysId: values.sys_id?.value ?? "",
    number: values.number?.value || undefined,
    displayValue: values.short_description?.display || undefined,
    values,
  };
}

const TICKET_FIELDS = [
  "sys_id",
  "sys_class_name",
  "number",
  "short_description",
  "state",
  "priority",
  "impact",
  "urgency",
  "severity",
  "category",
  "caller_id",
  "assigned_to",
  "assignment_group",
  "cmdb_ci",
  "opened_by",
  "opened_at",
  "closed_at",
  "sys_created_on",
  "sys_updated_on",
  "active",
].join(",");

function escapeQueryValue(value: string): string {
  if (/[\^\r\n]/.test(value)) {
    throw new Error("Filter values cannot contain ^ or line breaks");
  }
  return value.trim();
}

function validateFilterField(field: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)?$/.test(field)) {
    throw new Error(`Invalid additional filter field "${field}"`);
  }
  return field;
}

function addMatch(
  conditions: string[],
  field: string,
  value: string | string[] | undefined,
): void {
  if (value == null) return;
  const values = (Array.isArray(value) ? value : [value])
    .map((item) => escapeQueryValue(item))
    .filter(Boolean);
  if (values.length === 0) return;
  conditions.push(
    values.length === 1
      ? `${field}=${values[0]}`
      : `${field}IN${values.join(",")}`,
  );
}

function addDateRange(
  conditions: string[],
  field: string,
  range: DateRangeFilter | undefined,
): void {
  if (!range) return;
  if (range.after) conditions.push(`${field}>=${escapeQueryValue(range.after)}`);
  if (range.before) conditions.push(`${field}<=${escapeQueryValue(range.before)}`);
}

function buildRelatedUserMatches(
  value: string | string[] | undefined,
): string[] {
  if (value == null) return [];
  const values = (Array.isArray(value) ? value : [value])
    .map((item) => escapeQueryValue(item))
    .filter(Boolean);
  if (values.length === 0) return [];
  const operator = values.length === 1 ? "=" : "IN";
  const joined = values.join(",");
  return ["caller_id", "opened_by", "assigned_to"].map(
    (field) => `${field}.name${operator}${joined}`,
  );
}

/** Build a restrictive encoded query without accepting arbitrary encoded query text. */
export function buildTicketQuery(filters: TicketFilters = {}): string {
  const conditions: string[] = [];
  addMatch(conditions, "number", filters.number);
  if (filters.shortDescription) {
    conditions.push(
      `short_descriptionLIKE${escapeQueryValue(filters.shortDescription)}`,
    );
  }
  addMatch(conditions, "state", filters.state);
  addMatch(conditions, "priority", filters.priority);
  addMatch(conditions, "impact", filters.impact);
  addMatch(conditions, "urgency", filters.urgency);
  addMatch(conditions, "severity", filters.severity);
  addMatch(conditions, "category", filters.category);
  addMatch(conditions, "caller_id.name", filters.caller);
  addMatch(conditions, "assigned_to.name", filters.assignedTo);
  if (filters.assignedToMe) {
    // This static server-side expression is not derived from user input.
    conditions.push("assigned_to=javascript:gs.getUserID()");
  }
  addMatch(conditions, "assignment_group.name", filters.assignmentGroup);
  addMatch(conditions, "cmdb_ci.name", filters.configurationItem);
  addMatch(conditions, "opened_by.name", filters.openedBy);
  if (filters.active != null) conditions.push(`active=${filters.active}`);
  addDateRange(conditions, "opened_at", filters.openedAt);
  addDateRange(conditions, "closed_at", filters.closedAt);
  addDateRange(conditions, "sys_created_on", filters.createdAt);
  addDateRange(conditions, "sys_updated_on", filters.updatedAt);

  for (const [field, value] of Object.entries(filters.additionalFilters || {})) {
    addMatch(conditions, validateFilterField(field), value);
  }
  const relatedUserMatches = buildRelatedUserMatches(filters.relatedUser);
  if (relatedUserMatches.length === 0) return conditions.join("^");

  // ServiceNow encoded queries have no grouping parentheses. Duplicate the
  // shared predicates into NQ branches so they apply to every user role.
  return relatedUserMatches
    .map((match) => [...conditions, match].join("^"))
    .join("^NQ");
}

function toTicketSummary(
  raw: Record<string, unknown>,
  instanceUrl: string,
): TicketSummary {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    values[key] = normalizeValue(value).display;
  }
  const table = normalizeValue(raw.sys_class_name).value || "task";
  const sysId = normalizeValue(raw.sys_id).value;
  const rawValue = (field: string): string => normalizeValue(raw[field]).value;
  return {
    table,
    tableLabel: values.sys_class_name || table,
    sysId,
    recordUrl: `${instanceUrl}/nav_to.do?uri=${encodeURIComponent(
      `${table}.do?sys_id=${sysId}`,
    )}`,
    number: values.number || "",
    shortDescription: values.short_description || "",
    state: values.state || "",
    stateValue: rawValue("state"),
    priority: values.priority || "",
    priorityValue: rawValue("priority"),
    impact: values.impact || "",
    impactValue: rawValue("impact"),
    urgency: values.urgency || "",
    urgencyValue: rawValue("urgency"),
    severity: values.severity || "",
    severityValue: rawValue("severity"),
    category: values.category || "",
    caller: values.caller_id || "",
    assignedTo: values.assigned_to || "",
    assignmentGroup: values.assignment_group || "",
    configurationItem: values.cmdb_ci || "",
    openedBy: values.opened_by || "",
    openedAt: values.opened_at || "",
    closedAt: values.closed_at || "",
    createdAt: values.sys_created_on || "",
    updatedAt: values.sys_updated_on || "",
    active: values.active || "",
    activeValue: rawValue("active"),
  };
}

const CHOICE_FILTER_FIELDS = [
  "state",
  "priority",
  "impact",
  "urgency",
  "severity",
] as const;

/**
 * The Table API expects stored choice values (for example, `1`) while people
 * naturally use labels (for example, `1 - Critical`). Resolve matching labels
 * across the instance's task-related choice definitions before querying.
 */
async function resolveChoiceFilterLabels(
  filters: TicketFilters,
  headers: Record<string, string>,
  instanceUrl: string,
): Promise<TicketFilters> {
  const requested = CHOICE_FILTER_FIELDS.flatMap((field) => {
    const value = filters[field];
    return value == null ? [] : Array.isArray(value) ? value : [value];
  });
  if (requested.length === 0) return filters;

  const params = new URLSearchParams({
    sysparm_query: `elementIN${CHOICE_FILTER_FIELDS.join(",")}^inactive=false`,
    sysparm_fields: "element,label,value",
    sysparm_limit: "1000",
  });
  const response = await fetch(
    `${instanceUrl}/api/now/table/sys_choice?${params}`,
    { method: "GET", headers },
  );
  if (!response.ok) return filters;

  const data = await response.json();
  const choices = (data.result || []) as Array<Record<string, unknown>>;
  const resolved: TicketFilters = { ...filters };
  for (const field of CHOICE_FILTER_FIELDS) {
    const input = filters[field];
    if (input == null) continue;
    const values = Array.isArray(input) ? input : [input];
    resolved[field] = values.flatMap((value) => {
      const normalized = value.trim().toLocaleLowerCase();
      const matches = choices
        .filter(
          (choice) =>
            String(choice.element) === field &&
            String(choice.label).trim().toLocaleLowerCase() === normalized,
        )
        .map((choice) => String(choice.value));
      return matches.length > 0 ? matches : [value];
    });
  }
  return resolved;
}

/**
 * Discover task-derived records using user-facing filters. ServiceNow applies
 * the authenticated user's table and record ACLs to this request.
 */
export async function discoverTickets(
  filters: TicketFilters,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
  options: {
    limit?: number;
    sortBy?: TicketSortField;
    sortDirection?: "asc" | "desc";
  } = {},
): Promise<{ tickets: TicketSummary[]; query: string }> {
  const instanceUrl = getInstanceUrl();
  const headers = buildHeaders(accessToken, extraHeaders);
  const assignedToValues =
    filters.assignedTo == null
      ? []
      : Array.isArray(filters.assignedTo)
        ? filters.assignedTo
        : [filters.assignedTo];
  const isSelfReference = (value: string): boolean =>
    /^(me|myself|current user)$/i.test(value.trim());
  const selfReferences = assignedToValues.filter(isSelfReference);
  const namedAssignees = assignedToValues.filter(
    (value) => !isSelfReference(value),
  );
  if (selfReferences.length > 0 && namedAssignees.length > 0) {
    throw new Error(
      "The “me” assignee cannot be combined with named assignees in one search",
    );
  }
  const queryFilters: TicketFilters = {
    ...filters,
    assignedToMe: filters.assignedToMe || selfReferences.length > 0,
    assignedTo:
      namedAssignees.length === 0
        ? undefined
        : Array.isArray(filters.assignedTo)
          ? namedAssignees
          : namedAssignees[0],
  };
  const resolvedFilters = await resolveChoiceFilterLabels(
    queryFilters,
    headers,
    instanceUrl,
  );
  const query = buildTicketQuery(resolvedFilters);
  const sortFields: Record<TicketSortField, string> = {
    priority: "priority",
    severity: "severity",
    impact: "impact",
    urgency: "urgency",
    state: "state",
    opened_at: "opened_at",
    updated_at: "sys_updated_on",
    created_at: "sys_created_on",
  };
  let orderQuery: string;
  if (options.sortBy) {
    const direction =
      options.sortDirection ??
      (["opened_at", "updated_at", "created_at"].includes(options.sortBy)
        ? "desc"
        : "asc");
    const operator = direction === "desc" ? "ORDERBYDESC" : "ORDERBY";
    orderQuery = `${operator}${sortFields[options.sortBy]}^ORDERBYsys_id`;
  } else {
    // Triage default: most important tickets first, then the oldest opened.
    orderQuery = "ORDERBYpriority^ORDERBYimpact^ORDERBYopened_at";
  }
  const params = new URLSearchParams({
    sysparm_fields: TICKET_FIELDS,
    sysparm_display_value: "all",
    sysparm_exclude_reference_link: "true",
    sysparm_limit: String(Math.min(Math.max(options.limit ?? 25, 1), 100)),
    sysparm_query: [query, orderQuery].filter(Boolean).join("^"),
  });
  const response = await fetch(`${instanceUrl}/api/now/table/task?${params}`, {
    method: "GET",
    headers,
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ServiceNow API error (${response.status}): ${errorText}`);
  }
  const data = await response.json();
  return {
    tickets: (data.result || []).map((row: Record<string, unknown>) =>
      toTicketSummary(row, instanceUrl),
    ),
    query,
  };
}

/**
 * Fetch a single record by sys_id or by its human-readable number
 * (e.g. `INC0010023`). Values come back with both raw + display labels.
 */
export async function getRecord(
  table: string,
  idOrNumber: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<TicketRecord> {
  const instanceUrl = getInstanceUrl();
  const headers = buildHeaders(accessToken, extraHeaders);
  const id = idOrNumber.trim();

  let url: string;
  if (looksLikeSysId(id)) {
    url = `${instanceUrl}/api/now/table/${table}/${id}?sysparm_display_value=all`;
  } else {
    const params = new URLSearchParams({
      sysparm_query: `number=${id}`,
      sysparm_display_value: "all",
      sysparm_limit: "1",
    });
    url = `${instanceUrl}/api/now/table/${table}?${params}`;
  }

  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ServiceNow API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const record = Array.isArray(data.result) ? data.result[0] : data.result;
  if (!record) {
    throw new Error(`No ${table} record found for "${idOrNumber}"`);
  }

  return toTicketRecord(table, record as Record<string, unknown>);
}

/**
 * Update fields on an existing record via PATCH. Returns the refreshed record.
 */
export async function updateRecord(
  table: string,
  sysId: string,
  data: Record<string, unknown>,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<TicketRecord> {
  const instanceUrl = getInstanceUrl();
  const headers = buildHeaders(accessToken, extraHeaders);
  const url = `${instanceUrl}/api/now/table/${table}/${sysId}?sysparm_display_value=all`;

  const response = await fetch(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ServiceNow API error (${response.status}): ${errorText}`);
  }

  const result = await response.json();
  return toTicketRecord(table, result.result as Record<string, unknown>);
}

/**
 * Fetch the comment / work-note activity stream for a record from
 * `sys_journal_field`, oldest first. Visibility follows the user's ACLs.
 */
export async function getActivity(
  table: string,
  sysId: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<ActivityEntry[]> {
  const instanceUrl = getInstanceUrl();
  const headers = buildHeaders(accessToken, extraHeaders);
  const url = `${instanceUrl}/api/now/table/sys_journal_field`;
  const params = new URLSearchParams({
    sysparm_query: `name=${table}^element_id=${sysId}^elementINcomments,work_notes^ORDERBYsys_created_on`,
    sysparm_fields: "element,value,sys_created_on,sys_created_by",
    sysparm_display_value: "true",
    sysparm_limit: "200",
  });

  const response = await fetch(`${url}?${params}`, { method: "GET", headers });
  if (!response.ok) {
    // Activity is best-effort; a failure here shouldn't break the panel.
    return [];
  }

  const data = await response.json();
  return (data.result || []).map(
    (r: Record<string, unknown>): ActivityEntry => ({
      field: String(r.element) === "work_notes" ? "work_notes" : "comments",
      value: String(r.value ?? ""),
      createdOn: String(r.sys_created_on ?? ""),
      createdBy: String(r.sys_created_by ?? ""),
    }),
  );
}

/** List file attachments associated with a ticket. */
export async function getAttachments(
  table: string,
  sysId: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<TicketAttachment[]> {
  const instanceUrl = getInstanceUrl();
  const params = new URLSearchParams({
    sysparm_query: `table_name=${escapeQueryValue(table)}^table_sys_id=${escapeQueryValue(sysId)}^ORDERBYDESCsys_created_on`,
    sysparm_fields:
      "sys_id,file_name,content_type,size_bytes,sys_created_on,sys_created_by",
    sysparm_display_value: "true",
    sysparm_limit: "100",
  });
  const response = await fetch(
    `${instanceUrl}/api/now/table/sys_attachment?${params}`,
    { method: "GET", headers: buildHeaders(accessToken, extraHeaders) },
  );
  if (!response.ok) return [];
  const data = await response.json();
  return (data.result || []).map(
    (row: Record<string, unknown>): TicketAttachment => ({
      sysId: String(row.sys_id ?? ""),
      fileName: String(row.file_name ?? "attachment"),
      contentType: String(row.content_type ?? "application/octet-stream"),
      sizeBytes: Number(row.size_bytes) || 0,
      createdOn: String(row.sys_created_on ?? ""),
      createdBy: String(row.sys_created_by ?? ""),
    }),
  );
}

/** Upload a base64-encoded file to a ticket and return its metadata. */
export async function uploadAttachment(
  table: string,
  sysId: string,
  fileName: string,
  contentType: string,
  dataBase64: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<TicketAttachment> {
  const fileData = Buffer.from(dataBase64, "base64");
  if (fileData.length === 0) throw new Error("The attachment is empty");
  if (fileData.length > 8 * 1024 * 1024) {
    throw new Error("Attachments are limited to 8 MB");
  }
  const instanceUrl = getInstanceUrl();
  const params = new URLSearchParams({
    table_name: table,
    table_sys_id: sysId,
    file_name: fileName,
  });
  const response = await fetch(
    `${instanceUrl}/api/now/attachment/file?${params}`,
    {
      method: "POST",
      headers: {
        ...extraHeaders,
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": contentType || "application/octet-stream",
      },
      body: fileData,
    },
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Attachment upload failed (${response.status}): ${errorText}`);
  }
  const data = await response.json();
  const row = data.result || {};
  return {
    sysId: String(row.sys_id ?? ""),
    fileName: String(row.file_name ?? fileName),
    contentType: String(row.content_type ?? contentType),
    sizeBytes: Number(row.size_bytes) || fileData.length,
    createdOn: String(row.sys_created_on ?? ""),
    createdBy: String(row.sys_created_by ?? ""),
  };
}

/** Download an attachment as base64 so an MCP App can save it locally. */
export async function downloadAttachment(
  sysId: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ dataBase64: string; contentType: string }> {
  const instanceUrl = getInstanceUrl();
  const response = await fetch(
    `${instanceUrl}/api/now/attachment/${encodeURIComponent(sysId)}/file`,
    {
      method: "GET",
      headers: {
        ...extraHeaders,
        Authorization: `Bearer ${accessToken}`,
        Accept: "*/*",
      },
    },
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Attachment download failed (${response.status}): ${errorText}`,
    );
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > 8 * 1024 * 1024) {
    throw new Error("Attachments larger than 8 MB cannot be downloaded in-chat");
  }
  return {
    dataBase64: data.toString("base64"),
    contentType:
      response.headers.get("content-type") || "application/octet-stream",
  };
}

/** Delete an attachment from ServiceNow. */
export async function deleteAttachment(
  sysId: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const instanceUrl = getInstanceUrl();
  const response = await fetch(
    `${instanceUrl}/api/now/attachment/${encodeURIComponent(sysId)}`,
    {
      method: "DELETE",
      headers: {
        ...extraHeaders,
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Attachment deletion failed (${response.status}): ${errorText}`);
  }
}
