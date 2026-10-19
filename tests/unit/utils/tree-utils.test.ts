import {
  TREE_MAX_DEPTH,
  TREE_MAX_NODES,
  TreeNodeInput,
  countTree,
  expandPadding,
  hexToColor,
  normalizeColor,
  normalizeTree,
  validateTree,
} from '../../../src/talk_to_figma_mcp/utils/tree-utils';

const kpiCard: TreeNodeInput = {
  type: 'frame',
  name: 'Card',
  width: 312,
  height: 'hug',
  fill: '#ffffff',
  stroke: '#dedede',
  cornerRadius: 8,
  layout: { mode: 'VERTICAL', gap: 4, padding: 16 },
  children: [
    { type: 'text', name: 'Label', text: 'Total Expenses', fontSize: 13, fontColor: '#808080' },
    { type: 'text', name: 'Value', text: '$4,481.80', fontSize: 28, fontWeight: 700 },
    { type: 'text', name: 'Delta', text: '▲ $28.28 vs Sep', fontSize: 12, width: 'fill' },
  ],
};

describe('tree-utils', () => {
  describe('colors', () => {
    it('parses hex colors', () => {
      expect(hexToColor('#ff0000')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
      expect(hexToColor('#0f0')).toEqual({ r: 0, g: 1, b: 0, a: 1 });
      const c = hexToColor('#12b886')!;
      expect(c.r).toBeCloseTo(18 / 255);
      expect(c.g).toBeCloseTo(184 / 255);
      expect(hexToColor('#00000080')!.a).toBeCloseTo(128 / 255);
    });

    it('rejects invalid colors', () => {
      expect(hexToColor('red')).toBeNull();
      expect(hexToColor('#12')).toBeNull();
      expect(normalizeColor({ r: 2, g: 0, b: 0 })).toBeNull();
      expect(normalizeColor(undefined)).toBeNull();
    });

    it('accepts rgb objects and defaults alpha to 1', () => {
      expect(normalizeColor({ r: 0.1, g: 0.2, b: 0.3 })).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
    });
  });

  describe('expandPadding', () => {
    it('handles number, 1, 2 and 4 value forms', () => {
      expect(expandPadding(8)).toEqual({ top: 8, right: 8, bottom: 8, left: 8 });
      expect(expandPadding([8])).toEqual({ top: 8, right: 8, bottom: 8, left: 8 });
      expect(expandPadding([8, 16])).toEqual({ top: 8, bottom: 8, right: 16, left: 16 });
      expect(expandPadding([1, 2, 3, 4])).toEqual({ top: 1, right: 2, bottom: 3, left: 4 });
      expect(expandPadding([1, 2, 3])).toBeNull();
      expect(expandPadding(undefined)).toBeNull();
    });
  });

  describe('countTree', () => {
    it('counts nodes and depth', () => {
      expect(countTree(kpiCard)).toEqual({ count: 4, depth: 2 });
      expect(countTree({ type: 'rectangle' })).toEqual({ count: 1, depth: 1 });
    });
  });

  describe('validateTree', () => {
    it('accepts the KPI card example', () => {
      expect(validateTree(kpiCard)).toEqual([]);
    });

    it('rejects non-objects and bad types', () => {
      expect(validateTree(null)).toHaveLength(1);
      expect(validateTree([])).toHaveLength(1);
      expect(validateTree({ type: 'circle' }).join()).toMatch(/type must be one of/);
    });

    it('requires text on text nodes and forbids children on non-frames', () => {
      expect(validateTree({ type: 'text' }).join()).toMatch(/needs a text string/);
      expect(
        validateTree({ type: 'rectangle', children: [{ type: 'rectangle' }] }).join()
      ).toMatch(/only frames can have children/);
    });

    it('rejects fill inside a parent without auto-layout, with the path', () => {
      const tree: TreeNodeInput = {
        type: 'frame',
        children: [{ type: 'frame', children: [{ type: 'rectangle', width: 'fill', height: 10 }] }],
      };
      const errors = validateTree(tree);
      expect(errors.join()).toMatch(/root\.children\[0\]\.children\[0\]/);
      expect(errors.join()).toMatch(/"fill" needs an auto-layout parent/);
    });

    it('allows fill when the parent is auto-layout, and on the root (parent unknown)', () => {
      expect(
        validateTree({
          type: 'frame',
          width: 'fill',
          layout: { mode: 'HORIZONTAL' },
          children: [{ type: 'rectangle', width: 'fill', height: 10 }],
        })
      ).toEqual([]);
    });

    it('rejects hug on a frame without auto-layout but allows it on text', () => {
      expect(validateTree({ type: 'frame', width: 'hug' }).join()).toMatch(/"hug" needs this node/);
      expect(validateTree({ type: 'frame', layout: { mode: 'VERTICAL' }, children: [{ type: 'text', text: 'x', width: 'hug' }] })).toEqual([]);
    });

    it('rejects bad colors, paddings and alignments', () => {
      expect(validateTree({ type: 'rectangle', fill: 'blue' }).join()).toMatch(/not a valid color/);
      expect(validateTree({ type: 'frame', layout: { mode: 'VERTICAL', padding: [1, 2, 3] } }).join()).toMatch(/padding/);
      expect(validateTree({ type: 'frame', layout: { mode: 'VERTICAL', align: 'middle' } }).join()).toMatch(/layout\.align/);
    });

    it('enforces depth and node caps', () => {
      let deep: TreeNodeInput = { type: 'rectangle' };
      for (let i = 0; i < TREE_MAX_DEPTH; i++) deep = { type: 'frame', children: [deep] };
      expect(validateTree(deep)[0]).toMatch(/too deep/);

      const wide: TreeNodeInput = {
        type: 'frame',
        children: Array.from({ length: TREE_MAX_NODES }, () => ({ type: 'rectangle' as const })),
      };
      expect(validateTree(wide)[0]).toMatch(/too large/);
    });
  });


  describe('instance nodes', () => {
    it('validates and normalises an instance', () => {
      const tree: TreeNodeInput = {
        type: 'frame',
        layout: { mode: 'VERTICAL' },
        children: [{ type: 'instance', component: 'Button/Primary', overrides: { Label: 'Submit' }, hide: ['Subtitle'], width: 'fill' }],
      };
      expect(validateTree(tree)).toEqual([]);
      const out = normalizeTree(tree);
      expect(out.children![0]).toMatchObject({ type: 'instance', component: 'Button/Primary', overrides: { Label: 'Submit' }, hide: ['Subtitle'], width: 'fill' });
    });

    it('requires a component and forbids children on instances', () => {
      expect(validateTree({ type: 'instance' } as TreeNodeInput).join()).toMatch(/needs a component/);
      expect(
        validateTree({ type: 'instance', component: 'X', children: [{ type: 'rectangle' }] } as TreeNodeInput).join()
      ).toMatch(/only frames can have children/);
    });

    it('allows hug on an instance but not fill outside auto-layout', () => {
      expect(validateTree({ type: 'frame', layout: { mode: 'VERTICAL' }, children: [{ type: 'instance', component: 'X', height: 'hug' }] })).toEqual([]);
      expect(
        validateTree({ type: 'frame', children: [{ type: 'instance', component: 'X', width: 'fill' }] }).join()
      ).toMatch(/"fill" needs an auto-layout parent/);
    });
  });

  describe('normalizeTree', () => {
    it('maps the KPI card to plugin params', () => {
      const out = normalizeTree(kpiCard);
      expect(out).toMatchObject({
        type: 'frame',
        name: 'Card',
        width: 312,
        height: 'hug',
        cornerRadius: 8,
        layoutMode: 'VERTICAL',
        itemSpacing: 4,
        paddingTop: 16,
        paddingRight: 16,
        paddingBottom: 16,
        paddingLeft: 16,
      });
      expect(out.fillColor).toEqual({ r: 1, g: 1, b: 1, a: 1 });
      expect(out.strokeColor!.r).toBeCloseTo(222 / 255);
      expect(out.children).toHaveLength(3);
      expect(out.children![1]).toMatchObject({ type: 'text', text: '$4,481.80', fontSize: 28, fontWeight: 700 });
      expect(out.children![0].fontColor!.r).toBeCloseTo(128 / 255);
      expect(out.children![2].width).toBe('fill');
    });

    it('maps alignment words, wrap, textAlign and maxWidth', () => {
      const out = normalizeTree({
        type: 'frame',
        layout: { mode: 'HORIZONTAL', align: 'space-between', crossAlign: 'center', wrap: true },
        children: [{ type: 'text', text: 'x', textAlign: 'right', maxWidth: 200 }],
      });
      expect(out).toMatchObject({ primaryAxisAlignItems: 'SPACE_BETWEEN', counterAxisAlignItems: 'CENTER', layoutWrap: 'WRAP' });
      expect(out.children![0]).toMatchObject({ textAlignHorizontal: 'RIGHT', width: 200 });
    });

    it('does not add keys that were not provided', () => {
      expect(Object.keys(normalizeTree({ type: 'rectangle' }))).toEqual(['type']);
    });
  });
});
