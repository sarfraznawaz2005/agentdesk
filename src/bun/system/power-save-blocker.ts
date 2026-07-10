import type { Subprocess } from "bun";

// ---------------------------------------------------------------------------
// Keeps the system (and display) from sleeping while enabled. Electrobun has
// no powerSaveBlocker equivalent, so each platform gets a dedicated HELPER
// PROCESS that holds the block for as long as it's running (killed to release):
//   - win32:  hidden PowerShell process that P/Invokes SetThreadExecutionState
//             in a loop, re-asserting every 30s
//   - darwin: `caffeinate -d -i -w <pid>` subprocess, self-terminates if we crash
//   - linux:  `systemd-inhibit --what=sleep:idle ... sleep infinity` subprocess
// win32 originally called SetThreadExecutionState directly via bun:ffi from
// the main thread, but that measurably does NOT persist across separate calls
// (confirmed via a standalone reproduction). Switched to a dedicated helper
// process instead, matching the darwin/linux approach. That first PowerShell
// version silently crashed on every launch too: PowerShell parses a hex
// literal like 0x80000003 as a signed Int32 (-2147483645), and refuses to
// implicitly convert a negative number to the UInt32 the P/Invoke signature
// expects — a MethodException on every single call, invisible because stderr
// was discarded. Fixed by passing the flag as an unambiguous positive decimal
// literal (2147483651) instead of hex, cast to [uint32] explicitly. Verified
// end-to-end: `powercfg /requests` shows powershell.exe under DISPLAY and
// SYSTEM while this is running.
// Every branch is best-effort: failures are logged, never thrown, since this
// is a nice-to-have toggle that must never block app boot or a settings save.
// ---------------------------------------------------------------------------

let inhibitProcess: Subprocess | undefined;
let stoppingIntentionally = false;

// The PowerShell type-conversion crash was invisible for a long time because
// stderr was discarded — pipe it instead, and log if the helper process ever
// dies on its own (vs. us killing it in stopSleepBlock) so a future silent
// failure surfaces immediately instead of just quietly not blocking sleep.
function logIfProcessDiesEarly(proc: Subprocess, label: string): void {
	proc.exited.then(async (exitCode) => {
		if (stoppingIntentionally) return;
		const stderrText =
			proc.stderr instanceof ReadableStream ? (await new Response(proc.stderr).text()).trim() : "";
		console.error(`[power-save-blocker] ${label} exited unexpectedly (code ${exitCode})${stderrText ? ": " + stderrText : ""}`);
	}).catch(() => {});
}

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED, as a positive
// decimal literal — see the crash explanation above for why not hex.
const WIN32_KEEP_AWAKE_SCRIPT = `
Add-Type -Name Power -Namespace Win32 -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
$flags = [uint32]2147483651
while ($true) {
    [Win32.Power]::SetThreadExecutionState($flags) | Out-Null
    Start-Sleep -Seconds 30
}
`;

export function startSleepBlock(): void {
	try {
		if (inhibitProcess) return; // already running
		stoppingIntentionally = false;

		if (process.platform === "win32") {
			inhibitProcess = Bun.spawn(
				["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", WIN32_KEEP_AWAKE_SCRIPT],
				{ stdout: "ignore", stderr: "pipe" },
			);
			logIfProcessDiesEarly(inhibitProcess, "PowerShell keep-awake helper");
			console.log(`[power-save-blocker] startSleepBlock: spawned keep-awake PowerShell pid=${inhibitProcess.pid}`);
		} else if (process.platform === "darwin") {
			// -d: prevent display sleep, -i: prevent idle system sleep,
			// -w <pid>: caffeinate exits on its own if we crash without cleaning up.
			inhibitProcess = Bun.spawn(["caffeinate", "-d", "-i", "-w", String(process.pid)], {
				stdout: "ignore",
				stderr: "pipe",
			});
			logIfProcessDiesEarly(inhibitProcess, "caffeinate");
			console.log(`[power-save-blocker] startSleepBlock: spawned caffeinate pid=${inhibitProcess.pid}`);
		} else if (process.platform === "linux") {
			inhibitProcess = Bun.spawn(
				["systemd-inhibit", "--what=sleep:idle", "--who=AgentDesk", "--why=User enabled Prevent System Sleep", "--mode=block", "sleep", "infinity"],
				{ stdout: "ignore", stderr: "pipe" },
			);
			logIfProcessDiesEarly(inhibitProcess, "systemd-inhibit");
			console.log(`[power-save-blocker] startSleepBlock: spawned systemd-inhibit pid=${inhibitProcess.pid}`);
		}
	} catch (err) {
		console.error("[power-save-blocker] Failed to start sleep block:", err);
	}
}

export function stopSleepBlock(): void {
	try {
		stoppingIntentionally = true;
		inhibitProcess?.kill();
		inhibitProcess = undefined;
		console.log("[power-save-blocker] stopSleepBlock: released");
	} catch (err) {
		console.error("[power-save-blocker] Failed to stop sleep block:", err);
	}
}
