import { defaultSchema } from "hast-util-sanitize";
import type { Schema } from "hast-util-sanitize";
import { defaultUrlTransform } from "react-markdown";

/**
 * rehype-sanitize's default schema only allows `http`/`https` for `<img src>`
 * (GitHub's own sanitize rules) — a `data:` URI gets its `src` stripped
 * entirely, not just hidden, so a model-generated inline image (e.g.
 * execute_code base64-encoding a matplotlib chart into a markdown image
 * link) silently renders as a broken-image icon everywhere in the app.
 * Every `ReactMarkdown`/`@uiw/react-md-editor` call site should pass this
 * schema to `rehypeSanitize` instead of the bare default, so the allowlist
 * lives in exactly one place.
 */
export const markdownSanitizeSchema: Schema = {
	...defaultSchema,
	protocols: {
		...defaultSchema.protocols,
		src: [...(defaultSchema.protocols?.src ?? []), "data"],
	},
};

const DATA_IMAGE_URI = /^data:image\/[a-z0-9.+-]+;base64,/i;

/**
 * react-markdown runs a SECOND, independent sanitizer on every `src`/`href`
 * on top of rehype-sanitize — `defaultUrlTransform`'s own protocol allowlist
 * (http/https/irc(s)/mailto/xmpp) has no `data` entry, so it silently empties
 * out `<img src="data:...">` even after markdownSanitizeSchema lets it
 * through rehype-sanitize. Only `src` (images) gets the `data:image/...`
 * carve-out — `href` (links) still goes through the untouched default, so a
 * clickable `data:text/html,...` link can't slip through.
 */
export function markdownUrlTransform(url: string, key: string): string {
	if (key === "src" && DATA_IMAGE_URI.test(url)) return url;
	return defaultUrlTransform(url);
}
