// Markdown/PDF/JSON export for Collections notes — docs/collections-plan.md §5/§8.
// Exports are written under Utils.paths.userData/collections/exports/ (mirrors the
// attachment storage convention in storage.ts) and revealed in the OS file explorer —
// same "no in-app Save-As dialog" pattern as attachments' revealAttachment.

import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { Utils } from "electrobun/bun";
import PDFDocument from "pdfkit";
import { INTER_REGULAR_LATIN_TTF_BASE64 } from "./fonts/inter-regular-latin";

// Decoded once per process — see fonts/inter-regular-latin.ts for why PDF export embeds
// its own font instead of using pdfkit's built-in standard (AFM-metric) fonts.
const PDF_BODY_FONT = Buffer.from(INTER_REGULAR_LATIN_TTF_BASE64, "base64");

export interface ExportableNote {
	title: string;
	contentMarkdown: string;
	tags: string[];
	sourceType: string | null;
	sourceRef: unknown;
	createdAt: string;
	updatedAt: string;
}

export type ExportFormat = "markdown" | "pdf" | "json";

function exportsRoot(): string {
	const dir = join(Utils.paths.userData, "collections", "exports");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

// Strips filesystem-illegal characters from a note/collection title so it's
// safe as a bare filename — mirrors safeAttachmentFileName's intent (nothing
// ever reaches disk with a path separator in it) but for arbitrary title text
// rather than an already-a-filename source name.
function sanitizeFileName(name: string): string {
	const stripped = name.replace(/[\\/:*?"<>|]/g, "_").trim();
	return stripped || "Untitled";
}

function timestampSuffix(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function noteJsonPayload(note: ExportableNote) {
	return {
		title: note.title,
		contentMarkdown: note.contentMarkdown,
		tags: note.tags,
		sourceType: note.sourceType,
		sourceRef: note.sourceRef,
		createdAt: note.createdAt,
		updatedAt: note.updatedAt,
	};
}

// Renders one PDF with one page per note (a single note is just a 1-element
// array) — plain text layout via pdfkit, not a markdown renderer. "Readable",
// not "styled" (docs/collections-plan.md's Phase 5 AC), so raw markdown source
// text is fine; a full GFM-to-PDF renderer is out of scope for v1.
function writePdf(filePath: string, notes: ExportableNote[]): Promise<void> {
	return new Promise((resolve, reject) => {
		// font:"" (any falsy value works; the type only allows string) stops the constructor from
		// eagerly loading the standard "Helvetica" font (pdfkit's FontsMixin#initFonts calls
		// this.font(defaultFont) synchronously unless the option is falsy) — that eager load is
		// what hits the broken __dirname-relative AFM lookup, before we ever get a chance to
		// register our own font below. See fonts/inter-regular-latin.ts.
		const doc = new PDFDocument({ margin: 50, font: "" });
		const stream = createWriteStream(filePath);
		doc.pipe(stream);
		stream.on("finish", resolve);
		stream.on("error", reject);
		doc.on("error", reject);

		doc.registerFont("Body", PDF_BODY_FONT);
		doc.font("Body");

		notes.forEach((note, i) => {
			if (i > 0) doc.addPage();
			doc.fontSize(18).fillColor("black").text(note.title || "Untitled");
			doc.moveDown(0.3);
			if (note.tags.length > 0) {
				doc.fontSize(9).fillColor("gray").text(note.tags.map((t) => `#${t}`).join("   "));
				doc.fillColor("black");
			}
			doc.moveDown(0.5);
			doc.fontSize(11).text(note.contentMarkdown.trim() || "(empty note)");
		});

		doc.end();
	});
}

export async function exportNoteToFile(note: ExportableNote, format: ExportFormat): Promise<string> {
	const dir = exportsRoot();
	const base = sanitizeFileName(note.title);
	const suffix = timestampSuffix();

	if (format === "markdown") {
		const filePath = join(dir, `${base}-${suffix}.md`);
		await Bun.write(filePath, note.contentMarkdown);
		return filePath;
	}
	if (format === "json") {
		const filePath = join(dir, `${base}-${suffix}.json`);
		await Bun.write(filePath, JSON.stringify(noteJsonPayload(note), null, 2));
		return filePath;
	}
	const filePath = join(dir, `${base}-${suffix}.pdf`);
	await writePdf(filePath, [note]);
	return filePath;
}

// A collection "bundle" (docs/collections-plan.md §5 AC) is one file covering
// every note: JSON → one array; PDF → one multi-page document; Markdown → a
// zip of one .md per note (archiver — already a dependency, same usage as
// src/bun/agents/tools/file-ops.ts's archive-create tool).
export async function exportCollectionToFile(
	collectionName: string,
	notes: ExportableNote[],
	format: ExportFormat,
): Promise<string> {
	const dir = exportsRoot();
	const base = sanitizeFileName(collectionName);
	const suffix = timestampSuffix();

	if (format === "json") {
		const filePath = join(dir, `${base}-${suffix}.json`);
		await Bun.write(filePath, JSON.stringify(notes.map(noteJsonPayload), null, 2));
		return filePath;
	}
	if (format === "pdf") {
		const filePath = join(dir, `${base}-${suffix}.pdf`);
		await writePdf(filePath, notes);
		return filePath;
	}

	const filePath = join(dir, `${base}-${suffix}.zip`);
	const { default: archiver } = await import("archiver");
	const output = createWriteStream(filePath);
	const archive = archiver("zip", { zlib: { level: 9 } });
	const done = new Promise<void>((resolve, reject) => {
		output.on("close", resolve);
		archive.on("error", reject);
	});
	archive.pipe(output);

	const usedNames = new Set<string>();
	for (const note of notes) {
		const base2 = sanitizeFileName(note.title);
		let name = `${base2}.md`;
		let i = 2;
		while (usedNames.has(name)) {
			name = `${base2} (${i}).md`;
			i++;
		}
		usedNames.add(name);
		archive.append(note.contentMarkdown, { name });
	}
	await archive.finalize();
	await done;
	return filePath;
}
