/**
 * Widget styles, injected into the shadow root so the host page's CSS can neither break nor restyle it.
 *
 * Buttons are navy with white text. Emerald is only for signs that something is live or done (the status dot and the
 * tick), never for a button or a link. Every colour is a variable on :host, so the look is set in one place.
 */
export const STYLES = `
:host { all: initial; --navy: #0b1f3a; --navy-hover: #1e3a5f; --navy-active: #071426; --ring: #6366f1; --line: #e2e8f0; --muted: #475569; --soft: #f8fafc; --ok: #047857; --ok-bg: #ecfdf5; --live: #059669; --warn: #b45309; --warn-bg: #fffbeb; --bad: #b91c1c; --bad-bg: #fef2f2; --scroll: #cbd5e1; --scroll-hover: #94a3b8; font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--navy); color-scheme: light; }
*, *::before, *::after { box-sizing: border-box; }
.overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(11, 31, 58, 0.55); }
.card { display: flex; flex-direction: column; width: 100%; max-width: 440px; max-height: calc(100vh - 32px); overflow: hidden; background: #fff; border-radius: 20px; box-shadow: 0 20px 50px rgba(11, 31, 58, 0.3); outline: none; }
.inline .card { max-height: min(720px, calc(100vh - 32px)); box-shadow: 0 1px 3px rgba(11, 31, 58, 0.12), 0 8px 24px rgba(11, 31, 58, 0.08); }
.head { display: grid; grid-template-columns: 40px 1fr 40px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.slot { display: flex; justify-content: center; min-height: 36px; }
.title { margin: 0; text-align: center; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.nav { appearance: none; width: 36px; height: 36px; border: 0; border-radius: 10px; background: none; font: inherit; font-size: 20px; line-height: 1; color: var(--muted); cursor: pointer; }
.nav:hover { background: #f1f5f9; color: var(--navy); }
.nav:active { background: var(--line); }
.nav:focus-visible, .link:focus-visible, .network:focus-visible, .token:focus-visible, .copy-btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.steps { display: flex; gap: 6px; margin: 0; padding: 12px 20px 0; list-style: none; }
.steps:empty { display: none; }
.step { flex: 1; height: 4px; border-radius: 999px; background: var(--line); }
.step.on { background: var(--navy); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.body { flex: 1 1 auto; min-height: 0; overflow-x: hidden; overflow-y: auto; overflow-wrap: anywhere; padding: 20px; scrollbar-width: thin; scrollbar-color: var(--scroll) transparent; }
.foot { padding: 12px 20px; border-top: 1px solid var(--line); background: var(--soft); text-align: center; font-size: 12px; color: var(--muted); }
h2 { margin: 0 0 4px; font-size: 20px; line-height: 1.25; letter-spacing: -0.01em; }
p { margin: 0 0 12px; color: var(--muted); }
.muted { color: var(--muted); font-size: 13px; }
.fine { margin: 12px 0 0; text-align: center; font-size: 12px; color: var(--muted); }
.desc { font-weight: 600; }
.amount { margin: 4px 0 8px; font-size: 34px; font-weight: 800; line-height: 1.15; letter-spacing: -0.03em; overflow-wrap: anywhere; }
.amount.long { font-size: 24px; }
.amount.longer { font-size: 18px; }
.mono { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
.btn { appearance: none; display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; border: 1px solid transparent; border-radius: 12px; padding: 13px 16px; font: inherit; font-weight: 600; color: #fff; background: var(--navy); cursor: pointer; transition: background-color 0.15s, border-color 0.15s; }
.btn:hover { background: var(--navy-hover); }
.btn:active { background: var(--navy-active); }
.btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.btn:disabled { background: #e2e8f0; color: #94a3b8; cursor: not-allowed; }
.btn.secondary { color: var(--navy); background: #fff; border-color: #cbd5e1; }
.btn.secondary:hover { background: var(--soft); border-color: var(--navy); }
.btn.secondary:active { background: #f1f5f9; }
.link { appearance: none; border: 0; background: none; padding: 0; font: inherit; color: var(--navy); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.link:hover { color: var(--navy-hover); }
.back-link { margin-bottom: 12px; display: inline-block; }
.field { margin: 12px 0; }
.field label { display: block; margin-bottom: 6px; font-weight: 600; }
input.text { width: 100%; border: 1px solid #cbd5e1; border-radius: 12px; padding: 11px 12px; font: inherit; color: var(--navy); background: #fff; }
input.text:focus { outline: 2px solid var(--ring); outline-offset: 1px; border-color: var(--ring); }
input.text.bad { border-color: var(--bad); }
.note { margin: 12px 0; padding: 10px 12px; border-radius: 12px; font-size: 13px; }
.note.error { background: var(--bad-bg); color: var(--bad); }
.note.warn { background: var(--warn-bg); color: var(--warn); }
.note.ok { background: var(--ok-bg); color: var(--ok); }
.note.info { background: #f1f5f9; color: var(--muted); }
.chain { display: flex; align-items: center; gap: 8px; margin: 16px 0 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.chain::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--tint, #94a3b8); }
.tokens { display: flex; flex-direction: column; gap: 6px; }
.rows { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
.network, .token { appearance: none; display: flex; align-items: center; gap: 12px; width: 100%; border: 1px solid var(--line); border-radius: 12px; padding: 9px 12px; font: inherit; font-weight: 600; text-align: left; color: var(--navy); background: #fff; cursor: pointer; }
.network:hover, .token:hover { border-color: var(--navy); background: var(--soft); }
.network:active, .token:active { background: #f1f5f9; }
.network .name, .token .sym { flex: 1; }
.token small { font-weight: 400; font-size: 11px; color: var(--muted); }
.go { color: #94a3b8; font-size: 18px; line-height: 1; }
.badge { position: relative; flex: none; display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; overflow: hidden; border-radius: 50%; font-size: 13px; font-weight: 800; color: var(--navy); background: #f1f5f9; background: color-mix(in srgb, var(--tint, #64748b) 16%, #fff); }
.badge img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; }
.badge.has-img { color: transparent; background: #fff; }
.badge.has-img img { opacity: 1; }
.pill { display: flex; align-items: center; gap: 10px; }
[data-chain="base"] { --tint: #0052ff; }
[data-chain="eth"] { --tint: #627eea; }
[data-chain="arb"] { --tint: #28a0f0; }
[data-chain="op"] { --tint: #ff0420; }
[data-chain="pol"] { --tint: #8247e5; }
[data-chain="bsc"] { --tint: #f0b90b; }
[data-chain="avax"] { --tint: #e84142; }
[data-chain="sol"] { --tint: #9945ff; }
[data-chain="near"] { --tint: #00b894; }
[data-chain="btc"] { --tint: #f7931a; }
[data-chain="tron"] { --tint: #eb0029; }
.picked { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; margin-bottom: 4px; border: 1px solid var(--line); border-radius: 12px; background: var(--soft); }
.pay-top { text-align: center; }
.qr { display: flex; justify-content: center; margin: 12px 0; }
.qr svg { width: 176px; height: 176px; border: 1px solid var(--line); border-radius: 12px; padding: 6px; background: #fff; }
.copy-row { display: flex; align-items: center; gap: 8px; margin: 4px 0 12px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--soft); }
.copy-row .value { flex: 1; min-width: 0; font-size: 13px; word-break: break-all; }
.copy-btn { appearance: none; flex: none; border: 1px solid #cbd5e1; border-radius: 8px; padding: 5px 10px; font: inherit; font-size: 12px; font-weight: 600; color: var(--navy); background: #fff; cursor: pointer; }
.copy-btn:hover { border-color: var(--navy); background: var(--soft); }
.copy-btn:active { background: #f1f5f9; }
.label { margin-top: 10px; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.memo { border: 2px solid var(--warn); background: var(--warn-bg); }
.status { display: flex; align-items: center; justify-content: center; gap: 10px; margin: 14px 0 4px; font-weight: 600; }
.dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: #94a3b8; }
.dot.live { background: var(--live); animation: pulse 1.4s ease-in-out infinite; }
.dot.good { background: var(--live); }
.dot.warn { background: var(--warn); }
.dot.bad { background: var(--bad); }
@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.8); } }
.tick { width: 64px; height: 64px; margin: 4px auto 12px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--ok-bg); color: var(--ok); font-size: 34px; }
.center { text-align: center; }
.links { margin: 12px 0 16px; padding: 0; list-style: none; text-align: center; font-size: 13px; }
.spinner { margin: 28px auto; width: 28px; height: 28px; border: 3px solid var(--line); border-top-color: var(--navy); border-radius: 50%; animation: spin 0.8s linear infinite; }
.spin { flex: none; width: 16px; height: 16px; border: 2px solid rgba(255, 255, 255, 0.35); border-top-color: #fff; border-radius: 50%; animation: spin 0.8s linear infinite; }
.btn:disabled .spin { border-color: #cbd5e1; border-top-color: #64748b; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dot.live, .spinner, .spin { animation: none; } .btn { transition: none; } }
@media (max-width: 480px) { .overlay { padding: 0; align-items: flex-end; } .card { max-width: none; border-radius: 20px 20px 0 0; max-height: 92vh; } }
@supports not (scrollbar-color: auto) { .body::-webkit-scrollbar { width: 10px; } .body::-webkit-scrollbar-track { background: transparent; } .body::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: var(--scroll); background-clip: content-box; } .body::-webkit-scrollbar-thumb:hover { background: var(--scroll-hover); background-clip: content-box; } }
`;
