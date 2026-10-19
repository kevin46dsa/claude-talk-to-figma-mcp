import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendCommandToFigma } from "../utils/websocket";
import { coerceJson } from "../utils/schema-helpers";

const STALE_PLUGIN_HINT =
  "\nThe Figma plugin is out of date: re-run the plugin (Plugins > Development) so it loads the new code.";

function errorText(prefix: string, error: unknown, command: string) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text" as const,
        text: `${prefix}: ${message}${message.includes(`Unknown command: ${command}`) ? STALE_PLUGIN_HINT : ""}`,
      },
    ],
  };
}

/**
 * Component instances, viewport focus and frame listing (v1.2.0).
 */
export function registerLibraryTools(server: McpServer): void {
  server.tool(
    "instantiate",
    "Create an instance of a LOCAL component and override its text by layer name, in one call. " +
      "`component` is the component key, id or exact name (e.g. 'Button/Primary'). " +
      "`overrides` maps a text layer name to its new text, e.g. {\"Label\": \"Submit\"}; " +
      "`hide` lists layer names to hide (e.g. [\"Subtitle\"]). " +
      "Use layoutSizingHorizontal/Vertical FILL or HUG when the parent is an auto-layout frame. " +
      "x/y are parent-local. For many instances prefer build_tree with {type:'instance'} nodes.",
    {
      component: z.string().describe("Component key, id or exact name"),
      parentId: z.string().describe("Parent node ID (page, section or frame). Required."),
      x: z.coerce.number().optional().describe("X, parent-local (ignored inside auto-layout)"),
      y: z.coerce.number().optional().describe("Y, parent-local (ignored inside auto-layout)"),
      name: z.string().optional().describe("Layer name for the instance"),
      width: z.coerce.number().positive().optional().describe("Resize the instance to this width"),
      height: z.coerce.number().positive().optional().describe("Resize the instance to this height"),
      layoutSizingHorizontal: z.enum(["FIXED", "HUG", "FILL"]).optional(),
      layoutSizingVertical: z.enum(["FIXED", "HUG", "FILL"]).optional(),
      overrides: coerceJson(z.record(z.string())).optional().describe("Text overrides by layer name"),
      hide: coerceJson(z.array(z.string())).optional().describe("Layer names to hide"),
    },
    async (params) => {
      try {
        const result = (await sendCommandToFigma("instantiate", params)) as { id: string; name: string; component: string };
        return {
          content: [{ type: "text", text: `Created instance "${result.name}" of ${result.component} with ID: ${result.id}` }],
        };
      } catch (error) {
        return errorText("Error creating instance", error, "instantiate");
      }
    }
  );

  server.tool(
    "focus_node",
    "Scroll and zoom the Figma canvas to a node (frame, section, page element) and select it, switching page if needed. " +
      "Use this to show the user a specific section or frame.",
    { nodeId: z.string().describe("Node to focus") },
    async ({ nodeId }) => {
      try {
        const result = (await sendCommandToFigma("focus_node", { nodeId })) as { name: string; type: string; id: string };
        return { content: [{ type: "text", text: `Focused ${result.type} "${result.name}" (${result.id})` }] };
      } catch (error) {
        return errorText("Error focusing node", error, "focus_node");
      }
    }
  );

  server.tool(
    "list_frames",
    "List the children of a node (default: the current page) with canvas x/y, size, type and child count. " +
      "depth 1-3 also lists nested children (e.g. frames inside sections). Optionally filter by node types.",
    {
      parentId: z.string().optional().describe("Node to list (default: current page)"),
      depth: z.coerce.number().int().min(1).max(3).optional().describe("Levels to include (default 1)"),
      types: coerceJson(z.array(z.string())).optional().describe('Only these types, e.g. ["FRAME","SECTION","COMPONENT"]'),
    },
    async ({ parentId, depth, types }) => {
      try {
        const result = (await sendCommandToFigma("list_frames", { parentId, depth, types })) as { count: number; nodes: unknown[] };
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return errorText("Error listing frames", error, "list_frames");
      }
    }
  );
}
