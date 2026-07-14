import { cn } from "@/lib/utils";
import { MODEL_TYPE_BADGE_STYLES, type ModelType } from "@/lib/model-types";

/**
 * Small colored pill indicating a model's type (language, embedding, image,
 * etc.). Renders nothing for `unknown`/unset — classification failed or
 * there's no data, so it fails silent rather than mislabel.
 */
export function ModelTypeBadge({ type }: { type: ModelType | undefined }) {
  const style = type ? MODEL_TYPE_BADGE_STYLES[type] : undefined;
  if (!style) return null;
  return (
    <span
      className={cn(
        "shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wide",
        style.className,
      )}
    >
      {style.label}
    </span>
  );
}
