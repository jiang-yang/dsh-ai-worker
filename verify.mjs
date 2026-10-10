//#region smoke
/**
 * Offline smoke test for the generated client bundle.
 *
 * It plays the role of the browser: it installs a `window.__ModuleLoader__`
 * facade, a minimal React (hooks + createElement), a DOM stub, and then
 * materializes the bundle exactly as the module system does. On top of that it
 * renders the widget and walks the state machine through every mascot state, so
 * a broken bundle or a broken derivation fails here instead of in the GUI.
 *
 * Usage: node verify.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Collected failures; the process exits non-zero when this is non-empty. */
const failures = [];
/** @param {string} message */
const check = (condition, message) => {
	if (!condition) failures.push(message);
};

// ── a React stub with real render-per-call semantics ───────────────────────
/**
 * Hook state is keyed by name plus call order within the render, matching
 * React's "same hooks in the same order" contract. Each component instance gets
 * its own persistent slot map; `slotMap` is the map of the component currently
 * rendering, and a nested component's traversal temporarily swaps it. Setter
 * closures bind to the map of the instance that created them, exactly as React
 * state setters stay attached to their component across later renders.
 */
let slotMap = new Map();
let hookIndex = 0;
let renderSequence = 0;
/** Effect keys of the mounted component, in registration order. */
let renderSlots = [];
/** Last-seen dependency arrays, so effects only re-run when a dep changes. */
let effectDeps = new Map();
/** Timers created during a render, with a manual clock. */
const timers = [];
let clock = 0;
let nextTimerId = 1;

/** @returns the current hook slot key. */
const slotKey = (name) => `${hookIndex++}:${name}`;

const React = {
	createElement(type, props, ...children) {
		return { type, props: props ?? {}, children };
	},
	Fragment: Symbol('Fragment'),
	useState(initial) {
		const key = slotKey('state');
		const owner = slotMap;
		if (!owner.has(key)) owner.set(key, typeof initial === 'function' ? initial() : initial);
		return [
			owner.get(key),
			(next) => {
				applySet(owner, key, next);
				flush();
			}
		];
	},
	useRef(initial) {
		const key = slotKey('ref');
		const owner = slotMap;
		if (!owner.has(key)) owner.set(key, { current: initial });
		return owner.get(key);
	},
	useCallback(fn) {
		slotMap.set(slotKey('callback'), fn);
		return fn;
	},
	useMemo(fn) {
		const key = slotKey('memo');
		const owner = slotMap;
		if (owner.has(key)) return owner.get(key);
		const value = fn();
		owner.set(key, value);
		return value;
	},
	useEffect(fn, deps) {
		const key = slotKey('effect');
		slotMap.set(key, { fn, deps: deps === undefined ? undefined : [...deps] });
		renderSlots.push(key);
	}
};

// ── a DOM / window stub with a manual clock ────────────────────────────────
const styleTags = [];
const localStorageMap = new Map();

globalThis.React = React;
globalThis.window = {
	innerWidth: 1440,
	innerHeight: 900,
	setTimeout: (fn, delay) => {
		const id = nextTimerId++;
		timers.push({ id, at: clock + (delay ?? 0), fn });
		return id;
	},
	clearTimeout: (id) => {
		const index = timers.findIndex((timer) => timer.id === id);
		if (index >= 0) timers.splice(index, 1);
	},
	setInterval: () => nextTimerId++,
	clearInterval: () => {},
	localStorage: {
		getItem: (key) => (localStorageMap.has(key) ? localStorageMap.get(key) : null),
		setItem: (key, value) => localStorageMap.set(key, value),
		removeItem: (key) => localStorageMap.delete(key)
	}
};
globalThis.document = {
	head: { appendChild: (tag) => styleTags.push(tag) },
	querySelector: () => null,
	createElement: () => ({ dataset: {}, textContent: '' })
};

// ── load the bundle the way the module system does ─────────────────────────
const bundle = readFileSync(join(here, 'lib', 'client.js'), 'utf8');
let registration = null;
globalThis.window.__ModuleLoader__ = {
	load: (value) => {
		registration = value;
	}
};
// eslint-disable-next-line no-new-func
new Function(bundle)();

check(registration !== null, 'bundle never called window.__ModuleLoader__.load');
check(registration?.id === 'dsh-ai-worker', `bundle id is ${registration?.id}`);

const exportsObject = registration.factory((spec) => {
	if (spec === 'react') return React;
	throw new Error(`unexpected require("${spec}")`);
});

check(typeof exportsObject.apply === 'function', 'bundle does not export apply()');
check(Array.isArray(exportsObject.inject), 'bundle does not export an inject array');
check(
	exportsObject.inject.includes('slots') && exportsObject.inject.includes('sessions'),
	`inject must list slots and sessions, saw ${JSON.stringify(exportsObject.inject)}`
);

// ── apply() must register one shell.overlay entry ──────────────────────────
const registered = [];
const injected = [];
const fakeCtx = {
	effect(fn) {
		fn();
		return () => {};
	},
	slots: {
		inject(name, fn) {
			injected.push(name);
			return fn();
		},
		register(options, component) {
			registered.push({ options, component });
			return () => {};
		}
	}
};
exportsObject.apply(fakeCtx);

check(styleTags.length === 1, `expected exactly one injected stylesheet, saw ${styleTags.length}`);
check(styleTags[0]?.dataset?.plugin === 'dsh-ai-worker', 'stylesheet is not tagged with the plugin id');
check(injected.includes('shell.overlay'), 'apply() did not inject into shell.overlay');
check(registered.length === 1, `expected one slot registration, saw ${registered.length}`);
check(registered[0]?.options?.name === 'shell.overlay', 'registration targets the wrong slot');
check(registered[0]?.options?.id === 'ai-worker', 'registration has the wrong id');
check(typeof registered[0]?.component === 'function', 'registration carries no component');

// ── render the widget across every mascot state ────────────────────────────
const Widget = registered[0].component;

/**
 * Build a sessions snapshot.
 * @param overrides - partial SessionSummary fields.
 * @param listExtra - extra SessionListState fields.
 * @returns the list state.
 */
function sessionsState(overrides = {}, listExtra = {}) {
	const summary = {
		id: 's1',
		displayTitle: 'demo',
		running: false,
		blank: false,
		retainedBy: { mainView: 1 },
		updatedAt: Date.now(),
		...overrides
	};
	return {
		ids: ['s1'],
		byId: { s1: summary },
		phase: 'ready',
		projectionsBySession: {},
		...listExtra
	};
}

/**
 * Build the live status map the host publishes through `useSessionStatus`.
 * @param overrides - partial status fields for the only session.
 * @returns a Map keyed by session id.
 */
function statusState(overrides = {}) {
	return new Map([
		['s1', { running: false, pendingInteraction: undefined, completionUnread: false, ...overrides }]
	]);
}

/**
 * Call one hook setter: write the slot, then let the caller decide when to
 * re-render. Returns nothing; the harness commits through {@link flush}.
 * @param owner - the slot map of the component that owns the slot.
 * @param key - slot key.
 * @param next - value or updater.
 */
function applySet(owner, key, next) {
	owner.set(key, typeof next === 'function' ? next(owner.get(key)) : next);
	pendingFlush = true;
}

/** Props the currently mounted widget was rendered with. */
let currentProps = null;
/** Set while a commit pass is running, so re-render requests settle once. */
let flushing = false;
/** Set when a setter ran, so {@link flush} knows another pass is due. */
let pendingFlush = false;

/**
 * Perform React's post-update chain: re-render with the props of the last
 * render, then run the commit pass. Setter calls request this synchronously, and
 * requests made while a commit already runs are coalesced into it.
 */
function flush() {
	if (flushing || currentProps === null) return;
	flushing = true;
	try {
		let guard = 0;
		do {
			pendingFlush = false;
			renderSequence += 1;
			hookIndex = 0;
			const realNow = Date.now;
			Date.now = () => clock;
			try {
				Widget(currentProps);
			} finally {
				Date.now = realNow;
			}
			commitEffects();
			guard += 1;
		} while (pendingFlush && guard < 16);
	} finally {
		flushing = false;
	}
}

/**
 * Run the commit pass: every effect this mounted component registered, in
 * registration order, re-deciding through its dependency array exactly as React
 * does. Effects mutate the component's own hook scope, so this must never run
 * inside a nested component's scoped traversal.
 */
function commitEffects() {
	const realNow = Date.now;
	Date.now = () => clock;
	try {
		for (const key of renderSlots) {
			const record = slotMap.get(key);
			if (record === undefined) continue;
			if (record.deps !== undefined) {
				const seen = effectDeps.get(key);
				const changed =
					seen === undefined ||
					seen.length !== record.deps.length ||
					record.deps.some((value, index) => !Object.is(value, seen[index]));
				if (!changed) continue;
				effectDeps.set(key, [...record.deps]);
			}
			if (typeof record.fn === 'function') record.fn();
		}
	} finally {
		Date.now = realNow;
	}
}

/**
 * Render the widget once, then run its commit pass.
 * @param list - sessions list snapshot.
 * @param statuses - live session-status map (or undefined).
 * @returns the root element produced by the render.
 */
function render(list, statuses) {
	renderSequence += 1;
	hookIndex = 0;
	const realNow = Date.now;
	Date.now = () => clock;
	currentProps = {
		useSessions: (selector) => selector(list),
		useSessionStatus: statuses === undefined ? undefined : (selector) => selector(statuses),
		t: (key) => key
	};
	let element;
	try {
		element = Widget(currentProps);
	} finally {
		Date.now = realNow;
	}
	commitEffects();
	return element;
}

/**
 * Advance the manual clock and fire every timer that is due.
 * @param ms - milliseconds to advance.
 */
function tick(ms) {
	clock += ms;
	for (const timer of [...timers]) {
		if (timer.at > clock) continue;
		timers.splice(timers.indexOf(timer), 1);
		timer.fn();
	}
}

/**
 * Drop every hook slot, simulating a fresh mount of the widget. Effect
 * registrations persist: a mounted component keeps its effect list, and each
 * effect re-decides through its deps on the next commit.
 */
function resetWidget() {
	slotMap = new Map();
	renderSlots = [];
	effectDeps = new Map();
	hookIndex = 0;
}

/**
 * Simulate a brand-new browser: fresh mount and empty local storage.
 */
function resetBrowser() {
	resetWidget();
	localStorageMap.clear();
	timers.length = 0;
}

/**
 * Render a component tree the way React would: every function component in the
 * tree is invoked, so nested components such as the mascot scene really run.
 * The root element is already the product of a render and is left alone.
 * @param node - element, component, array, or primitive.
 * @param depth - recursion guard.
 * @param isRoot - true for the element handed to the walker.
 * @returns the expanded tree.
 */
function expand(node, depth = 0, isRoot = true) {
	if (depth > 32) throw new Error('component recursion too deep');
	if (node === null || node === undefined || typeof node !== 'object') return node;
	if (Array.isArray(node)) {
		const expanded = node.map((child) => expand(child, depth + 1, false));
		if (node.__state !== undefined) expanded.__state = node.__state;
		return expanded;
	}
	if (typeof node.type === 'function' && !isRoot) {
		if (node.type.prototype?.isReactComponent !== undefined) return node;
		// Each component owns its own hook scope, in the same call order as React.
		const previous = slotMap;
		const previousIndex = hookIndex;
		slotMap = new Map();
		hookIndex = 0;
		renderSequence += 1;
		try {
			return expand(node.type(node.props), depth + 1, true);
		} finally {
			slotMap = previous;
			hookIndex = previousIndex;
			renderSequence -= 1;
		}
	}
	return {
		type: node.type,
		props: node.props,
		children: (node.children ?? []).map((child) => expand(child, depth + 1, false))
	};
}

/**
 * Find every expanded node whose className contains a token.
 * @param node - expanded tree.
 * @param token - className substring.
 * @param out - accumulator.
 * @returns matching nodes.
 */
function findAll(node, token, out = []) {
	if (node === null || node === undefined || typeof node !== 'object') return out;
	if (Array.isArray(node)) {
		for (const child of node) findAll(child, token, out);
		return out;
	}
	if (typeof node.props?.className === 'string' && node.props.className.includes(token)) out.push(node);
	for (const child of node.children ?? []) findAll(child, token, out);
	return out;
}

/**
 * Flatten an element tree into its tags and the widget state attribute.
 * @param node - expanded element, array, string, or null.
 * @param out - accumulator.
 * @returns the accumulator.
 */
function flatten(node, out = []) {
	if (node === null || node === undefined || node === false || node === true) return out;
	if (Array.isArray(node)) {
		if (node.__state !== undefined) out.__state = node.__state;
		for (const child of node) flatten(child, out);
		return out;
	}
	if (typeof node === 'string' || typeof node === 'number') {
		out.push(String(node));
		return out;
	}
	if (typeof node.props?.className === 'string') out.push(node.props.className);
	if (node.props?.['data-ai-worker'] !== undefined) out.__state = node.props['data-ai-worker'];
	for (const child of node.children ?? []) flatten(child, out);
	return out;
}

/**
 * Render and flatten in one step.
 * @param list - sessions list snapshot.
 * @param statuses - live session-status map (or undefined).
 * @returns the flattened tree with the widget state on `__state`.
 */
function screen(list, statuses) {
	return flatten(expand(render(list, statuses)));
}

const states = [];
clock = Date.now();

// 摸鱼中: idle session, long after its last update.
states.push(['slacking', screen(sessionsState({ updatedAt: clock - 120000 }), statusState()).__state]);
// 敲代码中: running and the session row is still moving.
states.push(['coding', screen(sessionsState({ updatedAt: clock }), statusState({ running: true })).__state]);
// 思考中: running but the row has gone quiet.
states.push(['thinking', screen(sessionsState({ updatedAt: clock - 5000 }), statusState({ running: true })).__state]);
// 等待确认: a pending interaction for the current session.
states.push([
	'waiting',
	screen(
		sessionsState({ updatedAt: clock }),
		statusState({ running: true, pendingInteraction: { key: 'k', kind: 'approval', sessionId: 's1' } })
	).__state
]);
// 待命中: no session selected at all.
states.push(['ready', screen({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }, undefined).__state]);
// 敲代码中 again, this time without a status hook: the row's `running` and
// `updatedAt` are the only inputs, which is the host-fallback path.
states.push(['coding', screen(sessionsState({ running: true, updatedAt: clock }), undefined).__state]);

for (const [expected, actual] of states) {
	check(actual === expected, `state machine: expected "${expected}" but the widget rendered "${actual}"`);
}

// 完成任务: a running → not-running transition counts one task and celebrates.
// Fresh mount, so this section sees an empty counter and no prior transition.
resetBrowser();
render(sessionsState({ updatedAt: clock }), statusState({ running: true }));
screen(sessionsState({ updatedAt: clock }), statusState());
const celebratingTree = screen(sessionsState({ updatedAt: clock }), statusState());
check(celebratingTree.__state === 'done', `expected the completion state, saw "${celebratingTree.__state}"`);
check(celebratingTree.includes('aiw-confetti'), 'the completion state rendered no confetti layer');
check(celebratingTree.includes('aiw-piece'), 'the completion burst produced no particles');
const persistedRaw = localStorageMap.get('dsh.aiWorker.doneCount.v1');
check(typeof persistedRaw === 'string', `completing a task did not persist a counter (saw ${persistedRaw})`);
const persisted = typeof persistedRaw === 'string' ? JSON.parse(persistedRaw) : { count: -1 };
check(persisted.count === 1, `expected the counter to reach 1, saw ${persisted.count}`);
check(
	timers.some((timer) => timer.at === clock + 7000),
	'the completion burst did not schedule its own hold timer'
);

// A transition that stays idle must not count again.
screen(sessionsState({ updatedAt: clock }), statusState());
const stillOneRaw = localStorageMap.get('dsh.aiWorker.doneCount.v1');
const stillOne = typeof stillOneRaw === 'string' ? JSON.parse(stillOneRaw) : { count: -1 };
check(stillOne.count === 1, `an idle re-render must not count a task, saw ${stillOne.count}`);

// The celebration holds, then the mascot settles back into 摸鱼中.
tick(10000);
const afterHold = screen(sessionsState({ updatedAt: clock - 120000 }), statusState());
check(afterHold.__state === 'slacking', `expected the widget to settle after celebrating, saw "${afterHold.__state}"`);
check(!afterHold.includes('aiw-piece'), 'the confetti layer outlived its burst');

check(screen(sessionsState(), undefined).length > 3, 'the widget rendered an empty tree while open');

// ── interaction: collapse, close, and what survives a restart ──────────────
// Collapsing swaps the card for the mini avatar and persists the choice.
resetBrowser();
const expandedTree = expand(render(sessionsState(), undefined));
const collapseButton = findAll(expandedTree, 'aiw-btn')[0];
check(collapseButton !== undefined, 'the card has no collapse button');
const registeredEffects = renderSlots.length;
collapseButton?.props?.onClick?.();
check(registeredEffects > 0, 'no effects were registered at mount');
check(slotMap.get('1:state') === true, 'the collapse button did not flip the collapsed state');
check(localStorageMap.get('dsh.aiWorker.collapsed.v1') === '1', 'collapsing did not persist');
const collapsedTree = expand(render(sessionsState(), undefined));
check(findAll(collapsedTree, 'aiw-mini').length === 2, 'the collapsed widget did not render the mini avatar (button + face)');
check(findAll(collapsedTree, 'aiw-card').length === 0, 'the collapsed widget still rendered the card');

// A restart keeps it collapsed.
resetWidget();
check(findAll(expand(render(sessionsState(), undefined)), 'aiw-mini').length === 2, 'the collapsed state did not survive a restart');

// Closing hides the widget and persists the choice.
resetBrowser();
const closingTree = expand(render(sessionsState(), undefined));
const closeButton = findAll(closingTree, 'aiw-btn')[1];
check(closeButton !== undefined, 'the card has no close button');
closeButton?.props?.onClick?.();
check(localStorageMap.get('dsh.aiWorker.closed.v1') === '1', 'closing did not persist');
check(flatten(expand(render(sessionsState(), undefined))).length === 0, 'the closed widget still rendered');

// A restart keeps it closed.
resetWidget();
resetWidget();
check(flatten(expand(render(sessionsState(), undefined))).length === 0, 'the closed state did not survive a restart');

// The drag handle is present, keyboard reachable, and drives a persisted offset.
resetBrowser();
const draggable = expand(render(sessionsState(), undefined));
const head = findAll(draggable, 'aiw-bar')[0];
check(head !== undefined, 'the card has no drag handle');
check(typeof head?.props?.onPointerDown === 'function', 'the drag handle has no pointer handler');
check(typeof head?.props?.onKeyDown === 'function', 'the drag handle is not keyboard draggable');
check((head?.props?.tabIndex ?? -1) === 0, 'the drag handle is not keyboard reachable');
const beforeDrag = localStorageMap.get('dsh.aiWorker.pos.v1');
head?.props?.onKeyDown?.({ key: 'ArrowUp', shiftKey: false, preventDefault() {} });
check(localStorageMap.get('dsh.aiWorker.pos.v1') !== beforeDrag, 'an arrow key did not persist a new position');
check(typeof localStorageMap.get('dsh.aiWorker.pos.v1') === 'string', 'keyboard move stored nothing');
// Escape collapses, the documented keyboard shortcut.
head?.props?.onKeyDown?.({ key: 'Escape', preventDefault() {} });
check(localStorageMap.get('dsh.aiWorker.collapsed.v1') === '1', 'Escape did not collapse the widget');

if (failures.length > 0) {
	console.error('verify failed:');
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log(
	`verify ok: bundle materialized, 1 overlay entry, ${states.length} mascot states, completion path, and collapse/close/drag persistence all correct`
);
//#endregion
