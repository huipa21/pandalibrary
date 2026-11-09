import * as m from '#lib/paraglide/messages.js';
import { annotationAssetUrl } from '../../assets/asset-cache.js';
import type { PageAnnotation } from '../../types.js';
import type { PageLayerContext, PageLayerPainter, PdfTool } from '../types.js';
import { strokePath } from './ink.js';

export function pageAnnotationPainter(
	rows: () => readonly PageAnnotation[], tool: () => PdfTool,
	context: (ctx: PageLayerContext) => void = () => {},
	hidden: () => string | undefined = () => undefined
): PageLayerPainter & { refresh(): void; dispose(): void } {
	const images = new Map<string, { url?: string; failed?: boolean; pending?: Promise<void> }>();
	let disposed = false;
	let annotations = rows(), currentTool = tool(), hiddenId = hidden();
	return {
		name: 'inserts', z: 8,
		refresh() {
			annotations = rows(); currentTool = tool(); hiddenId = hidden();
		},
		paint(ctx) {
			context(ctx);
			for (const row of annotations) {
				if (row.locator.page !== ctx.page || row.id === hiddenId) continue;
				const item = document.createElement('div');
				item.dataset.annotationId = row.id;
				item.tabIndex = currentTool === 'hand' ? -1 : 0;
				item.setAttribute('role', 'img');
				item.setAttribute('aria-label', row.kind === 'text' ? m['pv9.text_note']({ text: row.data.text }) :
					row.kind === 'ink' ? m['pv9.drawing']() : m['pv9.image']());
				Object.assign(item.style, ctx.toCss(row.locator.rect), {
					position: 'absolute', pointerEvents: currentTool === 'hand' ? 'none' : 'auto',
					touchAction: currentTool === 'hand' ? 'auto' : 'none', cursor: currentTool === 'hand' ? 'inherit' : 'move'
				});
				if (row.kind === 'text') {
					item.textContent = row.data.text;
					Object.assign(item.style, { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
						color: row.data.color, fontSize: `${row.data.size * ctx.height}px`, lineHeight: '1.2' });
				} else if (row.kind === 'ink') {
					const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
					svg.setAttribute('viewBox', '0 0 1 1');
					svg.setAttribute('preserveAspectRatio', 'none');
					Object.assign(svg.style, { width: '100%', height: '100%', overflow: 'visible' });
					const rect = row.locator.rect;
					for (const stroke of row.data.strokes) {
						const path = document.createElementNS(svg.namespaceURI, 'path');
						path.setAttribute('d', strokePath(stroke.map((v, i) => (v - (i % 2 ? rect.y : rect.x)) / (i % 2 ? rect.height : rect.width))));
						path.setAttribute('fill', 'none');
						path.setAttribute('stroke', row.data.color);
						path.setAttribute('stroke-width', String(row.data.width * ctx.width));
						path.setAttribute('vector-effect', 'non-scaling-stroke');
						path.setAttribute('stroke-linecap', 'round');
						path.setAttribute('stroke-linejoin', 'round');
						svg.append(path);
					}
					item.append(svg);
				} else {
					const hash = row.data.asset;
					let image = images.get(hash);
					if (!image) { image = {}; images.set(hash, image); }
					const entry = image;
					const render = () => {
						if (disposed) return;
						if (entry.url) {
							const img = document.createElement('img');
							img.alt = ''; img.src = entry.url; img.draggable = false;
							Object.assign(img.style, { width: '100%', height: '100%', pointerEvents: 'none' });
							item.replaceChildren(img);
						} else if (entry.failed) {
							item.textContent = m['pv9.image_unavailable']();
							item.title = m['pv9.image_unavailable']();
							item.style.border = '1px dashed currentColor';
						}
					};
					if (!entry.url && !entry.failed && !entry.pending) {
						entry.pending = annotationAssetUrl(hash).then((url) => {
							if (disposed) URL.revokeObjectURL(url);
							else entry.url = url;
						}, (error: unknown) => {
							console.error('Could not load annotation image', error);
							entry.failed = true;
						});
					}
					void entry.pending?.then(render);
					render();
				}
				ctx.layer.append(item);
			}
		},
		dispose() {
			disposed = true;
			for (const image of images.values()) if (image.url) URL.revokeObjectURL(image.url);
			images.clear();
		}
	};
}
