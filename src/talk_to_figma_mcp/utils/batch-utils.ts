/**
 * Pure helpers for the `batch` tool: reference resolution and validation.
 * The plugin (src/claude_mcp_plugin/code.js) mirrors resolveRefs; the unit tests
 * keep the two in step (tests/unit/utils/batch-utils.test.ts).
 */

export const BATCH_MAX_OPS = 200;

/**
 * Plugin commands that may run inside a batch. `batch` itself is excluded (no
 * nesting) and `ping` is pointless in a batch. A unit test checks this list
 * against the `case` labels of handleCommand in code.js.
 */
export const BATCHABLE_COMMANDS: readonly string[] = [
  "get_document_info",
  "get_selection",
  "get_node_info",
  "get_nodes_info",
  "create_rectangle",
  "create_frame",
  "create_text",
  "build_tree",
  "set_fill_color",
  "set_stroke_color",
  "set_selection_colors",
  "move_node",
  "resize_node",
  "delete_node",
  "get_styles",
  "get_local_components",
  "create_component_instance",
  "export_node_as_image",
  "set_corner_radius",
  "set_text_content",
  "clone_node",
  "scan_text_nodes",
  "set_multiple_text_contents",
  "set_auto_layout",
  "set_font_name",
  "set_font_size",
  "set_font_weight",
  "set_letter_spacing",
  "set_line_height",
  "set_paragraph_spacing",
  "set_text_case",
  "set_text_decoration",
  "set_text_align",
  "get_styled_text_segments",
  "load_font_async",
  "get_remote_components",
  "set_effects",
  "set_effect_style_id",
  "set_text_style_id",
  "group_nodes",
  "ungroup_nodes",
  "flatten_node",
  "insert_child",
  "create_ellipse",
  "create_polygon",
  "create_star",
  "create_vector",
  "create_line",
  "create_component_from_node",
  "create_component_set",
  "set_instance_variant",
  "create_page",
  "delete_page",
  "rename_page",
  "get_pages",
  "set_current_page",
  "rename_node",
  "set_image_fill",
  "get_image_from_node",
  "replace_image_fill",
  "apply_image_transform",
  "set_image_filters",
  "rotate_node",
  "set_node_properties",
  "reorder_node",
  "duplicate_page",
  "convert_to_frame",
  "set_gradient",
  "boolean_operation",
  "set_svg",
  "get_svg",
  "set_image",
  "set_grid",
  "get_grid",
  "set_guide",
  "get_guide",
  "set_annotation",
  "get_annotation",
  "get_variables",
  "set_variable",
  "apply_variable_to_node",
  "switch_variable_mode",
  "get_figjam_elements",
  "create_sticky",
  "set_sticky_text",
  "create_shape_with_text",
  "create_connector",
  "create_section",
  "set_reactions",
  "get_reactions",
  "detach_instance",
  "create_text_style",
  "create_paint_style",
  "create_effect_style",
];

/** Creation commands that must name a parent (same rule as src/socket.ts). */
export const PARENT_REQUIRED_COMMANDS: ReadonlySet<string> = new Set([
  "create_rectangle", "create_frame", "create_text", "create_ellipse",
  "create_polygon", "create_star", "create_vector", "create_line",
  "create_component_instance", "create_component_set", "set_svg",
  "clone_node", "create_component_from_node",
  "create_section", "create_sticky", "create_shape_with_text", "create_connector",
]);

/**
 * "$name" or "$name.path.to.value". Ids start with a letter or underscore so
 * money strings such as "$20.00" are never mistaken for references.
 */
export const REF_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_-]*)((?:\.[A-Za-z0-9_-]+)*)$/;

/** Param keys whose string values are literal content, never references. */
const REF_SKIP_KEYS: ReadonlySet<string> = new Set(["text", "characters"]);

const OP_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export interface BatchOperation {
  id?: string;
  command: string;
  params?: Record<string, unknown>;
}

export function parseRef(value: unknown, key?: string): { id: string; path: string[] } | null {
  if (typeof value !== "string" || (key && REF_SKIP_KEYS.has(key))) return null;
  const m = REF_PATTERN.exec(value);
  if (!m) return null;
  return { id: m[1], path: m[2] ? m[2].slice(1).split(".") : [] };
}

/** Replaces reference strings with values from earlier results. Throws on unknown ids/paths. */
export function resolveRefs(value: unknown, byId: Record<string, unknown>, key?: string): unknown {
  if (typeof value === "string") {
    if (key && REF_SKIP_KEYS.has(key)) return value;
    if (value.startsWith("$$")) return value.slice(1); // "$$x" escapes a literal "$x"
    const ref = parseRef(value, key);
    if (!ref) return value;
    if (!Object.prototype.hasOwnProperty.call(byId, ref.id)) {
      throw new Error(`Unknown reference: ${value} (no earlier operation with id '${ref.id}')`);
    }
    let cur: any = byId[ref.id];
    for (const part of ref.path) {
      if (cur === null || cur === undefined || typeof cur !== "object" || !(part in cur)) {
        throw new Error(`Reference path not found: ${value}`);
      }
      cur = cur[part];
    }
    return cur;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, byId));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object)) out[k] = resolveRefs((value as any)[k], byId, k);
    return out;
  }
  return value;
}

function collectRefIds(value: unknown, key: string | undefined, into: string[]): void {
  const ref = parseRef(value, key);
  if (ref) {
    into.push(ref.id);
    return;
  }
  if (Array.isArray(value)) value.forEach((v) => collectRefIds(v, undefined, into));
  else if (value && typeof value === "object") {
    for (const k of Object.keys(value as object)) collectRefIds((value as any)[k], k, into);
  }
}

/** Returns a list of human-readable problems; empty means the batch is structurally valid. */
export function validateBatchOperations(ops: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(ops) || ops.length === 0) return ["operations must be a non-empty array"];
  if (ops.length > BATCH_MAX_OPS) return [`Too many operations: ${ops.length} (max ${BATCH_MAX_OPS})`];

  const known = new Set(BATCHABLE_COMMANDS);
  const defined = new Set<string>();

  ops.forEach((op: any, i: number) => {
    const label = `Operation ${i}${op && op.id ? ` ('${op.id}')` : ""}`;
    if (!op || typeof op !== "object" || typeof op.command !== "string") {
      errors.push(`${label}: missing command`);
      return;
    }
    if (op.command === "batch") errors.push(`${label}: batch cannot be nested`);
    else if (!known.has(op.command)) errors.push(`${label}: unknown or unsupported command '${op.command}'`);

    const params = op.params ?? {};
    if (PARENT_REQUIRED_COMMANDS.has(op.command) && !params.parentId) {
      errors.push(`${label}: '${op.command}' requires a parentId (a $ref to an earlier operation is fine)`);
    }

    const refs: string[] = [];
    collectRefIds(params, undefined, refs);
    refs.forEach((id) => {
      if (!defined.has(id)) errors.push(`${label}: references '$${id}' which is not defined by an earlier operation`);
    });

    if (op.id !== undefined) {
      if (typeof op.id !== "string" || !OP_ID_PATTERN.test(op.id)) {
        errors.push(`${label}: id must start with a letter/underscore and use only letters, digits, _ or -`);
      } else if (defined.has(op.id)) {
        errors.push(`${label}: duplicate id '${op.id}'`);
      } else {
        defined.add(op.id);
      }
    }
  });
  return errors;
}
