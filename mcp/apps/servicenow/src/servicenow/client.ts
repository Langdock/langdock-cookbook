import { createHash } from "node:crypto";
import sanitizeHtml from "sanitize-html";

import { getInstanceUrl } from "../utils/getInstanceUrl.js";

const TABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const SYS_ID_PATTERN = /^[0-9a-f]{32}$/i;

function validateTableName(table: string): string {
  const normalized = table.trim();
  if (!TABLE_NAME_PATTERN.test(normalized)) {
    throw new Error(`Invalid ServiceNow table name "${table}"`);
  }
  return normalized;
}

function validateSysId(sysId: string, label = "sys_id"): string {
  const normalized = sysId.trim();
  if (!SYS_ID_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a 32-character ServiceNow sys_id`);
  }
  return normalized;
}

function tablePath(table: string): string {
  return encodeURIComponent(validateTableName(table));
}

export async function submitForm(
  table: string,
  data: Record<string, unknown>,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<unknown> {
  const instanceUrl = getInstanceUrl();
  const url = `${instanceUrl}/api/now/table/${tablePath(table)}`;

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

export interface FormSection {
  id: string;
  title: string;
  fields: string[];
}

export interface FormSchema {
  table: string;
  fields: FormField[];
  /** Sections from the configured ServiceNow form view, when readable. */
  sections?: FormSection[];
  view?: string;
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

export interface ReferenceSearchResult {
  sysId: string;
  displayValue: string;
}

const FORM_SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;
const formSchemaCache = new Map<
  string,
  { expiresAt: number; schema: FormSchema }
>();
const referenceDisplayFieldCache = new Map<string, string>();

function formSchemaCacheKey(
  instanceUrl: string,
  table: string,
  accessToken: string,
  extraHeaders: Record<string, string>,
  view: string,
): string {
  const identity = createHash("sha256")
    .update(accessToken)
    .update(JSON.stringify(Object.entries(extraHeaders).sort()))
    .digest("hex");
  return `${instanceUrl}|${table}|${view}|${identity}`;
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
  const tables: string[] = [validateTableName(table)];

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
      if (!SYS_ID_PATTERN.test(String(parentValue))) break;
      const parentUrl = `${instanceUrl}/api/now/table/sys_db_object/${encodeURIComponent(String(parentValue))}`;
      const parentResponse = await fetch(parentUrl, { method: "GET", headers });
      if (!parentResponse.ok) break;

      const parentData = await parentResponse.json();
      const parentName = String(parentData.result?.name || "").trim();

      if (!TABLE_NAME_PATTERN.test(parentName) || tables.includes(parentName)) break;

      tables.push(parentName);
      currentTable = parentName;
    }
  } catch (e) {
    console.error("Error fetching table hierarchy:", e);
  }

  return tables;
}

async function getFormSections(
  table: string,
  view: string,
  headers: Record<string, string>,
  instanceUrl: string,
): Promise<FormSection[]> {
  try {
    const sectionQuery = view
      ? `name=${table}^view.name=${escapeQueryValue(view)}`
      : `name=${table}^viewISEMPTY`;
    const sectionParams = new URLSearchParams({
      sysparm_query: sectionQuery,
      sysparm_fields: "sys_id,caption",
      sysparm_display_value: "all",
      sysparm_limit: "100",
    });
    const sectionResponse = await fetch(
      `${instanceUrl}/api/now/table/sys_ui_section?${sectionParams}`,
      { headers },
    );
    if (!sectionResponse.ok) return [];
    const sectionData = await sectionResponse.json();
    const sectionRows: Record<string, unknown>[] = Array.isArray(
      sectionData.result,
    )
      ? sectionData.result
      : [];
    if (sectionRows.length === 0) return [];

    const sectionIds = sectionRows
      .map((row) => normalizeValue(row.sys_id).value)
      .filter((id) => SYS_ID_PATTERN.test(id));
    if (sectionIds.length === 0) return [];
    const formParams = new URLSearchParams({
      sysparm_query: sectionQuery,
      sysparm_fields: "sys_id",
      sysparm_limit: "1",
    });
    const formResponse = await fetch(
      `${instanceUrl}/api/now/table/sys_ui_form?${formParams}`,
      { headers },
    );
    const sectionOrder = new Map<string, number>();
    if (formResponse.ok) {
      const formData = await formResponse.json();
      const formId = normalizeValue(formData.result?.[0]?.sys_id).value;
      if (SYS_ID_PATTERN.test(formId)) {
        const formSectionParams = new URLSearchParams({
          sysparm_query: `sys_ui_form=${formId}^sys_ui_sectionIN${sectionIds.join(",")}^ORDERBYposition`,
          sysparm_fields: "sys_ui_section,position",
          sysparm_limit: "100",
        });
        const formSectionResponse = await fetch(
          `${instanceUrl}/api/now/table/sys_ui_form_section?${formSectionParams}`,
          { headers },
        );
        if (formSectionResponse.ok) {
          const formSectionData = await formSectionResponse.json();
          for (const row of formSectionData.result || []) {
            sectionOrder.set(
              normalizeValue(row.sys_ui_section).value,
              Number(normalizeValue(row.position).value) || 0,
            );
          }
        }
      }
    }
    const elementParams = new URLSearchParams({
      sysparm_query: `sys_ui_sectionIN${sectionIds.join(",")}^elementISNOTEMPTY^ORDERBYposition`,
      sysparm_fields: "sys_ui_section,element,position",
      sysparm_display_value: "all",
      sysparm_limit: "1000",
    });
    const elementResponse = await fetch(
      `${instanceUrl}/api/now/table/sys_ui_element?${elementParams}`,
      { headers },
    );
    if (!elementResponse.ok) return [];
    const elementData = await elementResponse.json();
    const elementRows: Record<string, unknown>[] = Array.isArray(
      elementData.result,
    )
      ? elementData.result
      : [];
    const fieldsBySection = new Map<string, string[]>();
    for (const row of elementRows) {
      const sectionId = normalizeValue(row.sys_ui_section).value;
      const element = normalizeValue(row.element).value;
      if (!sectionId || !element || element.startsWith(".")) continue;
      const fields = fieldsBySection.get(sectionId) || [];
      fields.push(element);
      fieldsBySection.set(sectionId, fields);
    }

    const orderedSectionRows = [...sectionRows].sort(
      (left, right) =>
        (sectionOrder.get(normalizeValue(left.sys_id).value) ??
          Number.MAX_SAFE_INTEGER) -
        (sectionOrder.get(normalizeValue(right.sys_id).value) ??
          Number.MAX_SAFE_INTEGER),
    );
    return orderedSectionRows
      .map((row, index) => {
        const id = normalizeValue(row.sys_id).value;
        const caption = normalizeValue(row.caption).display.trim();
        return {
          id,
          title: caption || (index === 0 ? "Details" : `Section ${index + 1}`),
          fields: fieldsBySection.get(id) || [],
        };
      })
      .filter((section) => section.fields.length > 0);
  } catch {
    return [];
  }
}

async function getReferenceDisplayField(
  table: string,
  accessToken: string,
  extraHeaders: Record<string, string>,
): Promise<string> {
  const instanceUrl = getInstanceUrl();
  const validatedTable = validateTableName(table);
  const cacheKey = `${instanceUrl}|${validatedTable}`;
  const cached = referenceDisplayFieldCache.get(cacheKey);
  if (cached) return cached;
  const headers = {
    ...extraHeaders,
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  const hierarchy = await getTableHierarchy(
    validatedTable,
    headers,
    instanceUrl,
  );
  for (const hierarchyTable of hierarchy) {
    const params = new URLSearchParams({
      sysparm_query: `name=${hierarchyTable}^display=true^elementISNOTEMPTY`,
      sysparm_fields: "element",
      sysparm_limit: "1",
    });
    const response = await fetch(
      `${instanceUrl}/api/now/table/sys_dictionary?${params}`,
      { headers },
    );
    if (!response.ok) continue;
    const data = await response.json();
    const field = normalizeValue(data.result?.[0]?.element).value;
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) {
      referenceDisplayFieldCache.set(cacheKey, field);
      return field;
    }
  }

  const fallbackPriority = [
    "name",
    "u_name",
    "number",
    "u_number",
    "sys_created_on",
  ];
  for (const hierarchyTable of hierarchy) {
    const params = new URLSearchParams({
      sysparm_query: `name=${hierarchyTable}^elementIN${fallbackPriority.join(",")}`,
      sysparm_fields: "element",
      sysparm_limit: String(fallbackPriority.length),
    });
    const response = await fetch(
      `${instanceUrl}/api/now/table/sys_dictionary?${params}`,
      { headers },
    );
    if (!response.ok) continue;
    const data = await response.json();
    const available = new Set(
      (data.result || []).map(
        (row: Record<string, unknown>) => normalizeValue(row.element).value,
      ),
    );
    const field = fallbackPriority.find((candidate) =>
      available.has(candidate),
    );
    if (field) {
      referenceDisplayFieldCache.set(cacheKey, field);
      return field;
    }
  }
  return "sys_created_on";
}

export async function getFormFields(
  table: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
  options: { view?: string } = {},
): Promise<FormSchema> {
  const instanceUrl = getInstanceUrl();
  const validatedTable = validateTableName(table);
  const view = options.view?.trim() || "";
  const cacheKey = formSchemaCacheKey(
    instanceUrl,
    validatedTable,
    accessToken,
    extraHeaders,
    view,
  );
  const cached = formSchemaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.schema;
  if (cached) formSchemaCache.delete(cacheKey);
  const headers = {
    ...extraHeaders,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // Get table hierarchy to include inherited fields
  const tableHierarchy = await getTableHierarchy(
    validatedTable,
    headers,
    instanceUrl,
  );

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
  const referenceTableIds = [
    ...new Set(
      dictRows
        .map((row: Record<string, unknown>) =>
          normalizeValue(row.reference).value,
        )
        .filter((value: string) => SYS_ID_PATTERN.test(value)),
    ),
  ];
  const referenceTablesById = new Map<string, string>();
  if (referenceTableIds.length > 0) {
    const referenceParams = new URLSearchParams({
      sysparm_query: `sys_idIN${referenceTableIds.join(",")}`,
      sysparm_fields: "sys_id,name",
      sysparm_limit: String(referenceTableIds.length),
    });
    const referenceResponse = await fetch(
      `${instanceUrl}/api/now/table/sys_db_object?${referenceParams}`,
      { headers },
    );
    if (referenceResponse.ok) {
      const referenceData = await referenceResponse.json();
      for (const row of referenceData.result || []) {
        const id = normalizeValue(row.sys_id).value;
        const name = normalizeValue(row.name).value;
        if (SYS_ID_PATTERN.test(id) && TABLE_NAME_PATTERN.test(name)) {
          referenceTablesById.set(id, name);
        }
      }
    }
  }

  // Helper to get internal_type value (can be string or object with value property)
  const getInternalType = (val: unknown): string => {
    if (!val) return "";
    if (typeof val === "object" && val !== null && "value" in val) {
      return String((val as { value: unknown }).value || "");
    }
    return String(val);
  };
  const getReferenceTable = (val: unknown): string | undefined => {
    const normalized = normalizeValue(val);
    for (const candidate of [normalized.value, normalized.display]) {
      const trimmed = candidate.trim();
      const resolved = referenceTablesById.get(trimmed);
      if (resolved) return resolved;
      if (TABLE_NAME_PATTERN.test(trimmed)) return trimmed;
      const bracketed = trimmed.match(/\[([A-Za-z][A-Za-z0-9_]*)\]/);
      if (bracketed) return bracketed[1];
    }
    return undefined;
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
    // Query choices for all tables in hierarchy. `name` is the table-name
    // column on sys_choice; `table` is not.
    const choiceLanguage = process.env.SERVICENOW_LANGUAGE?.trim() || "en";
    const choiceParams = new URLSearchParams({
      sysparm_query: `nameIN${tableHierarchy.join(",")}^elementIN${choiceFields.join(",")}^inactive=false^language=${escapeQueryValue(choiceLanguage)}`,
      sysparm_fields: "name,element,label,value,sequence",
      sysparm_limit: "500",
    });

    const choiceResponse = await fetch(`${choiceUrl}?${choiceParams}`, {
      method: "GET",
      headers,
    });

    if (choiceResponse.ok) {
      const choiceData = await choiceResponse.json();
      const choiceRows = [...(choiceData.result || [])].sort(
        (a: Record<string, unknown>, b: Record<string, unknown>) =>
          tableHierarchy.indexOf(String(a.name)) -
          tableHierarchy.indexOf(String(b.name)),
      );
      const seenChoices = new Set<string>();
      for (const ch of choiceRows) {
        const choiceKey = `${ch.element}\u0000${ch.value}`;
        if (seenChoices.has(choiceKey)) continue;
        seenChoices.add(choiceKey);
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
      referenceTable: getReferenceTable(r.reference),
    };

    if (choicesByField[field.name]) {
      field.choices = choicesByField[field.name];
    }

    fields.push(field);
  }

  // Sort alphabetically by label
  fields.sort((a, b) => a.label.localeCompare(b.label));

  let sections: FormSection[] = [];
  for (const hierarchyTable of tableHierarchy) {
    sections = await getFormSections(
      hierarchyTable,
      view,
      headers,
      instanceUrl,
    );
    if (sections.length > 0) break;
  }
  const schema = {
    table: validatedTable,
    fields,
    sections: sections.length > 0 ? sections : undefined,
    view: view || undefined,
    hierarchy: tableHierarchy,
    isTaskTable: tableHierarchy.includes("task"),
  };
  if (formSchemaCache.size >= 200) {
    const oldestKey = formSchemaCache.keys().next().value;
    if (oldestKey) formSchemaCache.delete(oldestKey);
  }
  formSchemaCache.set(cacheKey, {
    expiresAt: Date.now() + FORM_SCHEMA_CACHE_TTL_MS,
    schema,
  });
  return schema;
}

/** Search records for a reference-field autocomplete. */
export async function searchReferenceRecords(
  table: string,
  query: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
  options: { limit?: number } = {},
): Promise<ReferenceSearchResult[]> {
  const instanceUrl = getInstanceUrl();
  const validatedTable = validateTableName(table);
  const searchText = query.trim();
  if (searchText.length < 1 || searchText.length > 100) return [];
  const displayField = await getReferenceDisplayField(
    validatedTable,
    accessToken,
    extraHeaders,
  );
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 20);
  const encodedQuery = SYS_ID_PATTERN.test(searchText)
    ? `sys_id=${searchText}`
    : `${displayField}LIKE${escapeQueryValue(searchText)}^ORDERBY${displayField}`;
  const params = new URLSearchParams({
    sysparm_query: encodedQuery,
    sysparm_fields: `sys_id,${displayField}`,
    sysparm_display_value: "all",
    sysparm_limit: String(limit),
  });
  const response = await fetch(
    `${instanceUrl}/api/now/table/${tablePath(validatedTable)}?${params}`,
    {
      headers: {
        ...extraHeaders,
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Reference search failed (${response.status}): ${errorText}`,
    );
  }
  const data = await response.json();
  const rows: Record<string, unknown>[] = Array.isArray(data.result)
    ? data.result
    : [];
  return rows
    .map((row) => ({
      sysId: normalizeValue(row.sys_id).value,
      displayValue:
        normalizeValue(row[displayField]).display ||
        normalizeValue(row[displayField]).value,
    }))
    .filter((result) => result.sysId && result.displayValue);
}

const TICKET_PANEL_FIELDS = new Set([
  "number",
  "short_description",
  "description",
  "state",
  "priority",
  "impact",
  "urgency",
  "severity",
  "category",
  "subcategory",
  "caller_id",
  "requested_for",
  "opened_by",
  "assigned_to",
  "assignment_group",
  "cmdb_ci",
  "active",
  "opened_at",
  "closed_at",
  "due_date",
  "expected_start",
  "work_start",
  "work_end",
  "approval",
  "close_code",
  "close_notes",
  "comments",
  "work_notes",
]);
const ticketSchemaInFlight = new Map<string, Promise<FormSchema>>();

/**
 * Return the useful ticket-editing subset of a table schema. The full schema
 * remains cached for creation forms, while ticket payloads stay small.
 */
export async function getTicketFields(
  table: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<FormSchema> {
  const key = formSchemaCacheKey(
    getInstanceUrl(),
    table,
    accessToken,
    extraHeaders,
    "",
  );
  const inFlight = ticketSchemaInFlight.get(key);
  if (inFlight) return inFlight;
  const promise = getFormFields(table, accessToken, extraHeaders).then(
    (schema): FormSchema => ({
      ...schema,
      fields: schema.fields.filter((field) =>
        TICKET_PANEL_FIELDS.has(field.name),
      ),
    }),
  );
  ticketSchemaInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (ticketSchemaInFlight.get(key) === promise) {
      ticketSchemaInFlight.delete(key);
    }
  }
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
  return SYS_ID_PATTERN.test(value.trim());
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
  const normalized = value.trim();
  if (/[\^\r\n\u0000]/.test(normalized)) {
    throw new Error("Filter values cannot contain ^ or line breaks");
  }
  if (/^javascript\s*:/i.test(normalized)) {
    throw new Error("Filter values cannot contain ServiceNow JavaScript expressions");
  }
  return normalized;
}

/** Normalize free-text knowledge search input for Zing (never throw on user prose). */
function sanitizeKnowledgeSearchText(value: string): string {
  return value
    .replace(/javascript\s*:/gi, " ")
    .replace(/[\^\r\n\u0000]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  if (values.length > 1 && values.some((item) => item.includes(","))) {
    throw new Error("Comma-containing filter values cannot be combined in an array");
  }
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
  if (values.length > 1 && values.some((item) => item.includes(","))) {
    throw new Error("Comma-containing person filters cannot be combined in an array");
  }
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

interface ResolvedChoiceFilters {
  queryFilters: TicketFilters;
  requested: Partial<Record<(typeof CHOICE_FILTER_FIELDS)[number], string[]>>;
}

/**
 * Choice values such as task state are not consistent across child tables.
 * Leave them out of the base task query and verify each record's raw value and
 * display label after retrieval to avoid cross-table false positives.
 */
function separateChoiceFilters(
  filters: TicketFilters,
): ResolvedChoiceFilters {
  const queryFilters = { ...filters };
  const requested: ResolvedChoiceFilters["requested"] = {};
  for (const field of CHOICE_FILTER_FIELDS) {
    const value = filters[field];
    if (value == null) continue;
    requested[field] = Array.isArray(value) ? value : [value];
    queryFilters[field] = undefined;
  }
  return { queryFilters, requested };
}

export function matchesChoiceFilters(
  ticket: TicketSummary,
  requested: ResolvedChoiceFilters["requested"],
): boolean {
  const ticketFields: Record<
    (typeof CHOICE_FILTER_FIELDS)[number],
    { raw: string; display: string }
  > = {
    state: { raw: ticket.stateValue, display: ticket.state },
    priority: { raw: ticket.priorityValue, display: ticket.priority },
    impact: { raw: ticket.impactValue, display: ticket.impact },
    urgency: { raw: ticket.urgencyValue, display: ticket.urgency },
    severity: { raw: ticket.severityValue, display: ticket.severity },
  };
  return CHOICE_FILTER_FIELDS.every((field) => {
    const values = requested[field];
    if (!values?.length) return true;
    const raw = ticketFields[field].raw.trim().toLocaleLowerCase();
    const display = ticketFields[field].display.trim().toLocaleLowerCase();
    return values.some((value) => {
      const normalized = value.trim().toLocaleLowerCase();
      return normalized === raw || normalized === display;
    });
  });
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
): Promise<{
  tickets: TicketSummary[];
  query: string;
  scanned: number;
  truncated: boolean;
}> {
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
  const resolvedChoices = separateChoiceFilters(queryFilters);
  const query = buildTicketQuery(resolvedChoices.queryFilters);
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
    orderQuery =
      "ORDERBYpriority^ORDERBYimpact^ORDERBYopened_at^ORDERBYsys_id";
  }
  const requestedLimit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const needsChoiceVerification = Object.keys(resolvedChoices.requested).length > 0;
  const configuredScanLimit = Number.parseInt(
    process.env.SERVICENOW_DISCOVERY_SCAN_LIMIT || "",
    10,
  );
  const maxCandidateRows = Math.max(
    requestedLimit,
    Number.isFinite(configuredScanLimit) && configuredScanLimit > 0
      ? configuredScanLimit
      : 5000,
  );
  const tickets: TicketSummary[] = [];
  let offset = 0;
  let truncated = false;

  while (tickets.length < requestedLimit) {
    const pageSize = needsChoiceVerification
      ? Math.min(100, maxCandidateRows - offset)
      : requestedLimit;
    if (pageSize <= 0) {
      truncated = true;
      break;
    }
    const params = new URLSearchParams({
      sysparm_fields: TICKET_FIELDS,
      sysparm_display_value: "all",
      sysparm_exclude_reference_link: "true",
      sysparm_limit: String(pageSize),
      sysparm_offset: String(offset),
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
    const rows = (data.result || []) as Array<Record<string, unknown>>;
    const summaries = rows.map((row) => toTicketSummary(row, instanceUrl));
    tickets.push(
      ...summaries.filter(
          (ticket) =>
            !needsChoiceVerification ||
            matchesChoiceFilters(ticket, resolvedChoices.requested),
        ),
    );
    offset += rows.length;
    if (rows.length < pageSize) break;
    if (needsChoiceVerification && offset >= maxCandidateRows) {
      truncated = true;
      break;
    }
  }

  return {
    tickets: tickets.slice(0, requestedLimit),
    query,
    scanned: offset,
    truncated,
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
  const validatedTable = validateTableName(table);

  let url: string;
  if (looksLikeSysId(id)) {
    url = `${instanceUrl}/api/now/table/${tablePath(validatedTable)}/${validateSysId(id)}?sysparm_display_value=all`;
  } else {
    const params = new URLSearchParams({
      sysparm_query: `number=${escapeQueryValue(id)}`,
      sysparm_display_value: "all",
      sysparm_limit: "1",
    });
    url = `${instanceUrl}/api/now/table/${tablePath(validatedTable)}?${params}`;
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

  return toTicketRecord(validatedTable, record as Record<string, unknown>);
}

/**
 * Some ServiceNow roles can read task records through the parent table while
 * API-level ACLs deny direct access to the concrete child table.
 */
export async function getRecordWithTaskFallback(
  preferredTable: string,
  idOrNumber: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ record: TicketRecord; recordTable: string }> {
  try {
    return {
      record: await getRecord(
        preferredTable,
        idOrNumber,
        accessToken,
        extraHeaders,
      ),
      recordTable: preferredTable,
    };
  } catch (error) {
    if (
      preferredTable === "task" ||
      !/ServiceNow API error \(403\)/.test(String(error))
    ) {
      throw error;
    }
    return {
      record: await getRecord(
        "task",
        idOrNumber,
        accessToken,
        extraHeaders,
      ),
      recordTable: "task",
    };
  }
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
  const validatedTable = validateTableName(table);
  const validatedSysId = validateSysId(sysId);
  const url = `${instanceUrl}/api/now/table/${tablePath(validatedTable)}/${validatedSysId}?sysparm_display_value=all`;

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
  return toTicketRecord(validatedTable, result.result as Record<string, unknown>);
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
  const validatedTable = validateTableName(table);
  const validatedSysId = validateSysId(sysId);
  const url = `${instanceUrl}/api/now/table/sys_journal_field`;
  const params = new URLSearchParams({
    sysparm_query: `name=${validatedTable}^element_id=${validatedSysId}^elementINcomments,work_notes^ORDERBYsys_created_on`,
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
  const validatedTable = validateTableName(table);
  const validatedSysId = validateSysId(sysId);
  const params = new URLSearchParams({
    sysparm_query: `table_name=${validatedTable}^table_sys_id=${validatedSysId}^ORDERBYDESCsys_created_on`,
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
  const validatedTable = validateTableName(table);
  const validatedSysId = validateSysId(sysId);
  const params = new URLSearchParams({
    table_name: validatedTable,
    table_sys_id: validatedSysId,
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

/** A published knowledge article returned by contextual form search. */
export interface KnowledgeArticle {
  sysId: string;
  number: string;
  shortDescription: string;
  excerpt: string;
  knowledgeBase: string;
  category: string;
  viewCount: number | null;
  published: string;
  updated: string;
  matchedTerms: string[];
  recordUrl: string;
}

export interface KnowledgeArticleDetail {
  sysId: string;
  number: string;
  shortDescription: string;
  content: string;
  contentHtml: string;
  knowledgeBase: string;
  category: string;
  published: string;
  updated: string;
  recordUrl: string;
}

function knowledgeTerms(value: string): string[] {
  const words =
    value
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || [];
  return [...new Set(words.filter((word) => word.length >= 2))].sort(
    (left, right) => right.length - left.length,
  );
}

function plainText(value: string): string {
  return value
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function knowledgeContentText(value: string): string {
  return value
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function absoluteKnowledgeUrl(
  value: string,
  instanceUrl: string,
  allowData = false,
): string {
  try {
    const url = new URL(value.replace(/&amp;/g, "&"), `${instanceUrl}/`);
    const protocols = ["http:", "https:", "mailto:"];
    if (allowData) protocols.push("data:");
    return protocols.includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function absoluteKnowledgeImageUrl(
  value: string,
  instanceUrl: string,
): string {
  const absolute = absoluteKnowledgeUrl(value, instanceUrl, true);
  if (absolute.startsWith("data:")) return absolute;
  try {
    return new URL(absolute).origin === new URL(instanceUrl).origin
      ? absolute
      : "";
  } catch {
    return "";
  }
}

function sanitizeKnowledgeContent(value: string, instanceUrl: string): string {
  return sanitizeHtml(value, {
    allowedTags: [
      "a",
      "blockquote",
      "br",
      "code",
      "del",
      "details",
      "div",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "img",
      "li",
      "ol",
      "p",
      "pre",
      "s",
      "span",
      "strong",
      "sub",
      "summary",
      "sup",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tr",
      "u",
      "ul",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "title", "width", "height"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan", "scope"],
    },
    allowedSchemes: ["http", "https", "data", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: "a",
        attribs: {
          ...attributes,
          href: absoluteKnowledgeUrl(attributes.href || "", instanceUrl),
        },
      }),
      img: (_tagName, attributes) => ({
        tagName: "img",
        attribs: {
          ...attributes,
          src: absoluteKnowledgeImageUrl(
            attributes.src || "",
            instanceUrl,
          ),
        },
      }),
    },
  });
}

async function embedKnowledgeImages(
  html: string,
  instanceUrl: string,
  accessToken: string,
  extraHeaders: Record<string, string>,
): Promise<string> {
  const sources = [
    ...new Set(
      [...html.matchAll(/\bsrc="([^"]+)"/gi)].map((match) => match[1]),
    ),
  ].slice(0, 4);
  let totalBytes = 0;
  let result = html;

  for (const escapedSource of sources) {
    const source = escapedSource.replace(/&amp;/g, "&");
    if (source.startsWith("data:")) continue;
    try {
      const imageUrl = new URL(source);
      if (imageUrl.origin !== new URL(instanceUrl).origin) continue;
      const response = await fetch(imageUrl, {
        headers: {
          ...extraHeaders,
          Authorization: `Bearer ${accessToken}`,
          Accept: "image/*",
        },
      });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.startsWith("image/")) continue;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 1_500_000 || totalBytes + bytes.length > 4_000_000) {
        continue;
      }
      totalBytes += bytes.length;
      const dataUrl = `data:${contentType};base64,${bytes.toString("base64")}`;
      result = result.replaceAll(`src="${escapedSource}"`, `src="${dataUrl}"`);
    } catch {
      // Keep the absolute URL when an image cannot be embedded.
    }
  }
  return result;
}

function matchingExcerpt(text: string, terms: string[], maxLength = 240): string {
  if (!text) return "";
  const lower = text.toLocaleLowerCase();
  const positions = terms
    .map((term) => lower.indexOf(term))
    .filter((position) => position >= 0);
  const firstMatch = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, firstMatch - 70);
  const end = Math.min(text.length, start + maxLength);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

/**
 * Search published knowledge articles by free-text keywords.
 *
 * Queries the native ServiceNow Zing text index through `IR_AND_OR_QUERY` and
 * preserves its relevance order. Zing owns stop-word removal, stemming,
 * synonym expansion, field weights, and document scoring.
 */
export async function searchKnowledgeArticles(
  query: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
  options: {
    limit?: number;
    shortDescription?: string;
    description?: string;
  } = {},
): Promise<KnowledgeArticle[]> {
  const instanceUrl = getInstanceUrl();
  const shortDescription = sanitizeKnowledgeSearchText(
    options.shortDescription || "",
  );
  const description = sanitizeKnowledgeSearchText(options.description || "");
  const combinedQuery = sanitizeKnowledgeSearchText(
    query || `${shortDescription} ${description}`,
  ).slice(0, 500);
  // Prefer short description when specific enough; otherwise use the combined
  // query so a short subject + long body still searches (matches the form UI).
  const primaryQuery =
    shortDescription.length >= 3
      ? shortDescription.slice(0, 500)
      : combinedQuery;
  if (primaryQuery.length < 3) {
    return [];
  }

  const limit = Math.min(Math.max(options.limit ?? 5, 1), 10);
  const fetchZingResults = async (
    searchQuery: string,
  ): Promise<Record<string, unknown>[]> => {
    const searchText = sanitizeKnowledgeSearchText(searchQuery);
    if (searchText.length < 3) return [];
    const sysparmQuery = [
      "workflow_state=published",
      "active=true",
      `IR_AND_OR_QUERY=${searchText}`,
      "ORDERBYDESCir_query_score",
    ].join("^");
    const params = new URLSearchParams({
      sysparm_query: sysparmQuery,
      sysparm_limit: String(limit),
      sysparm_display_value: "all",
      sysparm_fields:
        "sys_id,number,short_description,text,kb_knowledge_base,kb_category,sys_view_count,published,sys_updated_on",
    });
    const response = await fetch(
      `${instanceUrl}/api/now/table/kb_knowledge?${params}`,
      {
        method: "GET",
        headers: {
          ...extraHeaders,
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ServiceNow API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return Array.isArray(data.result) ? data.result : [];
  };

  const rows = await fetchZingResults(primaryQuery);
  const fallbackQuery =
    combinedQuery !== primaryQuery && combinedQuery.length >= 3
      ? combinedQuery
      : description &&
          description !== primaryQuery &&
          `${primaryQuery} ${description}`.trim().length >= 3
        ? sanitizeKnowledgeSearchText(
            `${primaryQuery} ${description}`,
          ).slice(0, 500)
        : "";
  if (rows.length < limit && fallbackQuery && fallbackQuery !== primaryQuery) {
    const seen = new Set(rows.map((row) => normalizeValue(row.sys_id).value));
    try {
      const fallbackRows = await fetchZingResults(fallbackQuery);
      for (const row of fallbackRows) {
        const sysId = normalizeValue(row.sys_id).value;
        if (!seen.has(sysId)) {
          seen.add(sysId);
          rows.push(row);
        }
        if (rows.length === limit) break;
      }
    } catch {
      // Keep successful primary results if the fallback query fails.
    }
  }

  const displayTerms = knowledgeTerms(combinedQuery || primaryQuery);
  return rows.slice(0, limit).map((raw) => {
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      values[key] = normalizeValue(value).display;
    }
    const sysId = normalizeValue(raw.sys_id).value;
    const viewRaw = normalizeValue(raw.sys_view_count).value;
    const viewCount = viewRaw === "" ? null : Number(viewRaw);
    const title = values.short_description || "";
    const body = plainText(normalizeValue(raw.text).value);
    const searchableText = `${title} ${body}`.toLocaleLowerCase();
    const matchedTerms = displayTerms.filter((term) =>
      searchableText.includes(term),
    );
    return {
      sysId,
      number: values.number || "",
      shortDescription: title,
      excerpt: matchingExcerpt(body, matchedTerms),
      knowledgeBase: values.kb_knowledge_base || "",
      category: values.kb_category || "",
      viewCount: Number.isFinite(viewCount) ? viewCount : null,
      published: values.published || "",
      updated: values.sys_updated_on || "",
      matchedTerms,
      recordUrl: `${instanceUrl}/nav_to.do?uri=${encodeURIComponent(
        `kb_knowledge.do?sys_id=${sysId}`,
      )}`,
    };
  });
}

/** Fetch a published knowledge article for the in-app reader. */
export async function getKnowledgeArticle(
  sysId: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<KnowledgeArticleDetail> {
  const instanceUrl = getInstanceUrl();
  const validatedSysId = validateSysId(sysId, "knowledge article sys_id");
  const params = new URLSearchParams({
    sysparm_display_value: "all",
    sysparm_fields:
      "sys_id,number,short_description,text,kb_knowledge_base,kb_category,published,sys_updated_on,active,workflow_state",
  });
  const response = await fetch(
    `${instanceUrl}/api/now/table/kb_knowledge/${validatedSysId}?${params}`,
    {
      method: "GET",
      headers: {
        ...extraHeaders,
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        "You do not have permission to read this knowledge article.",
      );
    }
    if (response.status === 404) {
      throw new Error("This knowledge article was not found.");
    }
    await response.text().catch(() => "");
    throw new Error(
      `Could not load knowledge article (ServiceNow returned ${response.status}).`,
    );
  }

  const data = await response.json();
  const raw: Record<string, unknown> = data.result || {};
  const active = normalizeValue(raw.active).value;
  const workflowState = normalizeValue(raw.workflow_state).value;
  if (!["true", "1"].includes(active) || workflowState !== "published") {
    throw new Error(
      "This knowledge article is not available (inactive or unpublished).",
    );
  }

  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    values[key] = normalizeValue(value).display;
  }
  const rawContent = normalizeValue(raw.text).value;
  const contentHtml = await embedKnowledgeImages(
    sanitizeKnowledgeContent(rawContent, instanceUrl),
    instanceUrl,
    accessToken,
    extraHeaders,
  );
  return {
    sysId: validatedSysId,
    number: values.number || "",
    shortDescription: values.short_description || "",
    content: knowledgeContentText(rawContent),
    contentHtml,
    knowledgeBase: values.kb_knowledge_base || "",
    category: values.kb_category || "",
    published: values.published || "",
    updated: values.sys_updated_on || "",
    recordUrl: `${instanceUrl}/nav_to.do?uri=${encodeURIComponent(
      `kb_knowledge.do?sys_id=${validatedSysId}`,
    )}`,
  };
}

/** Delete an attachment from ServiceNow. */
export async function deleteAttachment(
  table: string,
  tableSysId: string,
  sysId: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const instanceUrl = getInstanceUrl();
  const validatedAttachmentSysId = validateSysId(sysId, "attachment sys_id");
  await assertAttachmentBelongsToTicket(
    table,
    tableSysId,
    validatedAttachmentSysId,
    accessToken,
    extraHeaders,
  );
  const response = await fetch(
    `${instanceUrl}/api/now/attachment/${validatedAttachmentSysId}`,
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

async function assertAttachmentBelongsToTicket(
  table: string,
  tableSysId: string,
  attachmentSysId: string,
  accessToken: string,
  extraHeaders: Record<string, string>,
): Promise<void> {
  const validatedTable = validateTableName(table);
  const validatedTableSysId = validateSysId(tableSysId, "ticket sys_id");
  const validatedAttachmentSysId = validateSysId(
    attachmentSysId,
    "attachment sys_id",
  );
  const ticketAttachments = await getAttachments(
    validatedTable,
    validatedTableSysId,
    accessToken,
    extraHeaders,
  );
  if (
    !ticketAttachments.some(
      (attachment) => attachment.sysId === validatedAttachmentSysId,
    )
  ) {
    throw new Error("Attachment does not belong to the displayed ticket");
  }
}
