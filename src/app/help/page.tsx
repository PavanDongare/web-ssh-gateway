import Link from 'next/link'

export default function HelpPage() {
  return (
    <div className="h-full bg-[#f4f4f5] overflow-auto">
      <div className="w-full px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-lg font-semibold text-[#09090b]">Architecture And Performance Guide</h1>
          <Link
            href="/"
            className="inline-flex items-center px-3 py-1.5 bg-white border border-[#e4e4e7] text-[#3f3f46] text-xs font-medium rounded-md hover:bg-[#f4f4f5] hover:text-[#09090b] transition-colors"
          >
            Back
          </Link>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <section className="bg-white border border-[#e4e4e7] rounded-lg p-4">
            <h2 className="text-sm font-semibold text-[#09090b] mb-2">Direct SSH Mode</h2>
            <p className="text-sm text-[#3f3f46] mb-3">
              You click a saved remote connection and the app server itself opens SSH using <span className="font-mono">ssh2</span>.
            </p>
            <pre className="text-xs font-mono text-[#3f3f46] bg-[#f4f4f5] border border-[#e4e4e7] rounded p-3 overflow-x-auto">
{`[Browser UI]
    |
    | (1) WebSocket frames
    v
[WebSSH Server]
    |
    | (2) SSH transport (ssh2)
    v
[Remote Server]
    |
    v
[Remote Shell]`}
            </pre>
            <div className="mt-3 text-xs text-[#71717a]">
              Hop view:
              <pre className="mt-1 font-mono text-[#3f3f46] bg-[#f4f4f5] border border-[#e4e4e7] rounded p-2 overflow-x-auto">{`UI -> WebSSH -> Remote`}</pre>
            </div>
          </section>

          <section className="bg-white border border-[#e4e4e7] rounded-lg p-4">
            <h2 className="text-sm font-semibold text-[#09090b] mb-2">Local Terminal Mode</h2>
            <p className="text-sm text-[#3f3f46] mb-3">
              You open the shared local tab and run commands in a local PTY (<span className="font-mono">node-pty</span>). If you then type <span className="font-mono">ssh ...</span>, SSH happens inside that local shell.
            </p>
            <pre className="text-xs font-mono text-[#3f3f46] bg-[#f4f4f5] border border-[#e4e4e7] rounded p-3 overflow-x-auto">
{`[Browser UI]
    |
    | (1) WebSocket frames
    v
[WebSSH Server]
    |
    | (2) Local PTY session
    v
[Local Shell on Host]
    |
    | (3) optional: ssh user@host
    v
[Remote Server]`}
            </pre>
            <div className="mt-3 text-xs text-[#71717a]">
              Hop views:
              <pre className="mt-1 font-mono text-[#3f3f46] bg-[#f4f4f5] border border-[#e4e4e7] rounded p-2 overflow-x-auto">{`Local-only: UI -> WebSSH -> Local PTY
Via SSH from local: UI -> WebSSH -> Local PTY -> Remote`}</pre>
            </div>
          </section>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-4">
          <section className="bg-white border border-[#e4e4e7] rounded-lg p-4">
            <h3 className="text-sm font-semibold text-[#09090b] mb-2">Why “Local” Can Feel Faster</h3>
            <p className="text-sm text-[#3f3f46] mb-2">
              If you run only local commands, there is no remote network latency. That typically feels very fast.
            </p>
            <pre className="text-xs font-mono text-[#3f3f46] bg-[#f4f4f5] border border-[#e4e4e7] rounded p-3 overflow-x-auto">
{`Local command latency ~= UI rendering + localhost WebSocket + local process scheduling

Remote SSH latency ~= above + remote network RTT + remote server response`}
            </pre>
          </section>

          <section className="bg-white border border-[#e4e4e7] rounded-lg p-4">
            <h3 className="text-sm font-semibold text-[#09090b] mb-2">When Both Feel Similar</h3>
            <ul className="text-sm text-[#3f3f46] list-disc pl-5 space-y-1">
              <li>You are running remote commands in both paths.</li>
              <li>Terminal renderer and WebSocket layer are shared.</li>
              <li>Remote command time dominates over UI transport time.</li>
            </ul>
            <pre className="mt-3 text-xs font-mono text-[#3f3f46] bg-[#f4f4f5] border border-[#e4e4e7] rounded p-3 overflow-x-auto">
{`Same remote target + same command
=> often similar perceived speed
(difference is mostly where SSH is initiated)`}</pre>
          </section>
        </div>

        <div className="bg-white border border-[#e4e4e7] rounded-lg p-4 mt-4">
          <h3 className="text-sm font-semibold text-[#09090b] mb-2">Quick A/B Test Plan</h3>
          <ol className="text-sm text-[#3f3f46] list-decimal pl-5 space-y-1">
            <li>Open a direct SSH tab to your target server.</li>
            <li>Open <span className="font-mono">local</span>, then run the same <span className="font-mono">ssh user@host</span>.</li>
            <li>Run identical commands in both tabs: <span className="font-mono">pwd</span>, <span className="font-mono">ls -la</span>, <span className="font-mono">git status</span>.</li>
            <li>Compare first-byte response feel and scroll smoothness.</li>
          </ol>
        </div>
      </div>
    </div>
  )
}
