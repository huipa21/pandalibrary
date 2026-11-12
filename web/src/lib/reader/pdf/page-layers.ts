import { pointFromRotated } from './geometry.js';
import type { NormalizedRect, PageLayerContext, PageLayerPainter, PdfRotation } from './types.js';

export interface PageBox {
	page: number;
	div: HTMLElement;
	/** Unrotated page size in CSS px. */
	width: number;
	height: number;
	rotation: PdfRotation;
}

export function layerTransform(width: number, height: number, rotation: PdfRotation): string {
	switch (rotation) {
		case 90: return `translateX(${height}px) rotate(90deg)`;
		case 180: return `translate(${width}px, ${height}px) rotate(180deg)`;
		case 270: return `translateY(${width}px) rotate(270deg)`;
		default: return '';
	}
}

/** Sizes and rotates an absolutely positioned layer so that it covers the page in unrotated space. */
export function placeLayer(layer: HTMLElement, box: PageBox, z: number): void {
	Object.assign(layer.style, {
		position: 'absolute',
		left: '0',
		top: '0',
		width: `${box.width}px`,
		height: `${box.height}px`,
		transformOrigin: '0 0',
		transform: layerTransform(box.width, box.height, box.rotation),
		zIndex: String(z)
	});
}

export function percentCss(rect: NormalizedRect) {
	return { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` };
}

export function layerContext(box: PageBox, layer: HTMLElement): PageLayerContext {
	return {
		page: box.page,
		layer,
		width: box.width,
		height: box.height,
		rotation: box.rotation,
		toCss: percentCss,
		fromClient(clientX, clientY) {
			const rect = box.div.getBoundingClientRect();
			return pointFromRotated({
				x: rect.width ? (clientX - rect.left) / rect.width : 0,
				y: rect.height ? (clientY - rect.top) / rect.height : 0
			}, box.rotation);
		}
	};
}

/** Owns one layer per painter per page; layers are re-created when pdf.js discards them. */
export class PageLayers {
	private readonly painters = new Map<string, PageLayerPainter>();

	constructor(private readonly pages: () => Iterable<PageBox>, private readonly box: (page: number) => PageBox | null) {}

	register(painter: PageLayerPainter): () => void {
		const previous = this.painters.get(painter.name);
		if (previous && previous !== painter) previous.dispose?.();
		this.removeLayers(painter.name);
		this.painters.set(painter.name, painter);
		this.repaint();
		return () => {
			if (this.painters.get(painter.name) !== painter) return;
			this.painters.delete(painter.name);
			painter.dispose?.();
			this.removeLayers(painter.name);
		};
	}

	has(name: string): boolean {
		return this.painters.has(name);
	}

	repaint(page?: number): void {
		const boxes = page === undefined ? [...this.pages()] : [this.box(page)].filter((box) => box !== null);
		for (const box of boxes) this.paintPage(box);
	}

	paintPage(box: PageBox): void {
		for (const painter of this.painters.values()) {
			let layer = box.div.querySelector<HTMLElement>(`:scope > .pv-layer[data-layer="${CSS.escape(painter.name)}"]`);
			if (!layer) {
				layer = document.createElement('div');
				layer.className = 'pv-layer';
				layer.dataset.layer = painter.name;
				box.div.append(layer);
			}
			placeLayer(layer, box, painter.z);
			layer.replaceChildren();
			try {
				painter.paint(layerContext(box, layer));
			} catch (error) {
				console.error(`The PDF page layer "${painter.name}" failed to paint`, error);
			}
		}
	}

	clear(): void {
		for (const painter of this.painters.values()) painter.dispose?.();
		this.painters.clear();
	}

	private removeLayers(name: string): void {
		for (const box of this.pages()) {
			box.div.querySelector(`:scope > .pv-layer[data-layer="${CSS.escape(name)}"]`)?.remove();
		}
	}
}
