import * as m from '#lib/paraglide/messages.js';

type MessageFunction = (inputs?: Record<string, unknown>) => string;

/** Resolves a dynamically chosen Paraglide message key in the active locale. */
export function translate(key: string, inputs?: Record<string, unknown>): string {
	const message = (m as unknown as Record<string, MessageFunction | undefined>)[key];
	return message ? message(inputs) : key;
}
