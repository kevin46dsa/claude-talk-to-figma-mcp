import * as fs from 'fs';
import * as path from 'path';
import {
  BATCH_MAX_OPS,
  BATCHABLE_COMMANDS,
  parseRef,
  resolveRefs,
  validateBatchOperations,
} from '../../../src/talk_to_figma_mcp/utils/batch-utils';

const pluginSource = fs.readFileSync(
  path.join(__dirname, '../../../src/claude_mcp_plugin/code.js'),
  'utf8'
);

describe('batch-utils', () => {
  describe('parseRef', () => {
    it('parses $id and $id.path', () => {
      expect(parseRef('$card')).toEqual({ id: 'card', path: [] });
      expect(parseRef('$card.id')).toEqual({ id: 'card', path: ['id'] });
      expect(parseRef('$card.absoluteBoundingBox.x')).toEqual({
        id: 'card',
        path: ['absoluteBoundingBox', 'x'],
      });
    });

    it('never treats money or plain strings as references', () => {
      expect(parseRef('$20.00')).toBeNull();
      expect(parseRef('$4,481.80')).toBeNull();
      expect(parseRef('$100')).toBeNull();
      expect(parseRef('hello')).toBeNull();
      expect(parseRef('')).toBeNull();
      expect(parseRef(42)).toBeNull();
    });

    it('ignores literal-content keys', () => {
      expect(parseRef('$card', 'text')).toBeNull();
      expect(parseRef('$card', 'characters')).toBeNull();
    });
  });

  describe('resolveRefs', () => {
    const byId = { card: { id: '1:2', box: { x: 10 } }, n: 5 };

    it('resolves whole results and dotted paths', () => {
      expect(resolveRefs('$card', byId)).toEqual(byId.card);
      expect(resolveRefs('$card.id', byId)).toBe('1:2');
      expect(resolveRefs('$card.box.x', byId)).toBe(10);
      expect(resolveRefs('$n', byId)).toBe(5);
    });

    it('resolves recursively through objects and arrays', () => {
      expect(resolveRefs({ parentId: '$card.id', list: ['$card.id', 'x'], deep: { v: '$n' } }, byId)).toEqual({
        parentId: '1:2',
        list: ['1:2', 'x'],
        deep: { v: 5 },
      });
    });

    it('leaves non-reference values untouched', () => {
      expect(resolveRefs({ a: 1, b: true, c: null, d: '$20.00' }, byId)).toEqual({ a: 1, b: true, c: null, d: '$20.00' });
    });

    it('never rewrites text content', () => {
      expect(resolveRefs({ text: '$card', characters: '$card.id' }, byId)).toEqual({ text: '$card', characters: '$card.id' });
    });

    it('unescapes $$ to a literal $', () => {
      expect(resolveRefs({ name: '$$card' }, byId)).toEqual({ name: '$card' });
    });

    it('throws on unknown ids and missing paths', () => {
      expect(() => resolveRefs('$nope', byId)).toThrow(/Unknown reference/);
      expect(() => resolveRefs('$card.missing', byId)).toThrow(/path not found/);
      expect(() => resolveRefs('$n.deeper', byId)).toThrow(/path not found/);
    });
  });

  describe('validateBatchOperations', () => {
    const ok = [
      { id: 'card', command: 'create_frame', params: { parentId: '0:1', x: 0, y: 0, width: 10, height: 10 } },
      { command: 'create_text', params: { parentId: '$card.id', text: '$20.00', x: 0, y: 0 } },
    ];

    it('accepts a valid batch (a $ref parentId counts)', () => {
      expect(validateBatchOperations(ok)).toEqual([]);
    });

    it('rejects empty, non-array and oversized batches', () => {
      expect(validateBatchOperations([])).toHaveLength(1);
      expect(validateBatchOperations('nope')).toHaveLength(1);
      const big = Array.from({ length: BATCH_MAX_OPS + 1 }, () => ({ command: 'move_node', params: {} }));
      expect(validateBatchOperations(big)[0]).toMatch(/Too many operations/);
      const max = Array.from({ length: BATCH_MAX_OPS }, () => ({ command: 'move_node', params: {} }));
      expect(validateBatchOperations(max)).toEqual([]);
    });

    it('rejects nested batch and unknown commands', () => {
      expect(validateBatchOperations([{ command: 'batch', params: {} }]).join()).toMatch(/cannot be nested/);
      expect(validateBatchOperations([{ command: 'make_coffee', params: {} }]).join()).toMatch(/unknown or unsupported/);
    });

    it('requires parentId on creation commands', () => {
      expect(validateBatchOperations([{ command: 'create_rectangle', params: { x: 0 } }]).join()).toMatch(/requires a parentId/);
    });

    it('rejects references to later or unknown operations', () => {
      const bad = [
        { command: 'move_node', params: { nodeId: '$later.id' } },
        { id: 'later', command: 'create_frame', params: { parentId: '0:1' } },
      ];
      expect(validateBatchOperations(bad).join()).toMatch(/not defined by an earlier operation/);
    });

    it('rejects duplicate and malformed ids', () => {
      const dup = [
        { id: 'a', command: 'create_frame', params: { parentId: '0:1' } },
        { id: 'a', command: 'create_frame', params: { parentId: '0:1' } },
      ];
      expect(validateBatchOperations(dup).join()).toMatch(/duplicate id/);
      expect(validateBatchOperations([{ id: '1bad', command: 'move_node', params: {} }]).join()).toMatch(/id must start/);
    });
  });

  describe('plugin parity (src/claude_mcp_plugin/code.js)', () => {
    it('BATCHABLE_COMMANDS matches the plugin handleCommand cases', () => {
      const start = pluginSource.indexOf('async function handleCommand');
      const end = pluginSource.indexOf('\n}\n', start);
      const cases = [...pluginSource.slice(start, end).matchAll(/^\s*case "([a-z_0-9]+)":/gm)].map((m) => m[1]);
      const expected = cases.filter((c) => c !== 'ping' && c !== 'batch').sort();
      expect([...BATCHABLE_COMMANDS].sort()).toEqual(expected);
    });

    it('the plugin resolveRefs behaves exactly like the TypeScript one', () => {
      const from = pluginSource.indexOf('const REF_PATTERN');
      const to = pluginSource.indexOf('function slimBatchResult');
      expect(from).toBeGreaterThan(-1);
      expect(to).toBeGreaterThan(from);
      // eslint-disable-next-line no-new-func
      const pluginResolve = new Function(`${pluginSource.slice(from, to)}; return resolveRefs;`)() as typeof resolveRefs;

      const byId = { card: { id: '1:2', box: { x: 10 } }, n: 5 };
      const inputs: unknown[] = [
        '$card', '$card.id', '$card.box.x', '$n', '$20.00', '$$card', 'plain',
        { parentId: '$card.id', text: '$card', list: ['$n', { deep: '$card.box.x' }] },
        [1, '$n', null],
      ];
      for (const input of inputs) {
        expect(pluginResolve(input, byId)).toEqual(resolveRefs(input, byId));
      }
      for (const bad of ['$nope', '$card.missing', '$n.deeper']) {
        expect(() => pluginResolve(bad, byId)).toThrow();
        expect(() => resolveRefs(bad, byId)).toThrow();
      }
    });
  });
});
