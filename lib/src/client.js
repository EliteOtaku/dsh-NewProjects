"use strict";
/**
 * The browser half of the 新项目协作 panel.
 *
 * This file is deliberately a *script*, not a module: the Host's client module
 * loader fetches it as `/plugins/??dsh-newprojects/client.js` and executes it in
 * the page, where `window.__ModuleLoader__.load` registers the factory that
 * returns the Cordis plugin object. Emitting `import`/`export` here would make
 * the bundle a module and the loader would not see the registration.
 *
 * It declares the three browser globals it touches instead of pulling in the DOM
 * library: the Host half is compiled under `lib: ["ES2023"]` and must not start
 * depending on browser types.
 *
 * The panel reads its data over the same-origin route the Host half registers
 * (`/newprojects/state?rootDir=…`). That route answers only after the Host's
 * Connection plugin accepted the browser's authentication cookie, so a panel
 * that is not paired sees 401 instead of project state.
 */
/** Keys used by both registrations; the sidebar id addresses the main panel. */
const PANEL_KEY = 'newprojects';
/** Where the panel remembers the root the user last looked at. */
const ROOT_STORAGE_KEY = 'dsh-newprojects:root';
const CARD = {
    padding: '16px 20px',
    border: '1px solid var(--dsw-alias-border-primary, #e5e7eb)',
    borderRadius: '10px',
    marginBottom: '12px',
    background: 'var(--dsw-alias-bg-primary, #ffffff)',
};
const MUTED = {
    color: 'var(--dsw-alias-text-tertiary, #6b7280)',
    fontSize: '12px',
};
const NUMBER = {
    fontSize: '22px',
    fontWeight: '600',
    marginRight: '6px',
};
function storedRoot() {
    try {
        return window.localStorage === undefined ? '' : String(window.localStorage.getItem(ROOT_STORAGE_KEY) ?? '');
    }
    catch {
        return '';
    }
}
function rememberRoot(root) {
    try {
        window.localStorage.setItem(ROOT_STORAGE_KEY, root);
    }
    catch {
        // A page that refuses storage still works: the root simply stops persisting.
    }
}
/** Small labelled number used by the totals row. */
function stat(React, label, value) {
    return React.createElement('div', { style: { minWidth: '96px' } }, React.createElement('div', { style: NUMBER }, String(value ?? 0)), React.createElement('div', { style: MUTED }, label));
}
/** The whole page: a root input, a refresh, and the project's totals. */
function createPanel(React) {
    return function ProjectPanel() {
        const [root, setRoot] = React.useState(storedRoot());
        const [state, setState] = React.useState(null);
        const [error, setError] = React.useState('');
        const [busy, setBusy] = React.useState(false);
        const load = (target) => {
            const trimmed = target.trim();
            if (trimmed.length === 0) {
                setError('先填项目根目录（含 .dsh-project 的目录）。');
                return;
            }
            setBusy(true);
            setError('');
            rememberRoot(trimmed);
            fetch(`/newprojects/state?rootDir=${encodeURIComponent(trimmed)}`, {
                cache: 'no-store',
                credentials: 'same-origin',
            })
                .then((response) => {
                if (response.status === 401)
                    throw new Error('这个页面没有通过 Host 的认证，先在同一浏览器里打开一次带 token 的地址。');
                return response.json();
            })
                .then((body) => {
                if (body.ok === true) {
                    setState(body);
                    return;
                }
                throw new Error(body.message ?? body.code ?? '读取失败');
            })
                .catch((cause) => {
                setState(null);
                setError(cause instanceof Error ? cause.message : String(cause));
            })
                .finally(() => setBusy(false));
        };
        React.useEffect(() => {
            if (root.length > 0)
                load(root);
        }, []);
        const totals = state?.overview?.totals;
        const warnings = state?.overview?.warnings ?? [];
        return React.createElement('div', { style: { padding: '20px 24px' } }, React.createElement('h2', { style: { margin: '0 0 4px', fontSize: '18px' } }, '新项目协作'), React.createElement('div', { style: MUTED }, '项目根目录下的线程、知识层与资料库状态。'), React.createElement('div', { style: { display: 'flex', gap: '8px', margin: '14px 0 16px' } }, React.createElement('input', {
            value: root,
            spellCheck: false,
            placeholder: 'D:\\AI\\your-project',
            onChange: (event) => setRoot(event.target.value),
            onKeyDown: (event) => {
                if (event.key === 'Enter')
                    load(root);
            },
            style: {
                flex: '1 1 auto',
                padding: '7px 10px',
                borderRadius: '8px',
                border: '1px solid var(--dsw-alias-border-primary, #e5e7eb)',
                background: 'var(--dsw-alias-bg-secondary, #f9fafb)',
                color: 'inherit',
                fontSize: '13px',
            },
        }), React.createElement('button', { type: 'button', disabled: busy, onClick: () => load(root), style: { padding: '7px 14px' } }, busy ? '读取中…' : '刷新')), error.length > 0
            ? React.createElement('div', { style: { ...CARD, borderColor: 'var(--dsw-alias-border-danger, #ef4444)' } }, error)
            : null, state?.overview === undefined
            ? null
            : React.createElement('div', null, React.createElement('div', { style: CARD }, React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } }, React.createElement('div', { style: { fontSize: '16px', fontWeight: '600' } }, state.overview.name ?? '(未命名)'), React.createElement('div', { style: MUTED }, `${state.overview.projectId ?? ''} · r${state.overview.revision ?? 0}`)), React.createElement('div', { style: { ...MUTED, marginTop: '4px' } }, state.rootDir ?? '')), React.createElement('div', { style: CARD }, React.createElement('div', { style: { display: 'flex', gap: '20px', flexWrap: 'wrap' } }, stat(React, '线程', totals?.threads), stat(React, '进行中', totals?.active), stat(React, '等你处理', totals?.waitingOnYou), stat(React, '已解决', totals?.resolved))), warnings.length > 0
                ? React.createElement('div', { style: CARD }, React.createElement('div', { style: { fontWeight: '600', marginBottom: '6px' } }, `提醒（${warnings.length}）`), warnings.map((warning, index) => React.createElement('div', { key: String(index), style: { ...MUTED, marginTop: '4px' } }, warning)))
                : null));
    };
}
/** Sidebar rail icon: a small square with the project's initial. */
function createRow(React) {
    return function ProjectRow(owner) {
        const size = owner.size ?? 16;
        return React.createElement('span', {
            style: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: `${size}px`,
                height: `${size}px`,
                borderRadius: '4px',
                border: `1px solid ${owner.active === true ? 'var(--dsw-alias-border-accent, #2563eb)' : 'currentColor'}`,
                fontSize: `${Math.max(9, Math.round(size * 0.6))}px`,
                lineHeight: 1,
            },
        }, '项');
    };
}
/**
 * Read one service the way the restricted context allows: the builtin React
 * runtime and the slot table normally arrive as properties, but `get` is the
 * documented door and costs one fallback here instead of a silent no-panel.
 */
function serviceOf(ctx, name) {
    return ctx.get === undefined ? undefined : ctx.get(name);
}
function apply(ctx) {
    const React = ctx.React ?? serviceOf(ctx, 'React');
    const slots = ctx.slots ?? serviceOf(ctx, 'slots');
    if (React === undefined || slots === undefined)
        return () => undefined;
    const offPanel = slots.register({ name: 'main', key: PANEL_KEY }, createPanel(React));
    const offRow = slots.register({ name: 'sidebar.panellist', id: PANEL_KEY, order: 6, label: () => '新项目协作' }, createRow(React));
    return () => {
        offRow();
        offPanel();
    };
}
window.__ModuleLoader__?.load({
    id: 'dsh-newprojects',
    factory: () => {
        const module = { exports: {} };
        module.exports.apply = apply;
        return module.exports;
    },
});
