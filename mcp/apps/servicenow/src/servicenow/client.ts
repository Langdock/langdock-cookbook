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

/** One comment or work-note entry from the record's activity stream. */
export interface ActivityEntry {
  field: "comments" | "work_notes";
  value: string;
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
