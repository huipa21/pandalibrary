import type { PdfZoom } from './types.js';

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 5;
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;

export function clampScale(scale: number): number {
	return Number.isFinite(scale) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)) : 1;
}

/** The next ladder step strictly above (`+1`) or below (`-1`) the current scale. */
export function nextScale(scale: number, direction: -1 | 1): number {
	const current = clampScale(scale);
	if (direction > 0) return ZOOM_STEPS.find((step) => step > current + 1e-6) ?? MAX_SCALE;
	return [...ZOOM_STEPS].reverse().find((step) => step < current - 1e-6) ?? MIN_SCALE;
}

/** The pdf.js `currentScaleValue` for a zoom. */
export function presetValue(zoom: PdfZoom): string {
	return typeof zoom === 'number' ? String(clampScale(zoom)) : zoom;
}

/** Multiplicative zoom for one wheel event, normalized across delta modes and clamped per event. */
export function wheelFactor(deltaY: number, deltaMode: number): number {
	const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 800 : 1);
	return Math.max(0.8, Math.min(1.25, Math.exp(-pixels * 0.002)));
}
