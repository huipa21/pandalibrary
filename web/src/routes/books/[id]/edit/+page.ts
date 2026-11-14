import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// The metadata editor moved into the Metadata tab; keep old links working.
export const load: PageLoad = ({ params, url }) => {
	redirect(307, `/books/${encodeURIComponent(params.id)}/metadata${url.search}`);
};
