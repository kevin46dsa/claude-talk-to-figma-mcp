import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendCommandToFigma } from "../utils/websocket";
import { coerceJson } from "../utils/schema-helpers";
import { BATCH_MAX_OPS, validateBatchOperations } from "../utils/batch-utils";

/**
 * Register the batch tool: run many existing bridge commands in ONE request.
 * The plugin executes them in order inside a single queue slot and a single
 * undo step. Results of earlier operations can be referenced with "$id.path".
 */
export function registerBatchTools(server: McpServer): void {
  server.tool(
    "batch",
    `Run many Figma commands in ONE call (max ${BATCH_MAX_OPS}). Each operation is {id?, command, params}. ` +
      `Give an operation an id to reference its result in LATER operations with "$id" or "$id.path", ` +
      `e.g. create_frame with id "card", then create_text with parentId "$card.id". ` +
      `Text content ("text"/"characters") is never treated as a reference; use "$$x" to write a literal "$x" elsewhere. ` +
      `Creation commands still need a parentId (a $ref counts). x/y are frame-local (relative to the parent). ` +
      `onError "stop" (default) skips the rest after the first failure; "continue" runs everything. ` +
      `validateOnly checks the batch without touching the file. The whole batch is one undo step.`,
    {
      operations: coerceJson(
        z
          .array(
            z.object({
              id: z.string().optional().describe("Optional id other operations can reference as $id"),
              command: z.string().describe("Any plugin command name, e.g. create_rectangle, set_fill_color, move_node"),
              params: z.record(z.any()).optional().describe("Parameters of that command"),
            })
          )
          .min(1)
          .max(BATCH_MAX_OPS)
      ).describe(`1-${BATCH_MAX_OPS} operations`),
      onError: z.enum(["stop", "continue"]).optional().describe('What to do after a failure (default "stop")'),
      validateOnly: z.boolean().optional().describe("Validate only; create/change nothing"),
      verbose: z.boolean().optional().describe("Return full command results instead of id/name/size summaries"),
    },
    async ({ operations, onError, validateOnly, verbose }) => {
      const problems = validateBatchOperations(operations);
      if (problems.length) {
        return {
          content: [{ type: "text", text: `Batch rejected before sending (nothing was changed):\n- ${problems.join("\n- ")}` }],
        };
      }
      try {
        const result = (await sendCommandToFigma("batch", { operations, onError, validateOnly, verbose })) as {
          completed?: number;
          failed?: number;
          skipped?: number;
          results?: unknown[];
        };
        const head = validateOnly
          ? "Batch is valid (validateOnly, nothing was created)."
          : result.failed
            ? `Batch finished with errors: ${result.completed} ok, ${result.failed} failed, ${result.skipped ?? 0} skipped.`
            : `Batch finished: ${result.completed} operations ok.`;
        return { content: [{ type: "text", text: `${head}\n${JSON.stringify(result.results ?? result)}` }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error running batch: ${error instanceof Error ? error.message : String(error)}` +
                (String(error).includes("Unknown command: batch")
                  ? "\nThe Figma plugin is out of date: re-run the plugin (Plugins > Development) so it loads the new code."
                  : ""),
            },
          ],
        };
      }
    }
  );
}
