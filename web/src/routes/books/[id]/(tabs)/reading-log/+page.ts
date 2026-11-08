import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// The Reading Log tab was renamed Activities; keep old links working.
export const load: PageLoad = ({ params, url }) => {
	redirect(307, `/books/${encodeURIComponent(params.id)}/activities${url.search}`);
};
