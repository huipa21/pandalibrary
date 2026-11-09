/** Shared Tailwind class strings so admin controls match the existing app styling. */
export const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900';
export const inputClass = `rounded-md border border-slate-300 bg-white px-3 py-2 text-base font-normal ${focusRing}`;
export const primaryButton = `rounded-md bg-slate-900 px-4 py-2 font-medium text-white ${focusRing} disabled:opacity-60`;
export const secondaryButton = `rounded-md border border-slate-300 bg-white px-4 py-2 ${focusRing} disabled:opacity-60`;
export const dangerButton = `rounded-md border border-red-300 bg-white px-4 py-2 text-red-800 ${focusRing} disabled:opacity-60`;
export const smallSecondaryButton = `rounded-md border border-slate-300 bg-white px-3 py-1 text-sm ${focusRing} disabled:opacity-60`;
export const smallDangerButton = `rounded-md border border-red-300 bg-white px-3 py-1 text-sm text-red-800 ${focusRing} disabled:opacity-60`;
export const iconButton = `inline-grid size-10.5 shrink-0 place-items-center rounded-md border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 ${focusRing} disabled:opacity-50`;
export const linkClass = `rounded-sm underline underline-offset-4 ${focusRing}`;
export const panelClass = 'space-y-4 rounded-lg border border-slate-200 bg-white p-4 sm:p-6';
export const errorBox = 'rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800';
export const warningBox = 'rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950';
