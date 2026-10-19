#!/usr/bin/env node
/**
 * End-to-end smoke test for batch / build_tree / new create_* params.
 * Talks to the relay directly (same protocol as the MCP server) so it does not
 * need a Claude Code restart, but it DOES need the updated plugin to be running
 * in Figma (re-run the plugin after pulling these changes).
 *
 *   node scripts/smoke-batch-tree.mjs <channel> [pageId=0:1]
 *
 * Creates one scratch frame "bridge-smoke-test" at x=20000 on the page and
 * removes it at the end (also on failure).
 */
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const channel = process.argv[2];
const pageId = process.argv[3] || "0:1";
if (!channel) {
  console.error("usage: node scripts/smoke-batch-tree.mjs <channel> [pageId]");
  process.exit(2);
}

const ws = new WebSocket("ws://localhost:3055");
const pending = new Map();
const sessionId = randomUUID();
let calls = 0;

ws.on("message", (raw) => {
  let json;
  try { json = JSON.parse(raw); } catch { return; }
  if (json.type === "progress_update" || json.type === "queue_position") return;
  const msg = json.message;
  if (!msg || typeof msg !== "object" || msg.command || !msg.id || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  const error = msg.error ?? (msg.result && msg.result.error);
  error ? reject(new Error(String(error))) : resolve(msg.result ?? msg);
});

const open = new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

function send(command, params = {}, timeoutMs = 60000) {
  const id = randomUUID();
  calls++;
  const req = command === "join"
    ? { id, type: "join", channel: params.channel, sessionId, message: { id, command, params: { ...params, commandId: id } } }
    : { id, type: "message", channel, message: { id, command, params: { ...params, commandId: id } } };
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${command}`)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    ws.send(JSON.stringify(req));
  });
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let scratchId = null;
try {
  await open;
  send("join", { channel }).catch(() => {});
  await sleep(800);

  // 1. plugin version (proves the new plugin code is loaded)
  const ping = await send("ping");
  check("plugin reports version >= 1.1.0", ping.version >= "1.1.0", JSON.stringify(ping));
  if (!(ping.version >= "1.1.0")) throw new Error("Plugin is stale: re-run it in Figma, then run this again");

  // 2. scratch frame
  const scratch = await send("create_frame", { x: 20000, y: 0, width: 800, height: 600, name: "bridge-smoke-test", parentId: pageId });
  scratchId = scratch.id;
  check("create_frame scratch", !!scratchId, scratchId);

  // 3. new params on a single create call
  const rect = await send("create_rectangle", { x: 10, y: 10, width: 100, height: 40, name: "r", parentId: scratchId,
    fillColor: { r: 0.07, g: 0.72, b: 0.53 }, cornerRadius: 8, opacity: 0.5 });
  const rectInfo = await send("get_node_info", { nodeId: rect.id });
  check("rectangle cornerRadius + opacity in one call", rectInfo.cornerRadius === 8 && rectInfo.opacity === 0.5,
    `cornerRadius=${rectInfo.cornerRadius} opacity=${rectInfo.opacity}`);

  const text = await send("create_text", { x: 10, y: 60, text: "Lh", parentId: scratchId, fontSize: 14, lineHeight: 28 });
  const textInfo = await send("get_node_info", { nodeId: text.id });
  const lh = textInfo.style && textInfo.style.lineHeightPx;
  check("text lineHeight 28", Math.round(lh) === 28, `lineHeightPx=${lh}`);

  const autoFrame = await send("create_frame", { x: 10, y: 100, width: 300, height: 200, name: "auto", parentId: scratchId,
    layoutMode: "VERTICAL", itemSpacing: 8, paddingTop: 16, paddingBottom: 16, paddingLeft: 16, paddingRight: 16 });
  const autoInfo = await send("get_node_info", { nodeId: autoFrame.id });
  check("frame auto-layout at creation", autoInfo.layoutMode === "VERTICAL" && autoInfo.itemSpacing === 8 && autoInfo.paddingLeft === 16,
    `layoutMode=${autoInfo.layoutMode} gap=${autoInfo.itemSpacing} padL=${autoInfo.paddingLeft}`);

  // 4. batch with references
  const batch = await send("batch", { operations: [
    { id: "card", command: "create_frame", params: { x: 400, y: 10, width: 200, height: 120, name: "batch-card", parentId: scratchId } },
    { id: "label", command: "create_text", params: { x: 8, y: 8, text: "$20.00", parentId: "$card.id" } },
    { command: "create_rectangle", params: { x: 8, y: 40, width: 50, height: 10, parentId: "$card.id" } },
    { command: "move_node", params: { nodeId: "$label.id", x: 12, y: 12 } },
  ] });
  check("batch ran 4 ops", batch.completed === 4 && batch.failed === 0, JSON.stringify({ c: batch.completed, f: batch.failed }));
  const labelNode = await send("get_node_info", { nodeId: batch.results[1].result.id });
  check("batch ref resolved + text '$20.00' kept literal", labelNode.characters === "$20.00", labelNode.characters);

  // 5. batch error handling
  const stopBatch = await send("batch", { operations: [
    { command: "create_rectangle", params: { x: 0, y: 0, width: 5, height: 5, parentId: scratchId } },
    { command: "set_fill_color", params: { nodeId: "does-not-exist", color: { r: 1, g: 0, b: 0 } } },
    { command: "create_rectangle", params: { x: 0, y: 0, width: 5, height: 5, parentId: scratchId } },
  ] });
  check("batch onError=stop: 1 ok, 1 failed, 1 skipped", stopBatch.completed === 1 && stopBatch.failed === 1 && stopBatch.skipped === 1,
    JSON.stringify({ c: stopBatch.completed, f: stopBatch.failed, s: stopBatch.skipped }));
  const contBatch = await send("batch", { onError: "continue", operations: [
    { command: "set_fill_color", params: { nodeId: "nope", color: { r: 1, g: 0, b: 0 } } },
    { command: "create_rectangle", params: { x: 0, y: 0, width: 5, height: 5, parentId: scratchId } },
  ] });
  check("batch onError=continue runs the rest", contBatch.completed === 1 && contBatch.failed === 1 && contBatch.skipped === 0);
  const unknownRef = await send("batch", { operations: [{ command: "move_node", params: { nodeId: "$ghost.id", x: 0, y: 0 } }] });
  check("batch unknown $ref fails that op cleanly", unknownRef.failed === 1 && /Unknown reference/.test(unknownRef.results[0].error), unknownRef.results[0].error);
  const dry = await send("batch", { validateOnly: true, operations: [{ command: "create_frame", params: { parentId: scratchId } }] });
  check("batch validateOnly creates nothing", dry.validateOnly === true);

  // 6. build_tree
  const tree = await send("build_tree", { parentId: scratchId, x: 20, y: 320, tree: {
    type: "frame", name: "Card", width: 312, height: "hug", fillColor: { r: 1, g: 1, b: 1 }, strokeColor: { r: 0.87, g: 0.87, b: 0.87 },
    cornerRadius: 8, layoutMode: "VERTICAL", itemSpacing: 4, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16,
    children: [
      { type: "text", name: "Label", text: "Total Expenses", fontSize: 13 },
      { type: "text", name: "Value", text: "$4,481.80", fontSize: 28, fontWeight: 700 },
      { type: "text", name: "Delta", text: "vs Sep", fontSize: 12, width: "fill" },
    ] } });
  check("build_tree KPI card = 4 nodes in 1 call", tree.nodeCount === 4 && !!tree.ids.Card && !!tree.ids.Value, JSON.stringify(tree.ids));
  const cardInfo = await send("get_node_info", { nodeId: tree.rootId });
  check("hug height computed (auto-layout)", cardInfo.absoluteBoundingBox.height > 60 && cardInfo.absoluteBoundingBox.height < 160,
    `height=${cardInfo.absoluteBoundingBox.height}`);

  // 7. build_tree rollback on failure ("fill" with a non-auto-layout parent)
  const before = (await send("get_node_info", { nodeId: scratchId })).children.length;
  let failed = false;
  try {
    await send("build_tree", { parentId: scratchId, tree: { type: "frame", name: "BadTree", width: 100, height: 100,
      children: [{ type: "rectangle", name: "bad", width: "fill", height: 10 }] } });
  } catch (e) { failed = /partial tree removed/.test(e.message); }
  const after = (await send("get_node_info", { nodeId: scratchId })).children.length;
  check("build_tree failure rolls back (no orphan root)", failed && before === after, `children before=${before} after=${after}`);
  // 8. components: instantiate with text overrides by layer name (needs plugin >= 1.2.0)
  if (ping.version >= "1.2.0") {
    const btn = await send("build_tree", { parentId: scratchId, x: 500, y: 320, tree: { type: "frame", name: "SmokeButton", width: "hug", height: 36,
      fillColor: { r: 0.07, g: 0.72, b: 0.53 }, layoutMode: "HORIZONTAL", paddingLeft: 16, paddingRight: 16,
      children: [{ type: "text", name: "Label", text: "Button", fontSize: 14, fontWeight: 600 }] } });
    const comp = await send("create_component_from_node", { nodeId: btn.rootId, name: "Smoke/Button", parentId: scratchId });
    const inst = await send("instantiate", { component: "Smoke/Button", parentId: scratchId, x: 500, y: 400, overrides: { Label: "Submit payment" } });
    const instInfo = await send("get_node_info", { nodeId: inst.id });
    const labelText = JSON.stringify(instInfo).includes("Submit payment");
    check("instantiate by name + text override by layer name", labelText, inst.component);
    let badLayer = false;
    try { await send("instantiate", { component: "Smoke/Button", parentId: scratchId, overrides: { Nope: "x" } }); } catch (e) { badLayer = /No text layer named/.test(e.message); }
    check("instantiate with a wrong layer name fails and leaves nothing", badLayer);
    const tree2 = await send("build_tree", { parentId: scratchId, x: 20, y: 500, tree: { type: "frame", name: "WithInstance", width: 300, height: "hug",
      layoutMode: "VERTICAL", itemSpacing: 8, paddingTop: 8, paddingBottom: 8, paddingLeft: 8, paddingRight: 8,
      children: [{ type: "instance", name: "Btn", component: "Smoke/Button", overrides: { Label: "Via tree" }, width: "fill" }] } });
    check("build_tree instance node with fill width", tree2.nodeCount === 2, JSON.stringify(tree2.ids));
    const listed = await send("list_frames", { parentId: scratchId, types: ["FRAME", "COMPONENT"] });
    check("list_frames returns nodes with sizes", listed.count >= 3 && typeof listed.nodes[0].width === "number", `count=${listed.count}`);
    const focused = await send("focus_node", { nodeId: scratchId });
    check("focus_node selects + zooms", focused.id === scratchId, `zoom=${focused.zoom}`);
  }
} catch (error) {
  failures++;
  console.error("ERROR", error.message);
} finally {
  if (scratchId) {
    try { await send("delete_node", { nodeId: scratchId }); console.log("cleaned up scratch frame"); }
    catch (e) { console.error("cleanup failed — delete 'bridge-smoke-test' manually:", e.message); }
  }
  console.log(`\n${calls} bridge calls, ${failures} failure(s)`);
  ws.close();
  process.exit(failures ? 1 : 0);
}
