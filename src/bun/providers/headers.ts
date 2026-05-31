import os from "os";

/**
 * Common HTTP headers injected into every outgoing AI provider request.
 * Evaluated once at module load time so os calls are not repeated per request.
 */
export const PROVIDER_HEADERS: Record<string, string> = {
	"User-Agent": `opencode/1.2.26 gitlab-ai-provider/1.0.0 (${os.platform()} ${os.release()}; ${os.arch()})`,
	"HTTP-Referer": "https://opencode.ai/",
	"X-Title": "opencode",
};
