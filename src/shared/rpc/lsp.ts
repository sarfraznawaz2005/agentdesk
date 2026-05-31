export interface LspServerStatus {
	id: string;
	displayName: string;
	extensions: string[];
	status: "disabled" | "not_installed" | "installed" | "installing" | "running";
	source?: "custom" | "system" | "managed";
	prereq?: { tool: string; installUrl: string; missing: boolean };
}

export type LspRequests = {
	getLspStatus: {
		params: Record<string, never>;
		response: LspServerStatus[];
	};
	installLspServer: {
		params: { serverId: string };
		response: { success: boolean; error?: string };
	};
	uninstallLspServer: {
		params: { serverId: string };
		response: { success: boolean; error?: string };
	};
};
