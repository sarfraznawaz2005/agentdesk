import { create } from "zustand";

// Cross-pane selection state for the Collections Library screen (rail / note
// list / editor). Data itself (collections, notes, note content) stays local
// to whichever component fetches it — this store only coordinates "what's
// selected" so the three panes don't need prop-drilling through collections.tsx.
interface CollectionsStore {
	// Real collection id, or the virtual scopes "favorites" / "trash". Null until
	// the rail's initial load picks the Default collection.
	selectedCollectionId: string | null;
	selectedNoteId: string | null;
	setSelectedCollection: (id: string) => void;
	setSelectedNote: (id: string | null) => void;
	// Which top-level Collections tab is active — lifted here (instead of local
	// state in collections.tsx) so a child deep in the Library tree (e.g. the
	// chat panel's gated empty state) can switch to Settings without prop-drilling.
	activeTab: "library" | "settings";
	setActiveTab: (tab: "library" | "settings") => void;
	// The rail's "search all notes" box (above the collections list). Lifted
	// here so NoteList can mirror it into its own per-collection search without
	// prop-drilling through collections.tsx — CollectionsRail owns the input
	// and the debounced search itself; this is just the shared query string.
	librarySearchQuery: string;
	setLibrarySearchQuery: (query: string) => void;
}

export const useCollectionsStore = create<CollectionsStore>((set) => ({
	selectedCollectionId: null,
	selectedNoteId: null,
	// Switching collections clears the note selection — the previously selected
	// note isn't necessarily a member of the newly selected collection.
	setSelectedCollection: (id) => set({ selectedCollectionId: id, selectedNoteId: null }),
	setSelectedNote: (id) => set({ selectedNoteId: id }),
	activeTab: "library",
	setActiveTab: (tab) => set({ activeTab: tab }),
	librarySearchQuery: "",
	setLibrarySearchQuery: (query) => set({ librarySearchQuery: query }),
}));
