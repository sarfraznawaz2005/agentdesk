import * as collectionsRpc from "../rpc/collections";
import { Utils } from "electrobun/bun";
import { broadcastToWebview } from "../engine-manager";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handlers: Record<string, (params: any) => any> = {
	// Collections CRUD
	listCollections: () => collectionsRpc.listCollections(),
	createCollection: (params) => collectionsRpc.createCollection(params),
	renameCollection: (params) => collectionsRpc.renameCollection(params),
	recolorCollection: (params) => collectionsRpc.recolorCollection(params),
	reorderCollections: (params) => collectionsRpc.reorderCollections(params),
	deleteCollection: (params) => collectionsRpc.deleteCollection(params),

	// Notes CRUD
	listNotes: (params) => collectionsRpc.listNotes(params),
	getCollectionNote: (params) => collectionsRpc.getCollectionNote(params.id),
	createCollectionNote: (params) => collectionsRpc.createCollectionNote(params),
	updateCollectionNote: (params) => collectionsRpc.updateCollectionNote(params),
	toggleFavorite: (params) => collectionsRpc.toggleFavorite(params),
	moveNote: (params) => collectionsRpc.moveNote(params),

	// Trash lifecycle
	softDeleteNote: (params) => collectionsRpc.softDeleteNote(params),
	restoreNote: (params) => collectionsRpc.restoreNote(params),
	permanentlyDeleteNote: (params) => collectionsRpc.permanentlyDeleteNote(params),
	emptyTrash: () => collectionsRpc.emptyTrash(),

	// Search & chat
	searchCollectionNotes: (params) => collectionsRpc.searchCollectionNotes(params),
	sendCollectionsChatMessage: (params) => collectionsRpc.sendCollectionsChatMessage(params),
	abortCollectionsChatMessage: (params) => collectionsRpc.abortCollectionsChatMessage(params),
	clearCollectionsChatSession: (params) => collectionsRpc.clearCollectionsChatSession(params),

	// Export — Phase 5
	exportNote: (params) => collectionsRpc.exportNote(params),
	exportCollection: (params) => collectionsRpc.exportCollection(params),

	// Attachments (download-only — never inline-previewed)
	pickAttachmentFile: (params) => {
		// Defer past the RPC response — Utils.openFileDialog blocks the event
		// loop for as long as the native dialog is open (mirrors selectDirectory
		// in projects-system.ts).
		setTimeout(() => {
			Utils.openFileDialog({
				canChooseFiles: true,
				canChooseDirectory: false,
				allowsMultipleSelection: false,
			})
				.then((paths) => {
					const path = Array.isArray(paths) && paths.length > 0 && paths[0] ? String(paths[0]) : null;
					broadcastToWebview("collectionAttachmentFilePicked", { noteId: params.noteId, path });
				})
				.catch(() => {
					broadcastToWebview("collectionAttachmentFilePicked", { noteId: params.noteId, path: null });
				});
		}, 0);
		return { queued: true };
	},
	addAttachment: (params) => collectionsRpc.addAttachment(params),
	removeAttachment: (params) => collectionsRpc.removeAttachment(params),
	getAttachmentDownloadPath: (params) => collectionsRpc.getAttachmentDownloadPath(params),
	revealAttachment: async (params: { id: string }) => {
		const result = await collectionsRpc.getAttachmentDownloadPath(params);
		if (!result) return { success: false };
		Utils.showItemInFolder(result.filePath);
		return { success: true };
	},

	// Backlinks — Phase 5
	getLinkedNotes: (params) => collectionsRpc.getLinkedNotes(params),
	getBacklinks: (params) => collectionsRpc.getBacklinks(params),

	// Save-to-Collection / Attach-as-context — Phase 4
	saveToCollection: (params) => collectionsRpc.saveToCollection(params),
	listNotesForAttachPicker: (params) => collectionsRpc.listNotesForAttachPicker(params),
	getNoteContentForContext: (params) => collectionsRpc.getNoteContentForContext(params),

	// Settings tab — attachment storage disclosure
	getAttachmentStorageInfo: () => collectionsRpc.getAttachmentStorageInfo(),
	openAttachmentStorageFolder: () => collectionsRpc.openAttachmentStorageFolder(),

	// Embedding model lifecycle — Phase 6
	getEmbeddingModelStatus: () => collectionsRpc.getEmbeddingModelStatus(),
	downloadEmbeddingModel: () => collectionsRpc.downloadEmbeddingModel(),
	reindexNotes: () => collectionsRpc.reindexNotes(),
};
