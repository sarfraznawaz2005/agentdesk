import { Screen } from "electrobun/bun";
import type { AmbientDisplayDto, AmbientActivitySnapshot, AmbientAssistantPartDto, AmbientLocalVoiceStatusDto } from "../../shared/rpc/ambient";
import { getActiveProjectAgentsList, getGlobalPendingApprovalCount, getRecentGlobalActivity, broadcastToWebview } from "../engine-manager";
import { getProjectTaskStats } from "./kanban";
import { getProjectsList } from "./projects";
import { openAmbientDisplayWindow as openWindow, closeAmbientDisplayWindow as closeWindow, hasAmbientDisplayWindow } from "../ambient/window";
import { runAmbientAssistantTurn } from "../ambient/assistant";
import { generateAmbientSpeech as generateAmbientSpeechImpl } from "../ambient/tts";
import {
	LOCAL_VOICE_PROVIDER_ID,
	synthesizeLocalVoice,
	getLocalVoiceStatus,
	downloadLocalVoice,
	preloadLocalVoice,
} from "../ambient/local-voice-manager";
import { logAmbient } from "../ambient/debug-log";

export function getAmbientDisplays(): AmbientDisplayDto[] {
	return Screen.getAllDisplays().map((d) => ({
		id: d.id,
		bounds: d.bounds,
		isPrimary: d.isPrimary,
	}));
}

export async function openAmbientDisplayWindow(displayId: number): Promise<{ success: boolean; error?: string }> {
	return openWindow(displayId);
}

export function closeAmbientDisplayWindow(): { success: boolean } {
	closeWindow();
	return { success: true };
}

/**
 * Ground truth for whether a projected display window is currently open —
 * the projected window can also be closed via its OWN Exit button (or the OS,
 * e.g. Alt+F4), a path the main overlay's ProjectToDisplayControl never sees
 * since that's a separate window/JS context. Polled instead of pushed, same
 * cross-window constraint as getAmbientActivitySnapshot above.
 */
export function getAmbientProjectionState(): { projecting: boolean } {
	return { projecting: hasAmbientDisplayWindow() };
}

/**
 * Polled by the projected TV/display window (see ambient/window.ts) instead
 * of the live push-broadcast path — that window belongs to no single
 * project, so broadcastToProject's per-project routing never reaches it (see
 * docs/ambient-screen-plan.md Subsystem 7). A few seconds of staleness is an
 * acceptable trade for not touching the hot broadcast path for a passive
 * display.
 */
export async function getAmbientActivitySnapshot(): Promise<AmbientActivitySnapshot> {
	const [activeAgents, taskStatsRows, projectsList] = await Promise.all([
		Promise.resolve(getActiveProjectAgentsList()),
		Promise.resolve(getProjectTaskStats()),
		getProjectsList(),
	]);

	const activeProjectAgents: Record<string, number> = {};
	for (const { projectId, agentCount } of activeAgents) activeProjectAgents[projectId] = agentCount;

	const taskStats: Record<string, { done: number; total: number }> = {};
	for (const { projectId, done, total } of taskStatsRows) taskStats[projectId] = { done, total };

	const projectNames: Record<string, string> = {};
	for (const p of projectsList) projectNames[p.id] = p.name;

	return {
		activeProjectAgents,
		taskStats,
		projectNames,
		awaitingYou: getGlobalPendingApprovalCount(),
		activityLog: getRecentGlobalActivity(),
	};
}

// Keyed by the frontend's own turnId (ambient-screen.tsx generates one per
// turn) so a barge-in can cancel a SPECIFIC older turn without risking an
// abort of whatever newer turn superseded it. Cleared in the `finally` below
// regardless of how the turn ends, so this never grows unbounded.
const activeTurnControllers = new Map<string, AbortController>();

/**
 * Ambient Mode's "Talk to PM" entry point (docs/ambient-pm-voice-plan.md
 * Subsystem 2) — a one-shot, cross-project tool-calling turn, not a
 * per-project engine call. Tool-call/final-answer parts stream out via
 * broadcastToWebview("ambientAssistantPart", ...) as they happen, so the live
 * tool-call side pane (a later task) can render them progressively rather
 * than only after the whole turn finishes; the RPC's own return value is the
 * final answer for callers that only need the end result (e.g. TTS).
 */
export async function runAmbientAssistantQuery(question: string, turnId: string): Promise<{ answer: string }> {
	const t0 = performance.now();
	logAmbient(`runAmbientAssistantQuery(${turnId}) start — "${question}"`);
	const controller = new AbortController();
	activeTurnControllers.set(turnId, controller);
	try {
		const result = await runAmbientAssistantTurn(question, {
			onPart: (part: AmbientAssistantPartDto) => {
				logAmbient(`emitPart(${turnId}) type=${part.type}${part.type === "tool_call" ? ` tool=${part.toolName}` : ""}`);
				broadcastToWebview("ambientAssistantPart", part);
			},
			abortSignal: controller.signal,
			messageId: turnId,
		});
		logAmbient(`runAmbientAssistantQuery(${turnId}) done in ${Math.round(performance.now() - t0)}ms — "${result.answer}"`);
		return result;
	} catch (err) {
		logAmbient(`runAmbientAssistantQuery(${turnId}) failed after ${Math.round(performance.now() - t0)}ms: ${err instanceof Error ? err.message : String(err)}`);
		throw err;
	} finally {
		activeTurnControllers.delete(turnId);
	}
}

/**
 * Cancels a specific, still-in-flight ambient turn — used when a barge-in
 * starts a newer turn before an older one's backend call has resolved (see
 * docs/ambient-voice-barge-in-research.md). Reuses `runAmbientAssistantTurn`'s
 * existing `abortSignal` plumbing (already threaded through both the
 * streamText and Claude Subscription CLI paths, same mechanism the regular
 * agent "Stop" button uses) — this just supplies a real, user-triggered
 * AbortController instead of only the built-in timeout. A no-op (not an
 * error) if the turn already finished or was never tracked.
 */
export async function cancelAmbientAssistantTurn(turnId: string): Promise<{ success: boolean }> {
	const controller = activeTurnControllers.get(turnId);
	logAmbient(`cancelAmbientAssistantTurn(${turnId}) — ${controller ? "aborting" : "no controller found (already finished?)"}`);
	if (!controller) return { success: false };
	controller.abort();
	return { success: true };
}

/** Ambient Mode's configurable TTS model (docs/ambient-pm-voice-plan.md Subsystem 6). */
export async function generateAmbientSpeech(providerId: string, modelId: string, text: string): Promise<{ base64: string; mimeType: string }> {
	const t0 = performance.now();
	try {
		const result = providerId === LOCAL_VOICE_PROVIDER_ID
			? await synthesizeLocalVoice(text)
			: await generateAmbientSpeechImpl(providerId, modelId, text);
		logAmbient(`generateAmbientSpeech(${providerId}) done in ${Math.round(performance.now() - t0)}ms`);
		return result;
	} catch (err) {
		logAmbient(`generateAmbientSpeech(${providerId}) failed after ${Math.round(performance.now() - t0)}ms: ${err instanceof Error ? err.message : String(err)}`);
		throw err;
	}
}

/** Status of the offline/local TTS voice (downloaded on demand — see local-voice-manager.ts). */
export async function getAmbientLocalVoiceStatus(): Promise<AmbientLocalVoiceStatusDto> {
	return getLocalVoiceStatus();
}

/** Downloads the offline/local TTS voice's engine + model. Resolves once fully downloaded and verified; incremental progress arrives via ambientLocalVoiceStatus events. */
export async function downloadAmbientLocalVoice(): Promise<{ success: boolean }> {
	return downloadLocalVoice();
}

/** Warms up the offline voice's onnxruntime session ahead of time (see local-voice-manager.ts's preloadLocalVoice). */
export async function preloadAmbientLocalVoice(): Promise<{ success: boolean }> {
	const t0 = performance.now();
	const result = await preloadLocalVoice();
	logAmbient(`preloadAmbientLocalVoice done in ${Math.round(performance.now() - t0)}ms — success=${result.success}`);
	return result;
}

/** Relays a frontend-side [ambient] log line into the same ambient.log file — the webview has no direct filesystem access, so this is the only way its console.log-equivalent calls (see mainview/lib/log-ambient.ts) end up persisted alongside the backend's own. */
export async function logAmbientDebug(message: string): Promise<{ success: boolean }> {
	logAmbient(`[frontend] ${message}`);
	return { success: true };
}
