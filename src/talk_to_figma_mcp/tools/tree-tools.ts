import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendCommandToFigma } from "../utils/websocket";
import { coerceJson } from "../utils/schema-helpers";
import { TREE_MAX_DEPTH, TREE_MAX_NODES, normalizeTree, validateTree, TreeNodeInput } from "../utils/tree-utils";

const TREE_DESCRIPTION =
  `Build a whole card/section/screen from ONE nested spec instead of many create_* calls. ` +
  `Node: {type: "frame"|"rectangle"|"text"|"ellipse"|"instance", name?, width?, height? (number | "fill" | "hug"), ` +
  `fill?, stroke? ("#rrggbb" or {r,g,b,a} 0-1), strokeWeight?, cornerRadius?, opacity?, ` +
  `layout?: {mode: "VERTICAL"|"HORIZONTAL"|"NONE", gap?, padding? (number | [v,h] | [t,r,b,l]), align?, crossAlign? ("start"|"center"|"end"|"space-between"), wrap?}, ` +
  `clipsContent?, children?: Node[], ` +
  `text nodes: text, fontSize?, fontWeight?, fontColor?, textAlign? ("left"|"center"|"right"), lineHeight?, letterSpacing?, maxWidth?}. ` +
  `instance nodes place a LOCAL component: {type:"instance", component:"Button/Primary" (name, key or id), overrides?:{"Label":"Submit"} (text by layer name), hide?:["Subtitle"], width?/height?}. ` +
  `"fill" needs an auto-layout parent; "hug" needs an auto-layout frame (or text). ` +
  `Children of an auto-layout frame are positioned automatically, so no x/y arithmetic. ` +
  `Limits: depth ${TREE_MAX_DEPTH}, ${TREE_MAX_NODES} nodes. Everything is created or nothing is (a failure removes the partial tree).`;

/**
 * Register the build_tree tool.
 */
export function registerTreeTools(server: McpServer): void {
  server.tool(
    "build_tree",
    TREE_DESCRIPTION,
    {
      parentId: z
        .string()
        .describe("Parent node ID (page or frame) the root node is created in. Required."),
      tree: coerceJson(z.record(z.any())).describe("The root node of the tree (see tool description)"),
      x: z.coerce.number().optional().describe("X of the root, frame-local to the parent"),
      y: z.coerce.number().optional().describe("Y of the root, frame-local to the parent"),
    },
    async ({ parentId, tree, x, y }) => {
      const problems = validateTree(tree);
      if (problems.length) {
        return {
          content: [{ type: "text", text: `build_tree rejected before sending (nothing was created):\n- ${problems.join("\n- ")}` }],
        };
      }
      try {
        const result = (await sendCommandToFigma("build_tree", {
          parentId,
          tree: normalizeTree(tree as unknown as TreeNodeInput),
          x,
          y,
        })) as { rootId: string; ids: Record<string, string>; nodeCount: number };
        return {
          content: [
            {
              type: "text",
              text: `Built ${result.nodeCount} nodes. rootId: ${result.rootId}. Named node ids: ${JSON.stringify(result.ids)}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error building tree: ${error instanceof Error ? error.message : String(error)}` +
                (String(error).includes("Unknown command: build_tree")
                  ? "\nThe Figma plugin is out of date: re-run the plugin (Plugins > Development) so it loads the new code."
                  : ""),
            },
          ],
        };
      }
    }
  );
}
