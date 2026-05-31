import { z } from "zod";
import type { PluginManifest } from "./types";

const pluginSettingSchema = z.object({
	type: z.enum(["string", "number", "boolean", "array"]),
	default: z.unknown().optional(),
	description: z.string().optional(),
});

const pluginManifestSchema = z.object({
	name: z.string().min(1).regex(/^[a-z0-9-]+$/, "name must be lowercase alphanumeric with hyphens"),
	displayName: z.string().min(1),
	version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver (e.g. 1.0.0)"),
	description: z.string(),
	author: z.string(),
	permissions: z.array(z.enum(["fs", "shell", "network"])),
	tools: z.array(z.string()).optional(),
	settings: z.record(z.string(), pluginSettingSchema).optional(),
	// If false, the plugin is disabled on first install (defaults to enabled when
	// omitted). MUST be in the schema — zod strips any key it doesn't know about,
	// which previously dropped this flag and made every plugin enabled by default.
	defaultEnabled: z.boolean().optional(),
	prompt: z.string().optional(),
});

export function validateManifest(raw: unknown): { valid: true; manifest: PluginManifest } | { valid: false; errors: string[] } {
	const result = pluginManifestSchema.safeParse(raw);
	if (result.success) {
		return { valid: true, manifest: result.data };
	}
	return {
		valid: false,
		errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
	};
}
