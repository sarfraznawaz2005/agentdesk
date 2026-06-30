// ---------------------------------------------------------------------------
// Encoding-robust literal text editing
//
// The edit tools (edit_file / multi_edit_file / patch_file) match a model-supplied
// `old_text` against the on-disk file. The hard problem is that the model rarely
// reproduces the file's exact bytes:
//
//   • Line endings — Windows files are CRLF ("\r\n") but LLMs almost always emit
//     LF ("\n"). A naive `content.includes(oldText)` then fails with
//     "old_text not found", even though the text is visibly identical. (This is
//     the bug that pushed agents to flip useRegex=true and then hit
//     "invalid regex: missing )" on unbalanced parens in code.)
//   • BOM — a leading UTF-8 BOM (U+FEFF) is part of the string but never part of
//     the model's old_text, so a match at the very start of the file fails.
//   • `$` in the replacement — String.prototype.replace(str, str) still expands
//     `$&`, `$1`, `$$`… in the replacement, silently corrupting code that
//     contains a literal `$`.
//
// These helpers fix all three with pure, side-effect-free functions so they can
// be unit-tested in isolation and reused by every edit tool. The guiding rule is
// **minimal change**: prefer an exact byte match (touch nothing else); only fall
// back to EOL-normalised matching when the exact match fails, and always write
// the edited region back in the file's own EOL convention with its BOM intact.
// ---------------------------------------------------------------------------

export type Eol = "\r\n" | "\n";
const BOM = String.fromCharCode(0xFEFF); // U+FEFF byte-order mark

/**
 * Detect a text's dominant line ending. CRLF wins ties (a file with any CRLF and
 * no bare LF is unambiguously CRLF). Text with no line endings → LF.
 */
export function detectEol(text: string): Eol {
	const crlf = (text.match(/\r\n/g) || []).length;
	const totalLf = (text.match(/\n/g) || []).length;
	const bareLf = totalLf - crlf; // LFs not part of a CRLF pair
	return crlf > 0 && crlf >= bareLf ? "\r\n" : "\n";
}

/** Normalise all line endings (CRLF and lone CR) to LF. */
export function toLf(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Convert LF line endings to `eol`. (No-op when eol is LF.) */
export function fromLf(text: string, eol: Eol): string {
	return eol === "\n" ? text : text.replace(/\n/g, "\r\n");
}

/**
 * Literal (non-regex) replace with no `$` interpretation in the replacement.
 * Replaces the first occurrence, or every occurrence when `all` is true.
 * Returns the source unchanged when `find` is not present.
 */
function spliceLiteral(src: string, find: string, repl: string, all: boolean): string {
	if (all) return src.split(find).join(repl);
	const idx = src.indexOf(find);
	return idx === -1 ? src : src.slice(0, idx) + repl + src.slice(idx + find.length);
}

export interface LiteralReplaceResult {
	updated?: string;
	error?: string;
	/** True when the match only succeeded after EOL normalisation (diagnostic). */
	eolAdjusted?: boolean;
}

/**
 * EOL- and BOM-robust literal find/replace.
 *
 * Strategy (first match wins):
 *   1. Exact match — replace as-is, every other byte untouched.
 *   2. File-EOL match — convert old_text/new_text to the file's EOL and retry.
 *      Handles the common "file is CRLF, model gave LF" case; only the edited
 *      region changes, and it stays consistent with the surrounding file.
 *   3. Normalised match — compare both sides in LF space (last resort for
 *      mixed-EOL files), then re-emit the whole body in the file's EOL.
 *
 * A leading BOM is stripped before matching and restored on the result, so it is
 * never duplicated and never blocks a match at the start of the file.
 */
export function literalReplace(
	original: string,
	oldText: string,
	newText: string,
	replaceAll = false,
): LiteralReplaceResult {
	if (oldText.length === 0) return { error: "old_text is empty" };

	const bom = original.startsWith(BOM) ? BOM : "";
	const body = bom ? original.slice(1) : original;

	// 1. Exact — preserves the file byte-for-byte outside the match.
	if (body.includes(oldText)) {
		return { updated: bom + spliceLiteral(body, oldText, newText, replaceAll) };
	}

	// 2. File-EOL — the dominant real-world fix (CRLF file vs LF old_text).
	const eol = detectEol(body);
	const oldEol = fromLf(toLf(oldText), eol);
	if (oldEol !== oldText && body.includes(oldEol)) {
		const newEol = fromLf(toLf(newText), eol);
		return { updated: bom + spliceLiteral(body, oldEol, newEol, replaceAll), eolAdjusted: true };
	}

	// 3. Fully normalised — mixed/odd EOLs; re-emit body in the file's EOL.
	const bodyLf = toLf(body);
	const oldLf = toLf(oldText);
	if (bodyLf.includes(oldLf)) {
		const replacedLf = spliceLiteral(bodyLf, oldLf, toLf(newText), replaceAll);
		return { updated: bom + fromLf(replacedLf, eol), eolAdjusted: true };
	}

	return { error: "old_text not found in file" };
}
