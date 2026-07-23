import { memo, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { markdownSanitizeSchema, markdownUrlTransform } from "@/lib/markdown-sanitize-schema";
import { splitStableBlocks } from "./streaming-markdown-split";

/**
 * Markdown renderer for a reply that is still streaming.
 *
 * Renders each finished block through its own memoised <ReactMarkdown>, so a
 * token flush only re-parses the block currently being written instead of the
 * whole accumulated reply. Completed messages keep using a single plain
 * <ReactMarkdown> — they never re-render, so they gain nothing from this and
 * shouldn't inherit its edge cases.
 */

type MdComponents = Record<string, unknown>;

const StableBlock = memo(function StableBlock({
  content,
  components,
}: {
  content: string;
  components: MdComponents;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeSanitize, markdownSanitizeSchema]]}
      urlTransform={markdownUrlTransform}
      components={components as never}
    >
      {content}
    </ReactMarkdown>
  );
});

export function StreamingMarkdown({
  content,
  components,
  cursor = "▍",
}: {
  content: string;
  components: MdComponents;
  cursor?: string;
}) {
  const { stable, tail } = useMemo(() => splitStableBlocks(content), [content]);

  /**
   * `p`'s `last:mb-0` and `h4`'s `first:mt-0` are relative to their own parse
   * root. Split across roots, every block's final paragraph would become
   * "last" and lose its bottom margin, collapsing the spacing between blocks.
   * Pinning both to their unconditional value keeps the split render identical
   * to the single-parse one — the only difference is a trailing margin below
   * the very last line, which sits under the cursor and is invisible.
   *
   * Must NOT depend on how many blocks exist: this object is a prop of every
   * StableBlock, so a new identity each time a block completes would re-parse
   * the entire prefix and undo the split.
   */
  const splitSafeComponents = useMemo(
    () => ({
      ...components,
      p: ({ children }: { children: ReactNode }) => <p className="mb-2">{children}</p>,
      h4: ({ children }: { children: ReactNode }) => (
        <h4 className="text-sm font-semibold mb-1 mt-2">{children}</h4>
      ),
    }),
    [components],
  );

  return (
    <>
      {stable.map((block, i) => (
        <StableBlock key={i} content={block} components={splitSafeComponents} />
      ))}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, markdownSanitizeSchema]]}
        urlTransform={markdownUrlTransform}
        components={splitSafeComponents as never}
      >
        {tail + cursor}
      </ReactMarkdown>
    </>
  );
}
