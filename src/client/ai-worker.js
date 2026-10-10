/**
 * 「AI 打工人」browser half — a bottom-right floating companion for the DSH Web
 * shell.
 *
 * Design notes
 * ------------
 * - Mounted through the `shell.overlay` list slot that @deepseek-ai/dsh-client-ui-layout
 *   renders, so the widget is a native part of the shell instead of a webpage.
 * - Everything is drawn from DOM boxes plus CSS keyframes: no image, no CDN, no
 *   network request of any kind. Colors read the shell's own `--dsw-*` tokens
 *   with static fallbacks, so the widget follows the light/dark theme.
 * - Mascot state is derived, never invented: the live per-session status
 *   (`useSessionStatus`: running / pendingInteraction) and the retained session
 *   row (`useSessions`) are the only inputs; "thinking" vs "coding" is
 *   decided by whether the session's event mirror has moved recently
 *   (reasoning is silent, tool calls are not).
 * - Only React (a platform seed module) and inline DOM APIs are used here, and
 *   the module body is mutation-free so the module system can materialize it lazily.
 */

/** localStorage keys. The close/collapse state survives a browser restart. */
const LS_CLOSED = 'dsh.aiWorker.closed.v1';
const LS_COLLAPSED = 'dsh.aiWorker.collapsed.v1';
const LS_POS = 'dsh.aiWorker.pos.v1';
const LS_COUNT = 'dsh.aiWorker.doneCount.v1';

/** Mascot states, in the order the state machine resolves them. */
const STATE = {
	slacking: 'slacking',
	thinking: 'thinking',
	coding: 'coding',
	waiting: 'waiting',
	done: 'done',
	ready: 'ready'
};

/** Copy for each state: the status word and the bubble under the name. */
const COPY = {
	slacking: { label: '摸鱼中', hint: '老板不在，先划一会儿' },
	thinking: { label: '思考中', hint: '正在琢磨怎么下手…' },
	coding: { label: '敲代码中', hint: '键盘已经冒烟了' },
	waiting: { label: '等待确认', hint: '需要你点个头' },
	done: { label: '完成任务', hint: '收工！' },
	ready: { label: '待命中', hint: '随时可以开工' }
};

/** Face and screen tint per state. */
const PALETTE = {
	slacking: { accent: '#7aa2ff', screen: 'rgba(122,162,255,0.16)' },
	thinking: { accent: '#b98bff', screen: 'rgba(185,139,255,0.22)' },
	coding: { accent: '#46d38a', screen: 'rgba(70,211,138,0.20)' },
	waiting: { accent: '#f5b74a', screen: 'rgba(245,183,74,0.20)' },
	done: { accent: '#46d38a', screen: 'rgba(70,211,138,0.26)' },
	ready: { accent: '#8b98a5', screen: 'rgba(139,152,165,0.16)' }
};

/** Confetti palette (self-drawn squares and circles). */
const CONFETTI_COLORS = ['#ff6b6b', '#feca57', '#48dbfb', '#1dd1a1', '#c56cf0', '#ff9f43', '#5f27cd'];

/** Bounded particle count per burst. */
const CONFETTI_MAX = 18;

/** How long a completed task stays celebrated before the mascot settles down. */
const DONE_HOLD_MS = 7000;

/** Gap of session-event silence that means "the model is writing tools, not thinking". */
const THINKING_WINDOW_MS = 2000;

/** How long without any activity before the worker admits it is slacking. */
const SLACKING_AFTER_MS = 45000;

/** Widget metrics. */
const WIDGET_WIDTH = 220;
const EDGE_GAP = 18;

//#region small helpers

/**
 * `React.createElement` alias, so this file stays valid JavaScript without a
 * JSX transform.
 * @param type - element type, tag name, or component.
 * @param props - element props (null for none).
 * @param children - child nodes.
 * @returns the created React element.
 */
const el = (type, props, ...children) => React.createElement(type, props, ...children);

/**
 * Assign a stable display name to a component function, so the shell's error
 * overlay names this plugin when something inside it throws.
 * @param component - the component function.
 * @param name - display name.
 * @returns the same component.
 */
const named = (component, name) => {
	component.displayName = name;
	return component;
};

/**
 * The session the shell is currently showing: the row the main view retains.
 * Hosts that publish no retention info fall back to an explicit `current`
 * field, then to the only session in the list.
 * @param list - the `useSessions` snapshot, or undefined on a host without it.
 * @returns the selected session id, or undefined when nothing is selected.
 */
function mainSessionId(list) {
	const byId = list?.byId;
	if (byId === undefined) return undefined;
	const rows = Object.values(byId);
	const main = rows.find((row) => (row?.retainedBy?.mainView ?? 0) > 0);
	if (main !== undefined) return main.id;
	if (typeof list.current === 'string') return list.current;
	const ids = Array.isArray(list.ids) && list.ids.length > 0 ? list.ids : rows.map((row) => row?.id);
	return ids.length === 1 ? ids[0] : undefined;
}

/**
 * @param value - a candidate clock reading.
 * @param fallback - used when the value is missing or not a usable time.
 * @returns the reading, or the fallback.
 */
const asTime = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);

/**
 * @returns today's local date key, `YYYY-MM-DD`.
 */
function todayKey() {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * @param value - parsed JSON or nothing.
 * @returns the value when it is a finite number, else 0.
 */
const asCount = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

/**
 * Read the persisted "done today" counter, resetting it on a new day.
 * @returns the counter for today.
 */
function readDoneToday() {
	try {
		const raw = window.localStorage.getItem(LS_COUNT);
		if (raw === null) return 0;
		const parsed = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return 0;
		if (parsed.date !== todayKey()) return 0;
		return asCount(parsed.count);
	} catch {
		return 0;
	}
}

/**
 * Persist the "done today" counter.
 * @param count - today's completed-task count.
 */
function writeDoneToday(count) {
	try {
		window.localStorage.setItem(LS_COUNT, JSON.stringify({ date: todayKey(), count }));
	} catch {
		/* storage unavailable (private mode) — the widget still works for this page */
	}
}

/**
 * Read one boolean flag from storage.
 * @param key - storage key.
 * @param fallback - value when the key is absent or unreadable.
 * @returns the stored flag.
 */
function readFlag(key, fallback) {
	try {
		const raw = window.localStorage.getItem(key);
		return raw === null ? fallback : raw === '1';
	} catch {
		return fallback;
	}
}

/**
 * Persist one boolean flag, ignoring storage failures.
 * @param key - storage key.
 * @param value - value to store.
 */
function writeFlag(key, value) {
	try {
		window.localStorage.setItem(key, value ? '1' : '0');
	} catch {
		/* ignore */
	}
}

/**
 * Read the dragged widget offset.
 * @returns the stored `{ right, bottom }` offset, or null when never dragged.
 */
function readPos() {
	try {
		const raw = window.localStorage.getItem(LS_POS);
		if (raw === null) return null;
		const parsed = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return null;
		if (typeof parsed.right !== 'number' || typeof parsed.bottom !== 'number') return null;
		return { right: parsed.right, bottom: parsed.bottom };
	} catch {
		return null;
	}
}

/**
 * Persist the dragged widget offset.
 * @param pos - `{ right, bottom }` offset in CSS pixels.
 */
function writePos(pos) {
	try {
		window.localStorage.setItem(LS_POS, JSON.stringify(pos));
	} catch {
		/* ignore */
	}
}

//#endregion

//#region styles

/** Plugin-scoped stylesheet id (kept unique so HMR can replace the tag). */
const STYLE_TAG_ID = 'dsh-ai-worker/ai-worker.css';

/** Widget CSS: pixel mascot, keyframes, and theme-aware surfaces. */
const CSS = `
.aiw-root{
	--aiw-bg:var(--dsw-alias-bg-layer-2,#1d2026);
	--aiw-bg-soft:var(--dsw-alias-bg-layer-1,#24272e);
	--aiw-ink:var(--dsw-alias-label-secondary,#c9d1d9);
	--aiw-ink-strong:var(--dsw-alias-label-primary,#eef2f7);
	--aiw-line:var(--dsw-alias-border-l3,rgba(255,255,255,.14));
	--aiw-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.34));
	position:absolute;
	z-index:24;
	user-select:none;
	-webkit-user-select:none;
	font-family:var(--dsw-font-family,ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif);
	color:var(--aiw-ink);
}
.aiw-card{
	box-sizing:border-box;
	width:${WIDGET_WIDTH}px;
	background:var(--aiw-bg);
	border:1px solid var(--aiw-line);
	border-radius:14px;
	box-shadow:var(--aiw-shadow);
	overflow:hidden;
	backdrop-filter:blur(8px);
}
.aiw-head{
	display:flex;
	align-items:center;
	gap:6px;
	padding:8px 8px 8px 12px;
	cursor:grab;
	touch-action:none;
	background:var(--aiw-bg-soft);
	border-bottom:1px solid var(--aiw-line);
}
.aiw-head[data-dragging="true"]{cursor:grabbing}
.aiw-title{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}
.aiw-name{font-size:11px;line-height:14px;color:var(--aiw-ink-strong);font-weight:600;letter-spacing:.2px}
.aiw-status{font-size:10px;line-height:13px;color:var(--aiw-ink)}
.aiw-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--aiw-accent,#8b98a5);box-shadow:0 0 0 3px color-mix(in srgb,var(--aiw-accent,#8b98a5) 22%,transparent)}
.aiw-btn{
	width:22px;height:22px;flex:none;display:grid;place-items:center;
	font:inherit;font-size:12px;line-height:1;color:var(--aiw-ink);
	background:transparent;border:0;border-radius:6px;cursor:pointer;padding:0;
}
.aiw-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--aiw-ink-strong)}
.aiw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:1px}
.aiw-stage{display:flex;align-items:flex-end;justify-content:center;padding:10px 8px 8px;background:var(--aiw-accent-screen,transparent)}
.aiw-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 12px 9px;font-size:10px;line-height:14px}
.aiw-hint{color:var(--aiw-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aiw-count{color:var(--aiw-ink-strong);font-variant-numeric:tabular-nums;flex:none;font-weight:600}
.aiw-badge{
	position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;padding:0 3px;
	display:grid;place-items:center;border-radius:9px;font-size:10px;line-height:1;
	color:var(--dsw-alias-label-primary-foreground,#fff);background:var(--aiw-accent,#4c8dff);
	font-variant-numeric:tabular-nums;font-weight:700;
}
.aiw-mini{
	position:relative;width:58px;height:58px;border-radius:50%;cursor:pointer;
	display:grid;place-items:center;background:var(--aiw-bg);border:1px solid var(--aiw-line);
	box-shadow:var(--aiw-shadow);padding:0;
}
.aiw-mini:hover{transform:translateY(-2px)}
.aiw-mini .aiw-mini-face{transform:scale(.92)}
.aiw-close-wrap{padding:0;font:inherit}

/* ── pixel mascot ─────────────────────────────────────────────────────── */
.aiw-px{image-rendering:pixelated}
.aiw-scene{position:relative;width:104px;height:96px}
.aiw-desk{position:absolute;left:4px;right:4px;bottom:0;height:5px;background:#4a4f5c;border-radius:2px}
.aiw-body{position:absolute;left:34px;bottom:5px;width:40px;height:40px}
.aiw-torso{position:absolute;left:8px;top:14px;width:24px;height:26px;border-radius:6px 6px 3px 3px;background:var(--aiw-shirt,#5b8def)}
.aiw-arm{position:absolute;width:7px;height:7px;border-radius:2px;background:var(--aiw-shirt,#5b8def)}
.aiw-arm.left{left:1px;top:20px}
.aiw-arm.right{right:1px;top:20px}
.aiw-head{position:absolute;left:11px;top:0;width:19px;height:18px;border-radius:4px;background:#f3d3ae;box-shadow:inset 0 -3px 0 rgba(0,0,0,.10)}
.aiw-hair{position:absolute;left:11px;top:-2px;width:19px;height:6px;border-radius:4px 4px 1px 1px;background:#2f3540}
.aiw-eye{position:absolute;top:8px;width:3px;height:3px;border-radius:1px;background:#2f3540}
.aiw-eye.l{left:16px}
.aiw-eye.r{left:23px}
.aiw-mouth{position:absolute;left:20px;top:13px;width:4px;height:2px;background:#c98b6a;border-radius:0 0 2px 2px}
.aiw-monitor{position:absolute;left:40px;bottom:26px;width:36px;height:26px;border-radius:3px;background:#2b3040;border:2px solid #454b5c;padding:3px;box-sizing:border-box;box-shadow:0 0 0 1px rgba(0,0,0,.2)}
.aiw-screen{position:relative;width:100%;height:100%;border-radius:1px;overflow:hidden;background:var(--aiw-accent-screen,#1c2030)}
.aiw-code{position:absolute;left:2px;right:2px;height:2px;background:var(--aiw-accent,#46d38a);border-radius:1px}
.aiw-code.c1{top:3px;width:60%}
.aiw-code.c2{top:7px;width:82%}
.aiw-code.c3{top:11px;width:45%}
.aiw-stand{position:absolute;left:53px;bottom:16px;width:10px;height:10px;background:#454b5c}
.aiw-base{position:absolute;left:44px;bottom:5px;width:28px;height:3px;border-radius:2px;background:#4a4f5c}
.aiw-keyboard{position:absolute;left:34px;bottom:9px;width:30px;height:5px;border-radius:2px;background:#5c6272}
.aiw-cup{position:absolute;right:2px;bottom:6px;width:9px;height:10px;background:#e8e8ec;border-radius:1px 1px 3px 3px;box-shadow:inset 0 -3px 0 #b9bcc6}
.aiw-cup::after{content:"";position:absolute;right:-4px;top:2px;width:5px;height:5px;border:2px solid #e8e8ec;border-radius:50%}
.aiw-bubble{
	position:absolute;left:2px;top:0;max-width:58px;padding:3px 6px;border-radius:9px;
	background:var(--aiw-bg-soft);border:1px solid var(--aiw-line);
	font-size:9px;line-height:12px;color:var(--aiw-ink-strong);box-shadow:0 3px 10px rgba(0,0,0,.22);
}
.aiw-bubble::after{content:"";position:absolute;left:10px;bottom:-5px;width:7px;height:7px;background:inherit;border-right:1px solid var(--aiw-line);border-bottom:1px solid var(--aiw-line);transform:rotate(45deg)}
.aiw-zzz{position:absolute;left:8px;top:-2px;font-size:11px;line-height:1;color:var(--aiw-ink-strong);font-weight:700}
.aiw-think-dots{display:inline-flex;gap:2px;vertical-align:middle}
.aiw-think-dots i{width:3px;height:3px;border-radius:50%;background:currentColor;display:block}

/* per-state animation */
.aiw-scene[data-state="coding"] .aiw-head{animation:aiw-bob .85s steps(2,end) infinite}
.aiw-scene[data-state="coding"] .aiw-arm.right{animation:aiw-type .28s steps(2,end) infinite}
.aiw-scene[data-state="coding"] .aiw-code.c1,
.aiw-scene[data-state="coding"] .aiw-code.c2,
.aiw-scene[data-state="coding"] .aiw-code.c3{animation:aiw-scan 1.15s ease-in-out infinite}
.aiw-scene[data-state="coding"] .aiw-code.c2{animation-delay:.18s}
.aiw-scene[data-state="coding"] .aiw-code.c3{animation-delay:.36s}
.aiw-scene[data-state="thinking"] .aiw-head{animation:aiw-tilt 2.4s ease-in-out infinite}
.aiw-scene[data-state="thinking"] .aiw-code{animation:aiw-blink 1.4s steps(1,end) infinite}
.aiw-scene[data-state="thinking"] .aiw-think-dots i{animation:aiw-dot 1.2s ease-in-out infinite}
.aiw-scene[data-state="thinking"] .aiw-think-dots i:nth-child(2){animation-delay:.16s}
.aiw-scene[data-state="thinking"] .aiw-think-dots i:nth-child(3){animation-delay:.32s}
.aiw-scene[data-state="waiting"] .aiw-head{animation:aiw-lean 1.8s ease-in-out infinite}
.aiw-scene[data-state="waiting"] .aiw-body{animation:aiw-tap 1.1s ease-in-out infinite}
.aiw-scene[data-state="done"] .aiw-body{animation:aiw-jump .52s ease-out 2}
.aiw-scene[data-state="done"] .aiw-arm.left{animation:aiw-cheer .52s ease-out 2}
.aiw-scene[data-state="done"] .aiw-arm.right{animation:aiw-cheer .52s ease-out .12s 2}
.aiw-scene[data-state="done"] .aiw-screen{background:rgba(70,211,138,.4)}
.aiw-scene[data-state="slacking"] .aiw-head{animation:aiw-bob 3.1s ease-in-out infinite}
.aiw-scene[data-state="slacking"] .aiw-body{animation:aiw-sway 3.4s ease-in-out infinite}
.aiw-scene[data-state="slacking"] .aiw-cup{animation:aiw-wobble 2.2s ease-in-out infinite}
.aiw-scene[data-state="slacking"] .aiw-screen{opacity:.45}
.aiw-scene[data-state="slacking"] .aiw-zzz{animation:aiw-zzz 2.6s ease-in-out infinite}
.aiw-scene[data-state="ready"] .aiw-head{animation:aiw-bob 2.6s ease-in-out infinite}

.aiw-confetti{position:fixed;left:50%;bottom:0;width:0;height:0;pointer-events:none;z-index:2147483647}
.aiw-piece{position:absolute;left:0;bottom:0;width:7px;height:7px;border-radius:1px;opacity:0;animation:aiw-fly var(--aiw-dur,1500ms) cubic-bezier(.2,.6,.35,1) forwards}

@keyframes aiw-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.5px)}}
@keyframes aiw-tilt{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(4deg)}}
@keyframes aiw-lean{0%,100%{transform:translateY(-1px) rotate(-2deg)}50%{transform:translateY(0) rotate(3deg)}}
@keyframes aiw-sway{0%,100%{transform:translateX(-1px)}50%{transform:translateX(1px)}}
@keyframes aiw-tap{0%,100%{transform:translateY(0)}40%{transform:translateY(-2px)}}
@keyframes aiw-jump{0%,100%{transform:translateY(0)}35%{transform:translateY(-14px)}}
@keyframes aiw-cheer{0%,100%{transform:translateY(0)}40%{transform:translateY(-11px)}}
@keyframes aiw-type{0%,100%{transform:translateY(0)}50%{transform:translateY(3px)}}
@keyframes aiw-scan{0%,100%{opacity:.35;transform:translateX(0)}50%{opacity:1;transform:translateX(2px)}}
@keyframes aiw-blink{0%,49%{opacity:1}50%,100%{opacity:.25}}
@keyframes aiw-dot{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-2px)}}
@keyframes aiw-zzz{0%{opacity:0;transform:translate(0,2px) scale(.85)}30%{opacity:1}100%{opacity:0;transform:translate(6px,-10px) scale(1.1)}}
@keyframes aiw-wobble{0%,100%{transform:rotate(0)}50%{transform:rotate(-5deg)}}
@keyframes aiw-fly{
	0%{opacity:0;transform:translate3d(0,0,0) scale(.4) rotate(0)}
	12%{opacity:1}
	100%{opacity:0;transform:translate3d(var(--aiw-dx,0),var(--aiw-dy,-320px),0) scale(1) rotate(var(--aiw-rot,240deg))}
}

@media (prefers-reduced-motion:reduce){
	.aiw-root *{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition:none !important}
}
`;

/**
 * Inject the widget stylesheet exactly once per page, keyed by a plugin-scoped
 * tag id so a hot reload replaces rather than duplicates it.
 */
function ensureStyles() {
	const tagId = STYLE_TAG_ID;
	const existing = document.querySelector(`style[data-plugin-css="${tagId}"]`);
	if (existing !== null) return;
	const tag = document.createElement('style');
	tag.dataset.plugin = 'dsh-ai-worker';
	tag.dataset.pluginCss = tagId;
	tag.textContent = CSS;
	document.head.appendChild(tag);
}

//#endregion

//#region view pieces

/**
 * The pixel worker: desk, monitor, keyboard, coffee, and the face — every shape
 * is a DOM box, so the whole character is CSS.
 * @param props - `state` selects the animation and `accent` the screen tint.
 * @returns the scene element.
 */
const WorkerScene = named(function WorkerScene({ state, accent }) {
	const thought = state === STATE.thinking;
	const waiting = state === STATE.waiting;
	const slacking = state === STATE.slacking;
	const celebrating = state === STATE.done;

	return el('div', {
		className: 'aiw-scene',
		'data-state': state,
		style: {
			'--aiw-accent': accent,
			'--aiw-accent-screen': PALETTE[state].screen
		}
	},
		slacking && el('div', { className: 'aiw-zzz', 'aria-hidden': 'true' }, 'z'),
		thought && el('div', { className: 'aiw-bubble' },
			'思考',
			el('span', { className: 'aiw-think-dots', 'aria-hidden': 'true' },
				el('i', null), el('i', null), el('i', null))
		),
		waiting && el('div', { className: 'aiw-bubble' }, '需要确认'),
		celebrating && el('div', { className: 'aiw-bubble' }, '完成啦！'),
		el('div', { className: 'aiw-monitor' },
			el('div', { className: 'aiw-screen' },
				el('div', { className: 'aiw-code c1' }),
				el('div', { className: 'aiw-code c2' }),
				el('div', { className: 'aiw-code c3' })
			)
		),
		el('div', { className: 'aiw-stand' }),
		el('div', { className: 'aiw-body' },
			el('div', { className: 'aiw-torso' }),
			el('div', { className: 'aiw-arm left' }),
			el('div', { className: 'aiw-arm right' })
		),
		el('div', { className: 'aiw-head' }),
		el('div', { className: 'aiw-hair' }),
		el('div', { className: 'aiw-eye l' }),
		el('div', { className: 'aiw-eye r' }),
		el('div', { className: 'aiw-mouth' }),
		el('div', { className: 'aiw-keyboard' }),
		el('div', { className: 'aiw-cup' }),
		el('div', { className: 'aiw-base' }),
		el('div', { className: 'aiw-desk' })
	);
}, 'WorkerScene');

/**
 * The confetti burst. Rendered in a zero-size fixed container so it never
 * changes layout and never intercepts a pointer.
 * @param props - `pieces` is the current burst.
 * @returns the overlay element, or null when there is no burst.
 */
const Confetti = named(function Confetti({ pieces }) {
	if (pieces.length === 0) return null;
	return el('div', { className: 'aiw-confetti', 'aria-hidden': 'true' },
		pieces.map((piece) => el('span', {
			key: piece.id,
			className: 'aiw-piece',
			style: {
				background: piece.color,
				borderRadius: piece.round ? '50%' : '1px',
				width: `${piece.size}px`,
				height: `${piece.size}px`,
				'--aiw-dx': `${piece.dx}px`,
				'--aiw-dy': `${piece.dy}px`,
				'--aiw-rot': `${piece.rot}deg`,
				'--aiw-dur': `${piece.dur}ms`
			}
		}))
	);
}, 'Confetti');

//#endregion

//#region the widget

/**
 * Build one confetti burst centred in the viewport (above the widget, which
 * sits in the bottom-right corner).
 * @param nextId - mutable source of particle ids.
 * @returns the particle list.
 */
function makeConfetti(nextId) {
	const pieces = [];
	for (let index = 0; index < CONFETTI_MAX; index += 1) {
		const angle = (-160 + Math.random() * 140) * (Math.PI / 180);
		const distance = 120 + Math.random() * 260;
		pieces.push({
			id: nextId.value++,
			color: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
			size: 5 + Math.floor(Math.random() * 6),
			round: Math.random() < 0.35,
			dx: Math.round(Math.cos(angle) * distance),
			dy: -Math.round(Math.abs(Math.sin(angle)) * distance + 60),
			rot: Math.round((Math.random() - 0.5) * 900),
			dur: 1200 + Math.round(Math.random() * 900)
		});
	}
	return pieces;
}

/**
 * The floating 「AI 打工人」window: drag, collapse, and close, with the mascot
 * driven by live session state.
 * @param props - slot currency: the `useSessions` list hook, the
 *   `useSessionStatus` live status map when the shell supplies one, and the
 *   translator.
 * @returns the widget, or null while the user has closed it.
 */
const AiWorkerWidget = named(function AiWorkerWidget(props) {
	const useSessions = props.useSessions;
	const useStatus = props.useSessionStatus;
	const t =
		typeof props.t === 'function'
			? props.t
			: (_key, fallback) => (typeof fallback === 'string' ? fallback : _key);

	const [closed, setClosed] = React.useState(() => readFlag(LS_CLOSED, false));
	const [collapsed, setCollapsed] = React.useState(() => readFlag(LS_COLLAPSED, false));
	const [pos, setPos] = React.useState(() => readPos() ?? { right: EDGE_GAP, bottom: EDGE_GAP });
	const [dragging, setDragging] = React.useState(false);
	const [doneToday, setDoneToday] = React.useState(() => readDoneToday());
	const [celebrating, setCelebrating] = React.useState(false);
	const [pieces, setPieces] = React.useState([]);
	const [now, setNow] = React.useState(() => Date.now());

	const dragRef = React.useRef(null);
	const burstRef = React.useRef(0);
	const burstTimer = React.useRef(0);
	const particleId = React.useRef(0);
	const wasRunning = React.useRef(null);
	const startedAt = React.useRef(0);

	// Two subscriptions, both identity-stable: the list snapshot changes only
	// when the list store publishes, and the status map only when the host
	// reports a status change, so no equality function is needed. `useSessions`
	// carries the rows (ids / byId); `useSessionStatus` is the live map that
	// actually moves while a turn is in flight.
	const list = typeof useSessions === 'function' ? useSessions((state) => state) : undefined;
	const statuses = typeof useStatus === 'function' ? useStatus((state) => state) : undefined;

	const currentId = mainSessionId(list);
	const summary = list === undefined || currentId === undefined ? undefined : list.byId[currentId];
	const status = currentId === undefined || statuses === undefined ? undefined : statuses.get(currentId);
	const running = status !== undefined ? status.running === true : summary !== undefined && summary.running === true;
	const jobs = list === undefined || currentId === undefined ? undefined : list.jobsBySession?.[currentId];
	const liveJobs = jobs === undefined ? 0 : jobs.filter((job) => job.status === 'running' || job.status === 'stopping').length;
	const waiting = status !== undefined && status.pendingInteraction !== undefined;

	// The mascot state, most specific first. While the agent runs, a session row
	// whose `updatedAt` is still moving means it is producing; a row that has
	// gone quiet usually means the model is reasoning before the next tool call.
	// Without a visible row (or on a quiet host) the clock alone tells the story.
	let state = STATE.ready;
	if (waiting) state = STATE.waiting;
	else if (running) {
		const anchor = asTime(summary?.updatedAt, 0) || startedAt.current || now;
		const quietFor = anchor === 0 ? Number.POSITIVE_INFINITY : now - anchor;
		state = quietFor > THINKING_WINDOW_MS ? STATE.thinking : STATE.coding;
	} else if (celebrating) state = STATE.done;
	else if (currentId === undefined) state = STATE.ready;
	else if (now - asTime(summary?.updatedAt, now) > SLACKING_AFTER_MS) state = STATE.slacking;

	// Heartbeat: refresh the clock that drives the quiet/celebrate windows.
	React.useEffect(() => {
		if (closed) return undefined;
		const beat = window.setInterval(() => {
			setNow(Date.now());
		}, 400);
		return () => window.clearInterval(beat);
	}, [closed]);

	// Remember when the current turn started, so the thinking/coding split
	// still has a clock on hosts that publish no per-row `updatedAt`.
	React.useEffect(() => {
		startedAt.current = running ? startedAt.current || Date.now() : 0;
	}, [running]);

	// A finished turn (running true → false) is one completed task: count it,
	// celebrate it, and drop a confetti burst.
	React.useEffect(() => {
		const previous = wasRunning.current;
		wasRunning.current = running;
		if (previous !== true || running) return;
		setDoneToday((count) => {
			const next = count + 1;
			writeDoneToday(next);
			return next;
		});
		burstRef.current += 1;
		const token = burstRef.current;
		setCelebrating(true);
		setPieces(makeConfetti(particleId));
		burstTimer.current = window.setTimeout(() => {
			if (burstRef.current !== token) return;
			setCelebrating(false);
			setPieces([]);
		}, DONE_HOLD_MS);
	}, [running]);

	React.useEffect(() => () => window.clearTimeout(burstTimer.current), []);

	// Persisted presentation state.
	React.useEffect(() => writeFlag(LS_CLOSED, closed), [closed]);
	React.useEffect(() => writeFlag(LS_COLLAPSED, collapsed), [collapsed]);

	// ── drag ────────────────────────────────────────────────────────────────
	const clamp = React.useCallback((next) => {
		const width = window.innerWidth;
		const height = window.innerHeight;
		const box = dragRef.current?.box ?? { width: WIDGET_WIDTH, height: 150 };
		return {
			right: Math.min(Math.max(next.right, 4), Math.max(4, width - box.width - 4)),
			bottom: Math.min(Math.max(next.bottom, 4), Math.max(4, height - box.height - 4))
		};
	}, []);

	const onPointerDown = React.useCallback((event) => {
		if (event.button !== undefined && event.button !== 0) return;
		const root = dragRef.current;
		if (root === null) return;
		const rect = root.element.getBoundingClientRect();
		root.box = { width: rect.width, height: rect.height };
		root.origin = { x: event.clientX, y: event.clientY };
		root.start = { right: pos.right, bottom: pos.bottom };
		root.moved = false;
		root.active = true;
		setDragging(true);
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			/* capture is a nicety; the move/up handlers on the same node still work */
		}
	}, [pos]);

	const onPointerMove = React.useCallback((event) => {
		const root = dragRef.current;
		if (root === null || !root.active) return;
		const dx = event.clientX - root.origin.x;
		const dy = event.clientY - root.origin.y;
		if (!root.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
		root.moved = true;
		event.preventDefault();
		const next = clamp({
			right: root.start.right - dx,
			bottom: root.start.bottom - dy
		});
		root.latest = next;
		setPos(next);
	}, [clamp]);

	const onPointerUp = React.useCallback(() => {
		const root = dragRef.current;
		if (root === null || !root.active) return;
		root.active = false;
		setDragging(false);
		if (root.moved && root.latest !== undefined) writePos(root.latest);
	}, []);

	const onKeyDown = React.useCallback((event) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			setCollapsed(true);
			return;
		}
		const step = event.shiftKey ? 24 : 8;
		const deltas = {
			ArrowUp: { right: 0, bottom: step },
			ArrowDown: { right: 0, bottom: -step },
			ArrowLeft: { right: step, bottom: 0 },
			ArrowRight: { right: -step, bottom: 0 }
		};
		const delta = deltas[event.key];
		if (delta === undefined) return;
		event.preventDefault();
		setPos((current) => {
			const next = clamp({ right: current.right + delta.right, bottom: current.bottom + delta.bottom });
			writePos(next);
			return next;
		});
	}, [clamp]);

	if (closed) return null;

	const palette = PALETTE[state];
	const statusText = t(`status.${state}`, COPY[state].label);
	const hintText =
		running && liveJobs > 0
			? t('hint.jobs', `${liveJobs} 个后台任务在跑`)
			: t(`hint.${state}`, COPY[state].hint);
	const countText = t('count.today', `今日完成 ${doneToday} 件`);
	const rootStyle = {
		right: `${pos.right}px`,
		bottom: `${pos.bottom}px`,
		'--aiw-accent': palette.accent,
		'--aiw-accent-screen': palette.screen
	};

	const dragProps = {
		ref: (node) => {
			if (dragRef.current === null) dragRef.current = { element: node, active: false, moved: false };
			else dragRef.current.element = node;
		},
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onPointerCancel: onPointerUp,
		onKeyDown,
		tabIndex: 0,
		role: 'button',
		'aria-label': t('drag.aria', `拖动或折叠 AI 打工人（当前${statusText}）`)
	};

	const head = el('div', {
		className: 'aiw-head',
		'data-dragging': dragging ? 'true' : undefined,
		...dragProps
	},
		el('span', { className: 'aiw-dot', 'aria-hidden': 'true' }),
		el('span', { className: 'aiw-title' },
			el('span', { className: 'aiw-name' }, t('name', 'AI 打工人')),
			el('span', { className: 'aiw-status' }, statusText)
		),
		el('button', {
			type: 'button',
			className: 'aiw-btn',
			title: t('collapse', '折叠'),
			'aria-label': t('collapse', '折叠'),
			onPointerDown: (event) => event.stopPropagation(),
			onClick: () => setCollapsed(true)
		}, '—'),
		el('button', {
			type: 'button',
			className: 'aiw-btn',
			title: t('close', '关闭（记住选择）'),
			'aria-label': t('close', '关闭'),
			onPointerDown: (event) => event.stopPropagation(),
			onClick: () => setClosed(true)
		}, '✕')
	);

	const card = el('div', { className: 'aiw-card' },
		head,
		el('div', { className: 'aiw-stage' },
			el('div', { className: 'aiw-px' }, el(WorkerScene, { state, accent: palette.accent }))
		),
		el('div', { className: 'aiw-foot' },
			el('span', { className: 'aiw-hint', title: hintText }, hintText),
			el('span', { className: 'aiw-count' }, countText)
		)
	);

	const miniFace = el('div', { className: 'aiw-mini-face aiw-px' }, el(WorkerScene, { state, accent: palette.accent }));
	const mini = el('button', {
		type: 'button',
		className: 'aiw-mini',
		title: t('expand', `展开 AI 打工人 · ${statusText}`),
		'aria-label': t('expand', `展开 AI 打工人，当前${statusText}`),
		onClick: () => setCollapsed(false)
	},
		miniFace,
		doneToday > 0 ? el('span', { className: 'aiw-badge', 'aria-hidden': 'true' }, String(doneToday)) : null
	);

	return el(React.Fragment, null,
		el('div', { className: 'aiw-root', style: rootStyle, 'data-ai-worker': state, 'data-now': now },
			collapsed ? mini : card
		),
		el(Confetti, { pieces })
	);
}, 'AiWorkerWidget');

//#endregion

//#region plugin body

/** Required services: the overlay slot registry and the session list hook. */
const inject = ['slots', 'sessions'];

/**
 * Client plugin body: inject the stylesheet and contribute the widget to the
 * shell overlay.
 * @param ctx - client root context.
 */
function apply(ctx) {
	ctx.effect(() => {
		ensureStyles();
	}, 'ai-worker: stylesheet');
	ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
		name: 'shell.overlay',
		id: 'ai-worker',
		order: 60
	}, AiWorkerWidget)), 'ai-worker: overlay widget');
}

//#endregion
