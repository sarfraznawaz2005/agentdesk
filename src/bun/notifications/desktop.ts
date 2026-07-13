import { Utils, PATHS } from "electrobun/bun";

/**
 * Send a real OS-level desktop notification.
 *
 * On Windows, Electrobun's Utils.showNotification requires a registered
 * Application User Model ID (AUMID) which dev-mode apps don't have, so
 * Windows silently drops the notification. Instead we spawn a hidden
 * PowerShell process that uses its own registered AUMID to fire a WinRT
 * Toast Notification — this works on Windows 10/11 without any registration.
 *
 * The app's tray icon is used as the notification logo via appLogoOverride.
 *
 * On macOS/Linux, Utils.showNotification works natively.
 */
export async function sendDesktopNotification(title: string, body: string): Promise<void> {
	if (process.platform === "win32") {
		await sendWindowsToast(title, body);
	} else {
		try {
			Utils.showNotification({ title, body });
		} catch {
			// Notification API unavailable
		}
	}
}

async function sendWindowsToast(title: string, body: string): Promise<void> {
	// Escape XML special characters for safe embedding in the toast XML
	const esc = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

	// App icon path — bundled tray icon used as the notification logo
	const iconPath = `${PATHS.VIEWS_FOLDER}/assets/tray-icon.png`.replace(/\\/g, "/");
	const iconUri = `file:///${iconPath.replace(/^\//, "")}`;

	// activationType="background" (+ no `launch` attribute) means clicking the toast body
	// does nothing beyond dismissing it — it never tries to foreground-activate an app.
	// Without this, the default "foreground" activation type asks Windows to bring the
	// notification's owning app (here, the PowerShell AUMID we borrow — see below) to the
	// front on click, which pops up an unwanted PowerShell window and steals focus.
	const toastXml = [
		`<toast activationType="background">`,
		`  <visual>`,
		`    <binding template="ToastGeneric">`,
		`      <image placement="appLogoOverride" src="${iconUri}"/>`,
		`      <text>${esc(title)}</text>`,
		`      <text>${esc(body)}</text>`,
		`    </binding>`,
		`  </visual>`,
		`</toast>`,
	].join("");

	// Single-quote escape for PowerShell here-string embedding
	const safeXml = toastXml.replace(/'/g, "''");

	const ps = [
		`[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null`,
		`[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null`,
		`$xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
		`$xml.LoadXml('${safeXml}')`,
		`$toast = New-Object Windows.UI.Notifications.ToastNotification $xml`,
		`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)`,
	].join("\n");

	try {
		// `-WindowStyle Hidden` still allocates a (hidden) console window for the process,
		// which Windows can hand focus/activation to — observed as other open windows losing
		// focus or minimizing the instant a toast is posted. `windowsHide` uses the CREATE_NO_WINDOW
		// flag instead, so no window handle is ever created for this process to begin with.
		const proc = Bun.spawn(
			["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
			{ stdout: "ignore", stderr: "ignore", windowsHide: true },
		);
		// Fire-and-forget with a 5 s safety timeout
		await Promise.race([proc.exited, new Promise<void>((r) => setTimeout(r, 5000))]);
	} catch {
		// PowerShell unavailable — silently ignore
	}
}
