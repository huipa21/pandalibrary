<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import Icon from '../Icon.svelte';
	import { chapterKey, colorCounts, colorTone, weekStartDate, type ChapterGroup, type MarkStats } from './highlights-model.js';
	import { colorName, formatLabel } from './labels.js';

	let {
		stats,
		chapters,
		colors,
		onToggleColor,
		onJump,
		locale
	}: {
		stats: MarkStats;
		chapters: ChapterGroup[];
		colors: ReadonlySet<string>;
		onToggleColor: (color: string) => void;
		onJump: (key: string) => void;
		locale: string;
	} = $props();

	let open = $state(false);

	const FORMAT_TONES = ['bg-emerald-500', 'bg-sky-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500', 'bg-teal-500', 'bg-slate-400'];
	const BAR_WIDTH = 7;
	const BAR_STEP = 10;
	const CHART_HEIGHT = 56;

	const maxWeek = $derived(Math.max(1, ...stats.weeks.map((week) => week.count)));
	const monthFormat = $derived(new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' }));
	const dayFormat = $derived(new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }));
	const startLabel = $derived(stats.weeks.length ? monthFormat.format(weekStartDate(stats.weeks[0].start)) : '');
	const endLabel = $derived(stats.weeks.length ? monthFormat.format(weekStartDate(stats.weeks[stats.weeks.length - 1].start)) : '');
	const recentTotal = $derived(stats.weeks.reduce((sum, week) => sum + week.count, 0));

	function percent(count: number, total: number): string {
		return `${total > 0 ? (count / total) * 100 : 0}%`;
	}

	const heading = 'text-[0.7rem] font-semibold tracking-wider text-slate-500 uppercase';
	const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900';
</script>

<aside class="card p-4 lg:sticky lg:top-[calc(var(--shell-content-top)+4.5rem)] lg:p-5" aria-labelledby="highlights-overview-heading">
	<div class="flex items-center justify-between gap-2">
		<h2 id="highlights-overview-heading" class="text-sm font-semibold text-slate-900">
			{m['bv9.summary']({ marks: stats.total, chapters: stats.chapters })}
		</h2>
		<button
			type="button"
			class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-slate-600 hover:bg-slate-50 lg:hidden {focusRing}"
			aria-expanded={open}
			aria-controls="highlights-overview"
			onclick={() => (open = !open)}
		>
			{m['bv9.overview']()}
			<Icon name="chevron-down" class="size-4 transition-transform {open ? 'rotate-180' : ''}" />
		</button>
	</div>

	<div id="highlights-overview" class="mt-4 space-y-6 {open ? '' : 'hidden'} lg:block">
		<section class="space-y-2" aria-labelledby="highlights-when-heading">
			<h3 id="highlights-when-heading" class={heading}>{m['bv9.when']()}</h3>
			<svg
				class="h-14 w-full"
				viewBox="0 0 {stats.weeks.length * BAR_STEP} {CHART_HEIGHT}"
				preserveAspectRatio="none"
				role="img"
				aria-label={m['bv9.histogram_label']({ total: recentTotal })}
			>
				{#each stats.weeks as week, index (week.start)}
					{@const height = week.count ? Math.max(3, (week.count / maxWeek) * CHART_HEIGHT) : 1}
					<rect
						x={index * BAR_STEP}
						y={CHART_HEIGHT - height}
						width={BAR_WIDTH}
						{height}
						rx="1"
						class={week.count ? 'fill-emerald-500' : 'fill-slate-200'}
					><title>{dayFormat.format(weekStartDate(week.start))}: {week.count}</title></rect>
				{/each}
			</svg>
			<div class="flex justify-between text-xs text-slate-500" aria-hidden="true">
				<span>{startLabel}</span><span>{endLabel}</span>
			</div>
			<p class="text-xs text-slate-600">
				{#if stats.busiestWeek}
					{m['bv9.busiest']({ date: dayFormat.format(weekStartDate(stats.busiestWeek.start)), count: stats.busiestWeek.count })}
				{:else}
					{m['bv9.no_recent']()}
				{/if}
			</p>
		</section>

		{#if stats.byColor.length}
			<section class="space-y-2" aria-labelledby="highlights-colors-heading">
				<h3 id="highlights-colors-heading" class={heading}>{m['bv9.colors']()}</h3>
				<ul class="flex flex-wrap gap-1.5">
					{#each stats.byColor as item (item.color)}
						{@const tone = colorTone(item.color)}
						{@const pressed = colors.has(item.color)}
						<li>
							<button
								type="button"
								class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium {pressed ? 'border-slate-900 ring-1 ring-slate-900' : 'border-transparent'} {tone.soft} {tone.text} {focusRing}"
								aria-pressed={pressed}
								aria-label={m['bv9.color_chip_label']({ color: colorName(item.color), count: item.count })}
								onclick={() => onToggleColor(item.color)}
							>
								<span class="size-2.5 rounded-full {tone.bar}" style:background-color={tone.hex} aria-hidden="true"></span>
								{colorName(item.color)}
								<span class="tabular-nums opacity-80">{item.count}</span>
							</button>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if stats.byFormat.length}
			<section class="space-y-2" aria-labelledby="highlights-sources-heading">
				<h3 id="highlights-sources-heading" class={heading}>{m['bv9.sources']()}</h3>
				<div class="flex h-2.5 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={m['bv9.sources_label']()}>
					{#each stats.byFormat as item, index (item.format)}
						<span class={FORMAT_TONES[index % FORMAT_TONES.length]} style:width={percent(item.count, stats.total)}></span>
					{/each}
				</div>
				<ul class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
					{#each stats.byFormat as item, index (item.format)}
						<li class="inline-flex items-center gap-1.5">
							<span class="size-2.5 rounded-sm {FORMAT_TONES[index % FORMAT_TONES.length]}" aria-hidden="true"></span>
							<span>{formatLabel(item.format)}</span>
							<span class="tabular-nums text-slate-500">{item.count}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if chapters.length}
			<section class="space-y-2" aria-labelledby="highlights-chapters-heading">
				<h3 id="highlights-chapters-heading" class={heading}>{m['bv9.chapters']()}</h3>
				<ul class="max-h-80 space-y-1 overflow-y-auto pr-1">
					{#each chapters as group (chapterKey(group))}
						<li>
							<button
								type="button"
								class="grid w-full grid-cols-[minmax(0,1fr)_3rem_auto] items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-slate-50 {focusRing}"
								aria-label={m['bv9.chapter_jump']({ chapter: group.chapter, count: group.marks.length })}
								title={group.chapter}
								onclick={() => onJump(chapterKey(group))}
							>
								<span class="truncate text-slate-700">{group.chapter}</span>
								<span class="flex h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
									{#each colorCounts(group.marks) as part (part.color)}
										<span class={colorTone(part.color).bar} style:background-color={colorTone(part.color).hex} style:width={percent(part.count, group.marks.length)}></span>
									{/each}
								</span>
								<span class="text-xs text-slate-500 tabular-nums" aria-hidden="true">{group.marks.length}</span>
							</button>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	</div>
</aside>
