import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// Old links to the retired bookmarks page lead to the book list instead.
export const load: PageLoad = () => {
	redirect(307, '/books');
};
