// Minimal ambient types for `html-to-text` (v10 ships no bundled .d.ts, and the
// DefinitelyTyped package only covers up to v9's differing API).
// Covers only the API surface used by src/bun/agents/tools/web.ts.

declare module "html-to-text" {
	export interface HtmlToTextOptions {
		wordwrap?: number | false;
		selectors?: Array<{ selector: string; format?: string; options?: Record<string, unknown> }>;
		[key: string]: unknown;
	}

	export function compile(options?: HtmlToTextOptions): (html: string) => string;
	export function convert(html: string, options?: HtmlToTextOptions): string;
}
