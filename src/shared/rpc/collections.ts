// Collections — personal, cross-project knowledge base. See docs/collections-plan.md.
// Deliberately separate from NotesRequests (./notes.ts), which covers per-project docs.

export type CollectionDto = {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  isDefault: boolean;
  sortOrder: number;
  noteCount: number;
  createdAt: string;
  updatedAt: string;
};

// Lightweight shape for list/browse views (note-list.tsx cards, search/picker results).
export type CollectionNoteSummaryDto = {
  id: string;
  collectionId: string;
  title: string;
  snippet: string;
  tags: string[];
  isFavorite: boolean;
  isDeleted: boolean;
  hasAttachment: boolean;
  createdAt: string;
  updatedAt: string;
};

// Full shape for the editor pane.
export type CollectionNoteDto = CollectionNoteSummaryDto & {
  contentMarkdown: string;
  sourceType: CollectionNoteSourceType | null;
  sourceRef: CollectionNoteSourceRef | null;
  attachments: CollectionAttachmentDto[];
};

export type CollectionNoteSourceType =
  | "pm_chat"
  | "council"
  | "freelance_chat"
  | "skills_chat"
  | "freelance_inbox"
  | "inbox_message"
  | "manual";

export type CollectionNoteSourceRef = {
  projectId?: string;
  projectName?: string;
  taskId?: string;
};

export type CollectionAttachmentDto = {
  id: string;
  noteId: string;
  fileName: string;
  fileSize: number;
  mimeType: string | null;
  createdAt: string;
};

export type CollectionLinkedNoteDto = {
  id: string;
  title: string;
  collectionId: string;
  collectionName: string;
};

export type CollectionNoteSort = "updated" | "created" | "title" | "favorite";

// "favorites" and "trash" are virtual scopes — not real collection rows.
export type CollectionListScope = string | "favorites" | "trash";

export type CollectionSearchScope = string | "all";

export type CollectionExportFormat = "markdown" | "pdf" | "json";

export type CollectionChatCitationDto = {
  noteId: string;
  title: string;
  collectionId: string;
};

export type CollectionAttachPickerResultDto = {
  id: string;
  title: string;
  collectionName: string;
  snippet: string;
};

export type EmbeddingModelStatus = "not_downloaded" | "downloading" | "ready" | "error";

export type EmbeddingModelStatusDto = {
  status: EmbeddingModelStatus;
  progress: number | null;
  dims: number;
  sizeMb: number;
  lastIndexedAt: string | null;
  indexedCount: number;
  totalCount: number;
};

export type CollectionsRequests = {
  // Collections CRUD
  listCollections: {
    params: Record<string, never>;
    response: CollectionDto[];
  };
  createCollection: {
    params: { name: string; color: string; icon?: string };
    response: { success: boolean; id: string };
  };
  renameCollection: {
    params: { id: string; name: string };
    response: { success: boolean };
  };
  recolorCollection: {
    params: { id: string; color: string; icon?: string };
    response: { success: boolean };
  };
  reorderCollections: {
    params: { orderedIds: string[] };
    response: { success: boolean };
  };
  deleteCollection: {
    params: { id: string };
    response: { success: boolean; error?: string; movedNoteCount?: number };
  };

  // Notes CRUD
  listNotes: {
    params: {
      collectionId: CollectionListScope;
      query?: string;
      tags?: string[];
      sort?: CollectionNoteSort;
    };
    response: CollectionNoteSummaryDto[];
  };
  getCollectionNote: {
    params: { id: string };
    response: CollectionNoteDto | null;
  };
  createCollectionNote: {
    params: { collectionId: string; title: string; contentMarkdown?: string };
    response: { success: boolean; id: string };
  };
  updateCollectionNote: {
    params: { id: string; title?: string; contentMarkdown?: string; tags?: string[] };
    response: { success: boolean };
  };
  toggleFavorite: {
    params: { id: string };
    response: { success: boolean; isFavorite: boolean };
  };
  moveNote: {
    params: { id: string; targetCollectionId: string };
    response: { success: boolean };
  };

  // Trash lifecycle
  softDeleteNote: {
    params: { id: string };
    response: { success: boolean };
  };
  restoreNote: {
    params: { id: string };
    response: { success: boolean };
  };
  permanentlyDeleteNote: {
    params: { id: string };
    response: { success: boolean };
  };
  emptyTrash: {
    params: Record<string, never>;
    response: { success: boolean; deletedCount: number };
  };

  // Search & chat
  searchCollectionNotes: {
    params: { query: string; scope: CollectionSearchScope };
    response: CollectionNoteSummaryDto[];
  };
  sendCollectionsChatMessage: {
    params: { sessionId: string; content: string; scope: CollectionSearchScope };
    response: { messageId: string };
  };
  abortCollectionsChatMessage: {
    params: { sessionId: string };
    response: { success: boolean };
  };
  clearCollectionsChatSession: {
    params: { sessionId: string };
    response: { success: boolean };
  };

  // Export
  exportNote: {
    params: { id: string; format: CollectionExportFormat };
    response: { success: boolean; filePath: string };
  };
  exportCollection: {
    params: { id: string; format: CollectionExportFormat };
    response: { success: boolean; filePath: string };
  };

  // Attachments (download-only — never inline-previewed)
  // Opens the native OS file picker (Utils.openFileDialog blocks the event
  // loop, so — mirroring selectDirectory in projects-system.ts — this returns
  // {queued:true} immediately and the chosen path arrives via the
  // collectionAttachmentFilePicked webview message, correlated by noteId.
  pickAttachmentFile: {
    params: { noteId: string };
    response: { queued: boolean };
  };
  addAttachment: {
    params: { noteId: string; sourcePath: string };
    response: { success: boolean; attachment: CollectionAttachmentDto };
  };
  removeAttachment: {
    params: { id: string };
    response: { success: boolean };
  };
  getAttachmentDownloadPath: {
    params: { id: string };
    response: { filePath: string } | null;
  };
  // "Show in folder" — Electrobun has no native Save-As dialog, so the chip's
  // action button reveals the file in the OS file explorer instead of a
  // literal browser-style download (agreed during TASK-517 planning).
  revealAttachment: {
    params: { id: string };
    response: { success: boolean };
  };

  // Backlinks
  getLinkedNotes: {
    params: { id: string };
    response: CollectionLinkedNoteDto[];
  };
  getBacklinks: {
    params: { id: string };
    response: CollectionLinkedNoteDto[];
  };

  // Save-to-Collection / Attach-as-context (chat integration points)
  saveToCollection: {
    params: {
      collectionId: string;
      title: string;
      contentMarkdown: string;
      sourceType?: CollectionNoteSourceType;
      sourceRef?: CollectionNoteSourceRef;
    };
    response: { success: boolean; id: string };
  };
  listNotesForAttachPicker: {
    params: { query?: string };
    response: CollectionAttachPickerResultDto[];
  };
  getNoteContentForContext: {
    params: { id: string };
    response: { title: string; contentMarkdown: string } | null;
  };

  // Settings tab — attachment storage disclosure
  getAttachmentStorageInfo: {
    params: Record<string, never>;
    response: { path: string; totalSizeBytes: number; fileCount: number };
  };
  openAttachmentStorageFolder: {
    params: Record<string, never>;
    response: { success: boolean };
  };

  // Embedding model lifecycle (Settings tab, chat FAB gating)
  getEmbeddingModelStatus: {
    params: Record<string, never>;
    response: EmbeddingModelStatusDto;
  };
  downloadEmbeddingModel: {
    params: Record<string, never>;
    response: { success: boolean };
  };
  reindexNotes: {
    params: Record<string, never>;
    response: { success: boolean; indexed: number };
  };
};
