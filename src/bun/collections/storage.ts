// Attachment file storage for Collections — download-only, never inlined into
// the DB or previewed in-app (see schema.ts's collection_note_attachments
// comment). Files live under Utils.paths.userData/collections/<noteId>/.
//
// The DB's collection_note_attachments.filePath column stores a path RELATIVE
// to the collections root ("<noteId>/<fileName>"), not absolute — this module
// is the only place that resolves it to a real filesystem path.

import { existsSync, mkdirSync, copyFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { Utils } from "electrobun/bun";

function collectionsRoot(): string {
	return join(Utils.paths.userData, "collections");
}

// Ensures the storage root exists on disk and returns it — used by the
// Settings tab's "Open Folder" action, since the directory may not have been
// created yet (lazily created by storeAttachment) if no attachment/export has
// happened so far.
export function ensureCollectionsRoot(): string {
	const root = collectionsRoot();
	if (!existsSync(root)) mkdirSync(root, { recursive: true });
	return root;
}

// Recursively sums file count/size under the storage root (attachments +
// exports) for the Settings tab's "Attachment storage" card.
export function getStorageInfo(): { path: string; totalSizeBytes: number; fileCount: number } {
	const root = collectionsRoot();
	let totalSizeBytes = 0;
	let fileCount = 0;
	function walk(dir: string) {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile()) {
				fileCount++;
				totalSizeBytes += statSync(full).size;
			}
		}
	}
	walk(root);
	return { path: root, totalSizeBytes, fileCount };
}

function noteAttachmentDir(noteId: string): string {
	return join(collectionsRoot(), noteId);
}

// Strips any directory components and disallowed characters from an
// attachment's display filename, mirroring the safeDest pattern in
// src/bun/freelance/expert/tools.ts:45-50 — the only thing that ever reaches
// disk is a bare filename, so a crafted "../../evil.txt" can never escape the
// note's own attachment directory.
export function safeAttachmentFileName(originalName: string): string {
	const strippedToBasename = basename(originalName).trim();
	const safe = strippedToBasename.replace(/[\\/]/g, "_");
	// basename(".") and basename("..") return themselves unchanged (no separator
	// to strip) — reject them explicitly so join(dir, fileName) can never resolve
	// to dir itself or its parent.
	if (!safe || safe === "." || safe === "..") return "attachment";
	return safe;
}

// If fileName already exists in dir, appends " (2)", " (3)", ... before the
// extension so a same-named attachment never silently overwrites another.
function dedupeFileName(dir: string, fileName: string): string {
	if (!existsSync(join(dir, fileName))) return fileName;
	const dot = fileName.lastIndexOf(".");
	const base = dot > 0 ? fileName.slice(0, dot) : fileName;
	const ext = dot > 0 ? fileName.slice(dot) : "";
	for (let i = 2; ; i++) {
		const candidate = `${base} (${i})${ext}`;
		if (!existsSync(join(dir, candidate))) return candidate;
	}
}

export interface StoredAttachment {
	fileName: string;
	relativePath: string;
	fileSize: number;
	mimeType: string | null;
}

// Copies sourcePath (an absolute path chosen via the OS file picker) into
// this note's attachment directory under a sanitized, deduped filename.
export function storeAttachment(noteId: string, sourcePath: string): StoredAttachment {
	const dir = noteAttachmentDir(noteId);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const requestedName = safeAttachmentFileName(basename(sourcePath));
	const fileName = dedupeFileName(dir, requestedName);
	const dest = join(dir, fileName);
	// Defense in depth beyond the basename() stripping above.
	if (!dest.startsWith(dir)) throw new Error("Attachment path escapes the note's storage directory");

	copyFileSync(sourcePath, dest);
	const file = Bun.file(dest);
	return {
		fileName,
		relativePath: join(noteId, fileName),
		fileSize: file.size,
		mimeType: file.type || null,
	};
}

// Resolves a DB-stored relative attachment path to an absolute filesystem
// path, verifying it stays inside the collections storage root.
export function absoluteAttachmentPath(relativePath: string): string {
	const root = collectionsRoot();
	const dest = join(root, relativePath);
	if (!dest.startsWith(root)) throw new Error("Attachment path escapes the collections storage directory");
	return dest;
}

export function deleteAttachmentFile(relativePath: string): void {
	try {
		const dest = absoluteAttachmentPath(relativePath);
		if (existsSync(dest)) rmSync(dest);
	} catch (err) {
		console.error("[collections/storage] Failed to delete attachment file:", err);
	}
}
