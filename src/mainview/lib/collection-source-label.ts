import type { CollectionNoteSourceRef, CollectionNoteSourceType } from "../../shared/rpc/collections";

const SOURCE_TYPE_LABELS: Record<CollectionNoteSourceType, string> = {
  pm_chat: "PM Chat",
  council: "Council",
  freelance_chat: "Freelance Chat",
  skills_chat: "Skills Chat",
  freelance_inbox: "Freelance Inbox",
  inbox_message: "Inbox",
  manual: "Manual",
};

// Formats the provenance chip shown on notes saved via saveToCollection
// (docs/collections-plan.md §8). Returns null for notes with no source
// (created directly in the Library) or the "manual" source type.
export function collectionSourceLabel(
  sourceType: CollectionNoteSourceType | null,
  sourceRef: CollectionNoteSourceRef | null,
): string | null {
  if (!sourceType || sourceType === "manual") return null;
  const base = SOURCE_TYPE_LABELS[sourceType];
  const detail = sourceRef?.projectName ?? sourceRef?.taskId;
  return detail ? `${base} · ${detail}` : base;
}
