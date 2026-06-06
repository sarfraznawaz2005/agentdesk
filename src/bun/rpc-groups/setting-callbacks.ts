// Callbacks for settings that need in-memory sync when changed via RPC.
const settingChangeCallbacks = new Map<string, (value: unknown) => void>();

export function onSettingChange(key: string, cb: (value: unknown) => void): void {
	settingChangeCallbacks.set(key, cb);
}

export { settingChangeCallbacks };
