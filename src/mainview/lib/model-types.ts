/**
 * Model-type taxonomy shared by the model-type badge and any future reuse
 * (e.g. a chat model picker). Same type always renders with the same color,
 * app-wide. Keep in sync with ModelType in src/bun/providers/model-classification.ts.
 */
export type ModelType =
  | "language"
  | "embedding"
  | "image"
  | "video"
  | "transcription"
  | "speech"
  | "realtime"
  | "reranking"
  | "unknown";

/** `unknown` renders no badge (classification failed/no data) — see model-type-badge.tsx. */
export const MODEL_TYPE_BADGE_STYLES: Partial<Record<ModelType, { label: string; className: string }>> = {
  language: { label: "LANG", className: "bg-slate-500/10 text-slate-600 dark:text-slate-400" },
  embedding: { label: "EMBED", className: "bg-violet-500/10 text-violet-600 dark:text-violet-400" },
  image: { label: "IMAGE", className: "bg-pink-500/10 text-pink-600 dark:text-pink-400" },
  video: { label: "VIDEO", className: "bg-orange-500/10 text-orange-600 dark:text-orange-400" },
  transcription: { label: "STT", className: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400" },
  speech: { label: "TTS", className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  realtime: { label: "LIVE", className: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  reranking: { label: "RERANK", className: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400" },
};

/** Filter-chip label for every type, including the unbadged ones. */
export const MODEL_TYPE_FILTER_LABELS: Record<ModelType, string> = {
  language: "Language",
  embedding: "Embedding",
  image: "Image",
  video: "Video",
  transcription: "Transcription",
  speech: "Speech",
  realtime: "Realtime",
  reranking: "Reranking",
  unknown: "Unknown",
};
