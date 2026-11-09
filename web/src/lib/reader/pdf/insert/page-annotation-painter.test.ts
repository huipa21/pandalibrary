import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageAnnotation } from '../../types.js';
import { percentCss } from '../page-layers.js';
import { pageAnnotationPainter } from './page-annotation-painter.js';
import { annotationAssetUrl } from '../../assets/asset-cache.js';
import type { PageLayerContext } from '../types.js';

vi.mock('../../assets/asset-cache.js', () => ({ annotationAssetUrl: vi.fn() }));

class Element {
	style: Record<string, string> = {};
	dataset: Record<string, string> = {};
	attributes: Record<string, string> = {};
	children: Element[] = [];
	textContent = '';
	tabIndex = -1;
	title = '';
	src = '';
	alt = '';
	draggable = true;
	constructor(readonly tag: string, readonly namespaceURI = '') {}
	setAttribute(key: string, value: string) { this.attributes[key] = value; }
	append(child: Element) { this.children.push(child); }
	replaceChildren(...children: Element[]) { this.children = children; }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup(rows: PageAnnotation[], tool: 'select' | 'hand' = 'select') {
	const layer = new Element('div');
	vi.stubGlobal('document', {
		createElement: (tag: string) => tag === 'layer' ? layer : new Element(tag),
		createElementNS: (namespace: string, tag: string) => new Element(tag, namespace)
	});
	const painter = pageAnnotationPainter(() => rows, () => tool);
	const ctx: PageLayerContext = {
		page: 1, layer: document.createElement('layer'), width: 600, height: 800, rotation: 90,
		toCss: percentCss, fromClient: (x: number, y: number) => ({ x, y })
	};
	return { layer, painter, ctx };
}
const common = {
	id: '01900000-0000-7000-8000-000000000001', book_id: 21, book_file_id: 31, position: 0,
	locator: { type: 'pdf' as const, page: 1, rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 } },
	created_at: '', updated_at: '', deleted_at: null, rev: 1
};

describe('insert painter DOM output', () => {
	it('paints safe text in unrotated percent space with page-relative typography', () => {
		const { layer, painter, ctx } = setup([{ ...common, kind: 'text', data: { text: '<b>Note</b>\nLine', color: '#111827', size: 0.018 } }]);
		painter.paint(ctx);
		const item = layer.children[0];
		expect({ attributes: item.attributes, style: item.style, text: item.textContent, children: item.children }).toMatchInlineSnapshot(`
			{
			  "attributes": {
			    "aria-label": "Text note: <b>Note</b>
			Line",
			    "role": "img",
			  },
			  "children": [],
			  "style": {
			    "color": "#111827",
			    "cursor": "move",
			    "fontSize": "14.399999999999999px",
			    "height": "10%",
			    "left": "10%",
			    "lineHeight": "1.2",
			    "overflowWrap": "anywhere",
			    "pointerEvents": "auto",
			    "position": "absolute",
			    "top": "20%",
			    "touchAction": "none",
			    "whiteSpace": "pre-wrap",
			    "width": "30%",
			  },
			  "text": "<b>Note</b>
			Line",
			}
		`);
		expect(item.dataset.annotationId).toBe(common.id);
		expect(item.tabIndex).toBe(0);
		painter.dispose();
	});
	it('paints normalized ink paths with physical stroke width and no extra rotation', () => {
		const { layer, painter, ctx } = setup([{ ...common, kind: 'ink', data: { color: '#2563eb', width: 0.004, strokes: [[0.1, 0.2, 0.4, 0.3]] } }], 'hand');
		painter.paint(ctx);
		const item = layer.children[0], svg = item.children[0], path = svg.children[0];
		expect(svg.attributes).toEqual({ viewBox: '0 0 1 1', preserveAspectRatio: 'none' });
		expect(path.attributes).toMatchObject({ fill: 'none', stroke: '#2563eb', 'stroke-width': '2.4', 'vector-effect': 'non-scaling-stroke', 'stroke-linecap': 'round' });
		expect(path.attributes.d).toMatch(/^M0 0 L1/);
		expect(item.style.pointerEvents).toBe('none');
		expect(item.style).not.toHaveProperty('transform');
		expect(item.tabIndex).toBe(-1);
	});
	it('loads cached image URLs and revokes them on disposal', async () => {
		vi.mocked(annotationAssetUrl).mockResolvedValue('blob:cached-image');
		const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		const { layer, painter, ctx } = setup([{ ...common, kind: 'image', data: { asset: 'a'.repeat(64), media_type: 'image/png', width: 120, height: 60 } }]);
		painter.paint(ctx);
		await vi.waitFor(() => expect(layer.children[0].children[0]?.src).toBe('blob:cached-image'));
		expect(layer.children[0].children[0].alt).toBe('');
		painter.dispose();
		expect(revoke).toHaveBeenCalledWith('blob:cached-image');
	});
	it('shows an explicit unavailable placeholder on image cache failure', async () => {
		vi.mocked(annotationAssetUrl).mockRejectedValue(new Error('Offline'));
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { layer, painter, ctx } = setup([{ ...common, kind: 'image', data: { asset: 'b'.repeat(64), media_type: 'image/png', width: 120, height: 60 } }]);
		painter.paint(ctx);
		await vi.waitFor(() => expect(layer.children[0].title).toBe('Image unavailable offline'));
		expect(error).toHaveBeenCalled();
		painter.dispose();
	});
});
