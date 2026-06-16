import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Sparkles, Trash2, Search, X, AlertTriangle, ChevronUp, ChevronDown, CheckSquare } from "lucide-react";
import { rpc } from "../../lib/rpc";
import { toast } from "@/components/ui/toast";
import { FreelanceListingCard } from "./listing-card";
import { FindWorkableModal } from "./find-workable-modal";
import { Tip } from "@/components/ui/tooltip";
import { LISTING_KIND_CHIPS } from "./block-kind";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import type { FreelanceListingDto, FreelanceListingKind } from "../../../shared/rpc/freelance";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StatusFilter = "new" | "approved" | "shortlisted" | "closed" | undefined;

// ---------------------------------------------------------------------------
// Skeleton card for loading state
// ---------------------------------------------------------------------------

function ListingSkeleton() {
  return (
    <div className="animate-pulse rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="h-4 bg-muted rounded w-16" />
        <div className="h-4 bg-muted rounded w-24" />
      </div>
      <div className="h-4 bg-muted rounded w-3/4" />
      <div className="h-3 bg-muted rounded w-full" />
      <div className="h-3 bg-muted rounded w-5/6" />
      <div className="flex gap-1.5 pt-1">
        <div className="h-5 bg-muted rounded-full w-14" />
        <div className="h-5 bg-muted rounded-full w-16" />
        <div className="h-5 bg-muted rounded-full w-12" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter tab bar config
// ---------------------------------------------------------------------------

const FILTERS: Array<{ label: string; value: StatusFilter; countKey: "new" | "approved" | "shortlisted" | "closed" | "all" }> = [
  { label: "New", value: "new", countKey: "new" },
  { label: "Shortlisted", value: "shortlisted", countKey: "shortlisted" },
  { label: "Approved", value: "approved", countKey: "approved" },
  { label: "Done", value: "closed", countKey: "closed" },
];

const PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// ListingsTab
// ---------------------------------------------------------------------------

export function ListingsTab() {
  const navigate = useNavigate();

  const [listings, setListings] = useState<FreelanceListingDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("new");
  // New-tab verdict-chip filter. Held in a ref too so the post-action reload
  // callbacks (approve/delete/etc.) pick up the current value without threading
  // it through loadListings' signature.
  const [hiddenKinds, setHiddenKinds] = useState<Set<FreelanceListingKind>>(() => {
    try {
      const stored = localStorage.getItem("agentdesk_freelance_hidden_kinds");
      return stored ? new Set(JSON.parse(stored) as FreelanceListingKind[]) : new Set();
    } catch { return new Set(); }
  });
  const hiddenKindsRef = useRef<Set<FreelanceListingKind>>(hiddenKinds);
  hiddenKindsRef.current = hiddenKinds;
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [counts, setCounts] = useState<{ new: number; approved: number; shortlisted: number; closed: number; all: number }>({ new: 0, approved: 0, shortlisted: 0, closed: 0, all: 0 });
  const [wizardOpen, setWizardOpen] = useState(false);
  const [analyzingIds, setAnalyzingIds] = useState<Set<string>>(new Set());
  const [openModalForId, setOpenModalForId] = useState<string | null>(null);
  // Multi-select delete (per sub-tab, current page). selectedIds holds the chosen
  // listing ids; "Select all" picks every listing on the current page.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [timezone, setTimezone] = useState("UTC");
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [preferredCurrency, setPreferredCurrency] = useState("USD");
  const [currencyRates, setCurrencyRates] = useState<Record<string, number>>({});
  const [autoEarnEnabled, setAutoEarnEnabled] = useState(false);

  useEffect(() => {
    rpc.getSetting("timezone", "general").then((val) => {
      if (val) setTimezone(val as string);
    }).catch(() => {});

    // Whether Auto-Earn is on — gates the "Draft Proposal" button (which feeds
    // the Auto-Earn outbox/Inbox). Re-checked when settings change.
    const loadAutoEarn = () =>
      Promise.all([rpc.freelanceAutoEarnAvailable(), rpc.freelanceGetAutoEarnSettings()])
        .then(([avail, s]) => setAutoEarnEnabled(avail.available && s.enabled))
        .catch(() => {});
    loadAutoEarn();
    window.addEventListener("agentdesk:settings-changed", loadAutoEarn);

    // Load preferred currency setting + exchange rates in parallel
    Promise.all([
      rpc.freelanceGetSettings(),
      rpc.freelanceGetCurrencyRates(),
    ]).then(([settings, ratesResult]) => {
      if (settings.preferredCurrency) setPreferredCurrency(settings.preferredCurrency);
      if (ratesResult.rates && Object.keys(ratesResult.rates).length > 0) {
        setCurrencyRates(ratesResult.rates);
      }
    }).catch(() => {});

    return () => window.removeEventListener("agentdesk:settings-changed", loadAutoEarn);
  }, []);

  useEffect(() => {
    const container = document.getElementById("main-scroll-container");
    if (!container) return;
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const atBottom = scrollTop + clientHeight >= scrollHeight - 8;
      setShowScrollTop(scrollTop > 200);
      setShowScrollBottom(!atBottom && scrollHeight > clientHeight + 200);
    };
    onScroll();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  // ---- Data loading --------------------------------------------------------

  const loadCounts = useCallback(async () => {
    try {
      const result = await rpc.freelanceGetListingCounts();
      setCounts(result);
    } catch {
      // non-critical
    }
  }, []);

  const loadListings = useCallback(
    async (p: number, status: StatusFilter, q: string) => {
      setLoading(true);
      try {
        const [result] = await Promise.all([
          rpc.freelanceGetListings({ status, page: p, search: q || undefined, excludeKinds: status === "new" && hiddenKindsRef.current.size > 0 ? [...hiddenKindsRef.current] : undefined }),
          loadCounts(),
        ]);
        setListings(result.listings);
        setTotal(result.total);
      } catch (err) {
        console.error("Failed to load freelance listings:", err);
      } finally {
        setLoading(false);
      }
    },
    [loadCounts],
  );

  useEffect(() => {
    void loadListings(page, statusFilter, debouncedSearch);
    // hiddenKinds is read via ref inside loadListings; listed here so toggling a
    // chip re-runs the load.
  }, [page, statusFilter, debouncedSearch, hiddenKinds, loadListings]);


  // Toggle a verdict chip: clicking the active one clears it. Reset to page 1
  // since the filtered result set changes.
  const handleKindFilter = useCallback((kind: FreelanceListingKind) => {
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) { next.delete(kind); } else { next.add(kind); }
      try { localStorage.setItem("agentdesk_freelance_hidden_kinds", JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
    setPage(1);
    setSelectedIds(new Set());
  }, []);

  // ---- Server-push: fetch started (manual or scheduled) -------------------

  useEffect(() => {
    const handler = () => setFetching(true);
    window.addEventListener("agentdesk:freelance-fetch-started", handler);
    return () => window.removeEventListener("agentdesk:freelance-fetch-started", handler);
  }, []);

  // ---- Server-push: fetch completed / listings changed --------------------

  useEffect(() => {
    const handler = (e: Event) => {
      const { count, source, errors } = (e as CustomEvent<{ count: number; source?: string; errors?: number }>).detail ?? {};
      const isFetchEvent = source === "manual" || source === "scheduled" || source === "startup";
      if (isFetchEvent) {
        setFetching(false);
        if (source === "manual") {
          if (count > 0) {
            toast("success", count === 1 ? "1 new listing found." : `${count} new listings found.`);
          } else if (!errors) {
            // Only show "No new listings" when there were no source errors — errors already showed their own toasts
            toast("info", "No new listings found.");
          }
        }
        // A fetch brings in new listings — jump to page 1 so they're visible.
        setPage(1);
        void loadListings(1, statusFilter, debouncedSearch);
      } else {
        // Verdict/label updates (Find Workable, background auto-shortlist, single Analyze)
        // change cards in place — refresh the current page so the user isn't yanked to page 1.
        void loadListings(page, statusFilter, debouncedSearch);
      }
    };
    window.addEventListener("agentdesk:freelance-listings-updated", handler);
    return () => window.removeEventListener("agentdesk:freelance-listings-updated", handler);
  }, [page, statusFilter, debouncedSearch, loadListings]);

  // ---- Actions -------------------------------------------------------------

  const handleFetchNow = async () => {
    setFetching(true);
    try {
      const result = await rpc.freelanceTriggerFetch();
      if (result.skipped && result.reason) {
        // Fetch won't run — clear the spinner immediately
        setFetching(false);
        toast("warning", result.reason);
      }
      // If fetch started, fetching stays true until listingsUpdated fires
    } catch (err) {
      console.error("Failed to trigger fetch:", err);
      setFetching(false);
      toast("error", "Failed to trigger fetch. Please try again.");
    }
  };

  const handleApprove = useCallback(
    async (listing: FreelanceListingDto) => {
      const result = await rpc.freelanceApproveListing(listing.id);
      void navigate({
        to: "/project/$projectId",
        params: { projectId: result.projectId },
      });
      await loadListings(page, statusFilter, debouncedSearch);
    },
    [navigate, page, statusFilter, debouncedSearch, loadListings],
  );

  const handleShortlist = useCallback(
    async (listing: FreelanceListingDto) => {
      await rpc.freelanceShortlistListings([listing.id]);
      await loadListings(page, statusFilter, debouncedSearch);
    },
    [page, statusFilter, debouncedSearch, loadListings],
  );

  const handleMarkDone = useCallback(
    async (listing: FreelanceListingDto) => {
      await rpc.freelanceMarkListingDone(listing.id);
      await loadListings(page, statusFilter, debouncedSearch);
    },
    [page, statusFilter, debouncedSearch, loadListings],
  );

  const handleDelete = useCallback(
    async (listing: FreelanceListingDto) => {
      await rpc.freelanceDeleteListing(listing.id);
      await loadListings(page, statusFilter, debouncedSearch);
    },
    [page, statusFilter, debouncedSearch, loadListings],
  );

  const handleAnalyze = useCallback(
    async (listing: FreelanceListingDto) => {
      setAnalyzingIds((prev) => new Set(prev).add(listing.id));
      try {
        const result = await rpc.freelanceWizardAnalyzeListing(listing.id);
        // Backend broadcasts LISTINGS_UPDATED which triggers reload via the event handler.
        // Set openModalForId so the card auto-opens the modal even after tab navigation.
        setOpenModalForId(listing.id);
        return result;
      } finally {
        setAnalyzingIds((prev) => {
          const next = new Set(prev);
          next.delete(listing.id);
          return next;
        });
      }
    },
    [],
  );

  // ---- Multi-select ---------------------------------------------------------

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // "Select all" = every listing on the current page (selection is page-scoped).
  const allOnPageSelected = listings.length > 0 && listings.every((l) => selectedIds.has(l.id));
  const toggleSelectAllOnPage = useCallback(() => {
    setSelectedIds((prev) => {
      const everySelected = listings.length > 0 && listings.every((l) => prev.has(l.id));
      return everySelected ? new Set() : new Set(listings.map((l) => l.id));
    });
  }, [listings]);

  const handleDeleteSelected = async () => {
    if (selectedIds.size === 0) return;
    setDeletingSelected(true);
    try {
      const ids = [...selectedIds];
      const result = await rpc.freelanceDeleteListings(ids);
      setConfirmDeleteSelected(false);
      setSelectMode(false);
      setSelectedIds(new Set());
      toast("success", `Deleted ${result.deleted} listing${result.deleted === 1 ? "" : "s"}.`);
      await loadListings(page, statusFilter, debouncedSearch);
    } catch (err) {
      console.error("Failed to delete selected listings:", err);
      toast("error", "Failed to delete the selected listings.");
    } finally {
      setDeletingSelected(false);
    }
  };

  const handleFilterChange = (value: StatusFilter) => {
    setStatusFilter(value);
    setPage(1);
    clearSelection(); // selection is page-scoped — switching tabs resets it
  };

  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1);
      clearSelection();
    }, 300);
  };

  const goToPage = useCallback((p: number) => {
    setPage(p);
    clearSelection(); // selection is current-page only
  }, [clearSelection]);

  // ---- Derived state -------------------------------------------------------

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // ---- Render --------------------------------------------------------------

  return (
    <div className="space-y-4">
      {/* Toolbar — Row 1: Search (left) + actions (right) */}
      <div className="flex items-center gap-2">
        <div className="relative w-56">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search listings…"
            aria-label="Search listings"
            className="w-full rounded-md border border-border bg-background pl-8 pr-7 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {search && (
            <button
              type="button"
              onClick={() => handleSearchChange("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {/* Find Workable */}
          <button
            onClick={() => setWizardOpen(true)}
            aria-label="Find workable projects using AI analysis"
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700 hover:border-indigo-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring whitespace-nowrap"
          >
            <Sparkles className="size-3.5" />
            Find Workable
          </button>

          {/* Fetch Now */}
          <button
            onClick={() => void handleFetchNow()}
            disabled={fetching}
            aria-label="Manually trigger a listings fetch"
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border border-green-600 bg-green-600 text-white hover:bg-green-700 hover:border-green-700 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring whitespace-nowrap"
          >
            {fetching ? (
              <span
                aria-hidden="true"
                className="h-3.5 w-3.5 rounded-full border-2 border-white border-t-transparent animate-spin"
              />
            ) : (
              <span aria-hidden="true" className="text-base leading-none">
                ↻
              </span>
            )}
            {fetching ? "Fetching…" : "Fetch Now"}
          </button>
        </div>
      </div>

      {/* Toolbar — Row 2: Status filter tabs */}
      <div className="flex items-center justify-between gap-2">
      <div
        role="tablist"
        aria-label="Filter listings by status"
        className="inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground"
      >
        {FILTERS.map((f) => (
          <button
            key={String(f.value)}
            role="tab"
            aria-selected={statusFilter === f.value}
            onClick={() => handleFilterChange(f.value)}
            className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              statusFilter === f.value
                ? "bg-background text-foreground shadow"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {f.label}
            <span className={`text-xs tabular-nums px-1.5 py-0.5 rounded-full ${
              statusFilter === f.value
                ? "bg-muted text-foreground"
                : "bg-muted/60 text-muted-foreground"
            }`}>
              {counts[f.countKey]}
            </span>
          </button>
        ))}
      </div>

        {/* Multi-select controls — far right, below the status tabs */}
        <div className="flex items-center gap-2">
          {!selectMode ? (
            counts.all > 0 && (
              <button
                onClick={() => setSelectMode(true)}
                aria-label="Select listings to delete"
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CheckSquare className="size-3.5" />
                Select
              </button>
            )
          ) : (
            <>
              <button
                onClick={toggleSelectAllOnPage}
                disabled={listings.length === 0}
                className="px-3 py-1.5 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {allOnPageSelected ? "Deselect all" : "Select all"}
              </button>
              <button
                onClick={() => setConfirmDeleteSelected(true)}
                disabled={selectedIds.size === 0}
                aria-label="Delete selected listings"
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-destructive/50 text-destructive hover:bg-destructive/10 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Trash2 className="size-3.5" />
                Delete{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
              </button>
              <button
                onClick={exitSelectMode}
                className="px-3 py-1.5 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {/* Verdict filter chips — New tab only. All chips visible by default; clicking hides that verdict type. */}
      {statusFilter === "new" && (
        <div className="flex items-center justify-center gap-3">
          <span className="text-xs font-medium text-muted-foreground">Filter:</span>
          {LISTING_KIND_CHIPS.map((chip) => {
            const hidden = hiddenKinds.has(chip.kind);
            return (
              <Tip key={chip.kind} content={hidden ? `Filtering out ${chip.label} (click to show)` : `Showing ${chip.label} (click to filter out)`} side="top">
                <button
                  type="button"
                  aria-label={hidden ? `Show ${chip.label} listings` : `Hide ${chip.label} listings`}
                  aria-pressed={hidden}
                  onClick={() => handleKindFilter(chip.kind)}
                  className={`size-5 rounded-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${chip.swatch} ${
                    hidden
                      ? "opacity-30 hover:opacity-60 ring-0"
                      : `ring-2 ring-offset-2 ring-offset-background ${chip.ring}`
                  }`}
                />
              </Tip>
            );
          })}
        </div>
      )}

      {/* List area */}
      {loading ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading listings">
          <ListingSkeleton />
          <ListingSkeleton />
          <ListingSkeleton />
        </div>
      ) : listings.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-muted-foreground text-sm">
            {debouncedSearch
              ? `No listings match "${debouncedSearch}".`
              : hiddenKinds.size === LISTING_KIND_CHIPS.length
                ? "All verdict types are filtered out. Click the chips above to show some."
                : "No listings found."}
          </p>
          {!debouncedSearch && hiddenKinds.size < LISTING_KIND_CHIPS.length && (
            <p className="text-muted-foreground text-xs mt-1">
              Configure keywords in Settings then click Fetch Now.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {listings.map((listing) => (
            <FreelanceListingCard
              key={listing.id}
              listing={listing}
              onApprove={() => handleApprove(listing)}
              onShortlist={() => handleShortlist(listing)}
              onMarkDone={() => handleMarkDone(listing)}
              onDelete={() => handleDelete(listing)}
              onAnalyze={() => handleAnalyze(listing)}
              isAnalyzing={analyzingIds.has(listing.id)}
              autoOpenAnalysis={openModalForId === listing.id}
              onAnalysisModalClose={() => setOpenModalForId(null)}
              timezone={timezone}
              preferredCurrency={preferredCurrency}
              currencyRates={currencyRates}
              autoEarnEnabled={autoEarnEnabled}
              selectable={selectMode}
              selected={selectedIds.has(listing.id)}
              onToggleSelect={() => toggleSelect(listing.id)}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <button
            onClick={() => goToPage(Math.max(1, page - 1))}
            disabled={page === 1}
            aria-label="Previous page"
            className="px-3 py-1 text-sm rounded border border-border disabled:opacity-40 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
          >
            ← Prev
          </button>
          <span className="text-sm text-muted-foreground" aria-live="polite">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => goToPage(Math.min(totalPages, page + 1))}
            disabled={page === totalPages}
            aria-label="Next page"
            className="px-3 py-1 text-sm rounded border border-border disabled:opacity-40 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
          >
            Next →
          </button>
        </div>
      )}

      {/* Delete Selected confirmation dialog */}
      <Dialog open={confirmDeleteSelected} onOpenChange={(open) => { if (!deletingSelected) setConfirmDeleteSelected(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-destructive" />
              Delete {selectedIds.size} listing{selectedIds.size === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription className="pt-1 text-foreground">
              This permanently deletes the selected listing{selectedIds.size === 1 ? "" : "s"} from this tab. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <button
              onClick={() => setConfirmDeleteSelected(false)}
              disabled={deletingSelected}
              className="px-4 py-2 text-sm rounded-md border border-border hover:bg-muted/50 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleDeleteSelected()}
              disabled={deletingSelected}
              className="flex items-center gap-2 px-4 py-2 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {deletingSelected ? (
                <span className="h-3.5 w-3.5 rounded-full border-2 border-destructive-foreground border-t-transparent animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              {deletingSelected ? "Deleting…" : `Delete ${selectedIds.size}`}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Find Workable wizard */}
      <FindWorkableModal
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onShortlisted={() => {
          setWizardOpen(false);
          setStatusFilter("shortlisted");
          setPage(1);
          void loadListings(1, "shortlisted", debouncedSearch);
        }}
      />

      {/* Scroll to top / bottom buttons */}
      {(showScrollTop || showScrollBottom) && (
        <div className="fixed bottom-6 right-6 flex flex-col gap-2 z-50">
          {showScrollTop && (
            <button
              onClick={() => document.getElementById("main-scroll-container")?.scrollTo({ top: 0, behavior: "smooth" })}
              aria-label="Scroll to top"
              className="flex items-center justify-center size-9 rounded-full bg-background border border-border shadow-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronUp className="size-4" />
            </button>
          )}
          {showScrollBottom && (
            <button
              onClick={() => {
                const c = document.getElementById("main-scroll-container");
                if (c) c.scrollTo({ top: c.scrollHeight, behavior: "smooth" });
              }}
              aria-label="Scroll to bottom"
              className="flex items-center justify-center size-9 rounded-full bg-background border border-border shadow-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronDown className="size-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
