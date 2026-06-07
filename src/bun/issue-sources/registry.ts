import type { IssueSource } from "../../shared/rpc/issues";
import { getIssueSourceDescriptor } from "../../shared/rpc/issues";
import type { IssueSourceAdapter } from "./types";
import { githubAdapter } from "./github";
import { jiraAdapter } from "./jira";
import { linearAdapter } from "./linear";
import { gitlabAdapter } from "./gitlab";
import { trelloAdapter } from "./trello";
import { kanboardAdapter } from "./kanboard";

const ADAPTERS: Record<IssueSource, IssueSourceAdapter> = {
	github: githubAdapter,
	jira: jiraAdapter,
	linear: linearAdapter,
	gitlab: gitlabAdapter,
	trello: trelloAdapter,
	kanboard: kanboardAdapter,
};

export function getAdapter(source: IssueSource): IssueSourceAdapter {
	const adapter = ADAPTERS[source];
	if (!adapter) throw new Error(`Unknown issue source: ${source}`);
	return adapter;
}

export function allSources(): IssueSource[] {
	return Object.keys(ADAPTERS) as IssueSource[];
}

/**
 * Validate that a config object has every field the source's descriptor marks
 * as required. Returns a human-readable error, or null if complete.
 */
export function validateRequiredFields(source: IssueSource, config: Record<string, string>): string | null {
	const descriptor = getIssueSourceDescriptor(source);
	if (!descriptor) return `Unknown issue source: ${source}`;
	const missing = descriptor.fields
		.filter((f) => f.required && !(config[f.key] && config[f.key].trim()))
		.map((f) => f.label);
	if (missing.length > 0) return `Missing required field(s): ${missing.join(", ")}`;
	return null;
}
