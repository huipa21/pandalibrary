<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';

	let { current }: { current: 'overview' | 'log' } = $props();
</script>

<header class="reading-header">
	<h1 id="reading-heading">{m['organize.reading']()}</h1>
	<nav aria-label={m['stats.reading.nav_label']()}>
		<a href="/stats/reading" aria-current={current === 'overview' ? 'page' : undefined}>
			{m['stats.reading.overview']()}
		</a>
		<a href="/stats/history" aria-current={current === 'log' ? 'page' : undefined}>
			{m['stats.reading.log']()}
		</a>
	</nav>
</header>

<style>
	.reading-header {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 1rem;
		color: var(--shell-text, #1f2328);
	}
	h1 {
		margin: 0;
		font-size: 1.5rem;
		font-weight: 650;
		letter-spacing: -0.02em;
		line-height: 1.2;
	}
	nav {
		display: flex;
		gap: 0.25rem;
		border: 1px solid var(--shell-border, #dde2e8);
		border-radius: 0.5rem;
		background: var(--shell-hover, #f1f5f9);
		padding: 0.25rem;
	}
	a {
		border-radius: 0.375rem;
		padding: 0.375rem 0.75rem;
		color: var(--shell-muted, #56657a);
		font-size: 0.875rem;
		font-weight: 500;
		text-decoration: none;
	}
	a:hover {
		color: var(--shell-text, #1f2328);
	}
	a[aria-current='page'] {
		background: var(--shell-surface, #fff);
		color: var(--shell-text, #1f2328);
		box-shadow: 0 1px 2px rgb(15 23 42 / 0.08);
	}
	a:focus-visible {
		outline: 2px solid var(--shell-active, #1f2328);
		outline-offset: 2px;
	}
	@media (max-width: 40rem) {
		.reading-header {
			align-items: stretch;
		}
		nav {
			width: 100%;
		}
		a {
			flex: 1;
			text-align: center;
		}
	}
</style>
