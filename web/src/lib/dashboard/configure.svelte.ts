/** Open requests for the dashboard configuration dialog, raised from the sidebar menu. */
export const dashboardConfigure = $state<{ pending: boolean; trigger: HTMLElement | null }>({
	pending: false,
	trigger: null
});

export function requestDashboardConfigure(trigger: HTMLElement) {
	dashboardConfigure.trigger = trigger;
	dashboardConfigure.pending = true;
}
