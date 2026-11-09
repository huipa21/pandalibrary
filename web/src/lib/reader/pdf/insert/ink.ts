import { PAGE_ANNOTATION_LIMITS as limits, quantize, simplifyStroke } from '../../page-annotations.js';
import type { InkData, NormalizedRect } from '../../types.js';
import { clamp } from './geometry-insert.js';

export function samplePointer(event: PointerEvent, fromClient: (x: number, y: number) => { x: number; y: number }): number[] {
	const samples = event.getCoalescedEvents?.();
	return (samples?.length ? samples : [event]).flatMap((sample) => {
		const point = fromClient(sample.clientX, sample.clientY);
		return [clamp(point.x), clamp(point.y)];
	});
}

export function finishInk(strokes: number[][], color: string, width: number): InkData {
	if (!strokes.length || strokes.length > limits.strokes) throw new Error('Drawing must contain 1 to 200 strokes.');
	let epsilon = 0.0005;
	for (;;) {
		const data = { color, width, strokes: strokes.map((stroke) => quantize(simplifyStroke(stroke, epsilon))) };
		if (data.strokes.reduce((sum, stroke) => sum + stroke.length / 2, 0) <= limits.points &&
			new TextEncoder().encode(JSON.stringify(data)).length <= limits.dataBytes) return data;
		epsilon *= 2;
	}
}

export function inkBounds(strokes: number[][]): NormalizedRect {
	let x = 1, y = 1, right = 0, bottom = 0;
	for (const stroke of strokes) for (let i = 0; i < stroke.length; i += 2) {
		x = Math.min(x, stroke[i]); y = Math.min(y, stroke[i + 1]);
		right = Math.max(right, stroke[i]); bottom = Math.max(bottom, stroke[i + 1]);
	}
	x = Math.min(x, 0.9999); y = Math.min(y, 0.9999);
	return { x, y, width: Math.max(0.0001, right - x), height: Math.max(0.0001, bottom - y) };
}

export function strokePath(stroke: number[]): string {
	if (stroke.length === 2) return `M${stroke[0]} ${stroke[1]} L${stroke[0]} ${stroke[1]}`;
	return stroke.reduce((path, value, i) => path + (i % 2 === 0 ? `${i ? ' L' : 'M'}${value}` : ` ${value}`), '');
}
