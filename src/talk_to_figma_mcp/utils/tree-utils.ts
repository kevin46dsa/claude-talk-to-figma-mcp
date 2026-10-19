/**
 * Pure helpers for the `build_tree` tool: validation and normalisation of the
 * nested spec into the flat, plugin-ready node format that
 * buildTree() in src/claude_mcp_plugin/code.js consumes.
 */

export const TREE_MAX_DEPTH = 8;
export const TREE_MAX_NODES = 300;

export type TreeNodeType = "frame" | "rectangle" | "text" | "ellipse" | "instance";
const NODE_TYPES: readonly string[] = ["frame", "rectangle", "text", "ellipse", "instance"];

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a?: number;
}

/** Friendly spec as written by the caller. */
export interface TreeNodeInput {
  type: TreeNodeType;
  name?: string;
  x?: number;
  y?: number;
  width?: number | "fill" | "hug";
  height?: number | "fill" | "hug";
  fill?: string | Rgba;
  stroke?: string | Rgba;
  strokeWeight?: number;
  cornerRadius?: number | { topLeft?: number; topRight?: number; bottomRight?: number; bottomLeft?: number };
  opacity?: number;
  layout?: {
    mode?: "HORIZONTAL" | "VERTICAL" | "NONE";
    gap?: number;
    padding?: number | number[];
    align?: string;
    crossAlign?: string;
    wrap?: boolean;
  };
  clipsContent?: boolean;
  children?: TreeNodeInput[];
  // text
  text?: string;
  fontSize?: number;
  fontWeight?: number;
  fontColor?: string | Rgba;
  textAlign?: string;
  lineHeight?: number;
  letterSpacing?: number;
  textCase?: string;
  textDecoration?: string;
  maxWidth?: number;
  // instance (local component)
  component?: string;
  overrides?: Record<string, string>;
  hide?: string[];
}

/** Normalised node sent to the plugin. */
export interface PluginTreeNode {
  type: TreeNodeType;
  name?: string;
  x?: number;
  y?: number;
  width?: number | "fill" | "hug";
  height?: number | "fill" | "hug";
  fillColor?: Rgba;
  strokeColor?: Rgba;
  strokeWeight?: number;
  cornerRadius?: TreeNodeInput["cornerRadius"];
  opacity?: number;
  layoutMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  layoutWrap?: string;
  clipsContent?: boolean;
  children?: PluginTreeNode[];
  text?: string;
  fontSize?: number;
  fontWeight?: number;
  fontColor?: Rgba;
  textAlignHorizontal?: string;
  lineHeight?: number;
  letterSpacing?: number;
  textCase?: string;
  textDecoration?: string;
  textAutoResize?: string;
  component?: string;
  overrides?: Record<string, string>;
  hide?: string[];
}

/** "#rgb", "#rrggbb" or "#rrggbbaa" -> {r,g,b,a} with 0-1 channels. Returns null if invalid. */
export function hexToColor(hex: string): Rgba | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

export function normalizeColor(value: unknown): Rgba | null {
  if (typeof value === "string") return hexToColor(value);
  if (value && typeof value === "object") {
    const { r, g, b, a } = value as Record<string, unknown>;
    if ([r, g, b].every((c) => typeof c === "number" && c >= 0 && c <= 1)) {
      return { r: r as number, g: g as number, b: b as number, a: typeof a === "number" ? a : 1 };
    }
  }
  return null;
}

const ALIGN: Record<string, string> = {
  start: "MIN", center: "CENTER", end: "MAX", "space-between": "SPACE_BETWEEN",
  MIN: "MIN", CENTER: "CENTER", MAX: "MAX", SPACE_BETWEEN: "SPACE_BETWEEN",
};

function mapAlign(value: string | undefined): string | undefined {
  return value === undefined ? undefined : ALIGN[value];
}

export function expandPadding(padding: number | number[] | undefined):
  { top: number; right: number; bottom: number; left: number } | null {
  if (padding === undefined) return null;
  if (typeof padding === "number") return { top: padding, right: padding, bottom: padding, left: padding };
  if (padding.length === 1) return expandPadding(padding[0]);
  if (padding.length === 2) return { top: padding[0], bottom: padding[0], right: padding[1], left: padding[1] };
  if (padding.length === 4) return { top: padding[0], right: padding[1], bottom: padding[2], left: padding[3] };
  return null;
}

export function countTree(node: TreeNodeInput, depth = 1): { count: number; depth: number } {
  let count = 1;
  let maxDepth = depth;
  for (const child of node.children ?? []) {
    const c = countTree(child, depth + 1);
    count += c.count;
    maxDepth = Math.max(maxDepth, c.depth);
  }
  return { count, depth: maxDepth };
}

function isAutoLayout(node: TreeNodeInput): boolean {
  return node.type === "frame" && !!node.layout?.mode && node.layout.mode !== "NONE";
}

function validateDim(value: unknown, label: string, errors: string[], path: string): void {
  if (value === undefined || value === "fill" || value === "hug") return;
  if (typeof value !== "number" || !(value > 0)) {
    errors.push(`${path}: ${label} must be a positive number, "fill" or "hug"`);
  }
}

/** Returns human-readable problems; empty means the tree is valid. */
export function validateTree(root: unknown): string[] {
  const errors: string[] = [];
  if (!root || typeof root !== "object" || Array.isArray(root)) return ["tree must be an object"];

  const { count, depth } = countTree(root as TreeNodeInput);
  if (depth > TREE_MAX_DEPTH) errors.push(`Tree too deep: ${depth} levels (max ${TREE_MAX_DEPTH})`);
  if (count > TREE_MAX_NODES) errors.push(`Tree too large: ${count} nodes (max ${TREE_MAX_NODES})`);
  if (errors.length) return errors;

  const walk = (node: TreeNodeInput, path: string, parentAuto: boolean | null) => {
    if (!node || typeof node !== "object") {
      errors.push(`${path}: must be an object`);
      return;
    }
    if (!NODE_TYPES.includes(node.type)) {
      errors.push(`${path}: type must be one of ${NODE_TYPES.join(", ")} (got ${JSON.stringify(node.type)})`);
      return;
    }
    if (node.type === "text" && typeof node.text !== "string") errors.push(`${path}: text node needs a text string`);
    if (node.type === "instance" && (typeof node.component !== "string" || !node.component)) {
      errors.push(`${path}: instance node needs a component (key, id or exact name, e.g. "Button/Primary")`);
    }
    if (node.type !== "frame" && node.children?.length) errors.push(`${path}: only frames can have children`);

    validateDim(node.width, "width", errors, path);
    validateDim(node.height, "height", errors, path);

    for (const [key, v] of [["fill", node.fill], ["stroke", node.stroke], ["fontColor", node.fontColor]] as const) {
      if (v !== undefined && !normalizeColor(v)) errors.push(`${path}: ${key} is not a valid color (use "#rrggbb" or {r,g,b,a} with 0-1 values)`);
    }

    // fill needs an auto-layout parent; the root's parent is unknown so it is allowed
    for (const dim of ["width", "height"] as const) {
      if (node[dim] === "fill" && parentAuto === false) {
        errors.push(`${path}: ${dim} "fill" needs an auto-layout parent frame (set layout.mode on the parent)`);
      }
      if (node[dim] === "hug" && node.type !== "text" && node.type !== "instance" && !isAutoLayout(node)) {
        errors.push(`${path}: ${dim} "hug" needs this node to be a frame with layout.mode HORIZONTAL or VERTICAL (or a text node)`);
      }
    }

    if (node.layout?.padding !== undefined && !expandPadding(node.layout.padding)) {
      errors.push(`${path}: layout.padding must be a number or an array of 1, 2 or 4 numbers`);
    }
    for (const key of ["align", "crossAlign"] as const) {
      const v = node.layout?.[key];
      if (v !== undefined && !ALIGN[v]) errors.push(`${path}: layout.${key} must be start|center|end|space-between`);
    }

    (node.children ?? []).forEach((child, i) =>
      walk(child, `${path}.children[${i}]`, isAutoLayout(node)));
  };
  walk(root as TreeNodeInput, "root", null);
  return errors;
}

/** Converts a validated friendly tree into the plugin format. */
export function normalizeTree(node: TreeNodeInput): PluginTreeNode {
  const out: PluginTreeNode = { type: node.type };
  const copy = <K extends keyof PluginTreeNode>(key: K, value: PluginTreeNode[K] | undefined) => {
    if (value !== undefined) out[key] = value;
  };

  copy("name", node.name);
  copy("x", node.x);
  copy("y", node.y);
  copy("width", node.width);
  copy("height", node.height);
  copy("strokeWeight", node.strokeWeight);
  copy("cornerRadius", node.cornerRadius);
  copy("opacity", node.opacity);
  if (node.fill !== undefined) out.fillColor = normalizeColor(node.fill) ?? undefined;
  if (node.stroke !== undefined) out.strokeColor = normalizeColor(node.stroke) ?? undefined;

  if (node.type === "frame") {
    if (node.layout) {
      copy("layoutMode", node.layout.mode);
      copy("itemSpacing", node.layout.gap);
      const pad = expandPadding(node.layout.padding);
      if (pad) {
        out.paddingTop = pad.top;
        out.paddingRight = pad.right;
        out.paddingBottom = pad.bottom;
        out.paddingLeft = pad.left;
      }
      copy("primaryAxisAlignItems", mapAlign(node.layout.align));
      copy("counterAxisAlignItems", mapAlign(node.layout.crossAlign));
      if (node.layout.wrap !== undefined) out.layoutWrap = node.layout.wrap ? "WRAP" : "NO_WRAP";
    }
    copy("clipsContent", node.clipsContent);
  }

  if (node.type === "text") {
    copy("text", node.text);
    copy("fontSize", node.fontSize);
    copy("fontWeight", node.fontWeight);
    if (node.fontColor !== undefined) out.fontColor = normalizeColor(node.fontColor) ?? undefined;
    if (node.textAlign) out.textAlignHorizontal = node.textAlign.toUpperCase();
    copy("lineHeight", node.lineHeight);
    copy("letterSpacing", node.letterSpacing);
    copy("textCase", node.textCase);
    copy("textDecoration", node.textDecoration);
    // maxWidth makes the text wrap at that width
    if (node.maxWidth !== undefined && node.width === undefined) out.width = node.maxWidth;
  }

  if (node.type === "instance") {
    copy("component", node.component);
    copy("overrides", node.overrides);
    copy("hide", node.hide);
  }

  if (node.children?.length) out.children = node.children.map(normalizeTree);
  return out;
}
