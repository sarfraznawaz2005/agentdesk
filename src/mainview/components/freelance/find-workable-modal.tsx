import { useEffect, useRef, useState, useCallback } from "react";
import { Tip } from "@/components/ui/tooltip";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AlertTriangle, CheckSquare, ChevronDown, ChevronRight, Info, Loader2, Square, StopCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { rpc } from "@/lib/rpc";
import type { WizardWorkableListing, WizardFailedListing } from "../../../shared/rpc/freelance";
import { getCurrencySymbol } from "../../../shared/freelance-currencies";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WizardStep = "config" | "analyzing" | "results";

interface ProgressItem {
  listingId: string;
  title: string;
  phase: "fetching" | "analyzing" | "done";
  workable?: boolean;
}

// ---------------------------------------------------------------------------
// Budget display helpers
// ---------------------------------------------------------------------------

interface BudgetDisplay {
  primary: string;
  converted: string | null;
  tooltipRate: string | null;
}

function convertAmount(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  rates: Record<string, number>,
): number | null {
  const from = fromCurrency.toLowerCase();
  const to = toCurrency.toLowerCase();
  if (from === to) return amount;
  const fromRate = from === "usd" ? 1 : rates[from];
  const toRate = to === "usd" ? 1 : rates[to];
  if (fromRate == null || toRate == null || fromRate === 0) return null;
  return (amount / fromRate) * toRate;
}

function fmt(value: number): string {
  return value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(2);
}

function buildBudgetDisplay(
  listing: WizardWorkableListing,
  preferredCurrency: string,
  rates: Record<string, number>,
): BudgetDisplay {
  const { budgetMin, budgetMax, budgetType, currency } = listing;
  if (budgetMin === null && budgetMax === null) return { primary: "", converted: null, tooltipRate: null };

  const listingCurrency = (currency || "USD").toUpperCase();
  const sym = getCurrencySymbol(listingCurrency);
  const suffix = budgetType === "hourly" ? "/hr" : "";

  let primary: string;
  if (budgetMin !== null && budgetMax !== null)
    primary = `${sym}${budgetMin.toLocaleString()}–${sym}${budgetMax.toLocaleString()}${suffix}`;
  else if (budgetMin !== null)
    primary = `${sym}${budgetMin.toLocaleString()}+${suffix}`;
  else
    primary = `Up to ${sym}${(budgetMax ?? 0).toLocaleString()}${suffix}`;

  const prefCode = preferredCurrency.toUpperCase();
  if (listingCurrency === prefCode || !rates || Object.keys(rates).length === 0)
    return { primary, converted: null, tooltipRate: null };

  const convertedMin = budgetMin !== null ? convertAmount(budgetMin, listingCurrency, prefCode, rates) : null;
  const convertedMax = budgetMax !== null ? convertAmount(budgetMax, listingCurrency, prefCode, rates) : null;

  if (convertedMin === null && convertedMax === null)
    return { primary, converted: null, tooltipRate: null };

let converted: string;
  if (convertedMin !== null && convertedMax !== null)
    converted = `${fmt(convertedMin)} – ${fmt(convertedMax)} ${prefCode}${suffix}`;
  else if (convertedMin !== null)
    converted = `${fmt(convertedMin)}+ ${prefCode}${suffix}`;
  else
    converted = `Up to ${fmt(convertedMax ?? 0)} ${prefCode}${suffix}`;

  const rate1 = convertAmount(1, listingCurrency, prefCode, rates);
  const tooltipRate = rate1 !== null
    ? `1 ${listingCurrency} = ${rate1 >= 100 ? Math.round(rate1).toLocaleString() : rate1.toFixed(4)} ${prefCode}`
    : null;

  return { primary, converted, tooltipRate };
}

// ---------------------------------------------------------------------------
// Step 1 — Config
// ---------------------------------------------------------------------------

type ConfigMode = "count" | "hourly";

function ConfigStep({
  mode,
  onModeChange,
  count,
  onCountChange,
  hours,
  onHoursChange,
  onStart,
}: {
  mode: ConfigMode;
  onModeChange: (m: ConfigMode) => void;
  count: number;
  onCountChange: (v: number) => void;
  hours: number;
  onHoursChange: (v: number) => void;
  onStart: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground leading-relaxed">
        This wizard analyzes your latest listings to find which ones are fully deliverable.
        For each listing it checks two things: whether your local system has all required
        software installed, and whether the AI agent system can complete all technical
        requirements on its own.
      </p>

      {/* Mode toggle */}
      <div className="flex gap-0 rounded-lg border border-border overflow-hidden w-fit">
        {(["count", "hourly"] as ConfigMode[]).map((m) => (
          <button
            key={m}
            onClick={() => onModeChange(m)}
            className={[
              "px-4 py-1.5 text-sm font-medium transition-colors focus:outline-none",
              mode === m
                ? "bg-primary text-primary-foreground"
                : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted",
            ].join(" ")}
          >
            {m === "count" ? "Listing count" : "Run hourly"}
          </button>
        ))}
      </div>

      {mode === "count" ? (
        <>
          <div className="space-y-2">
            <label htmlFor="wizard-count" className="text-sm font-medium text-foreground">
              Listings to analyze
            </label>
            <input
              id="wizard-count"
              type="number"
              min={1}
              max={25}
              value={count}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v)) onCountChange(Math.max(1, Math.min(25, v)));
              }}
              className="w-28 rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
            <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
            Increasing listing count consumes more tokens. Each listing requires at least one AI analysis call.
          </p>
          <div className="flex justify-end">
            <Button onClick={onStart}>Analyze Listings</Button>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-2">
            <label htmlFor="wizard-hours" className="text-sm font-medium text-foreground">
              Run for
            </label>
            <div className="flex items-center gap-2">
              <select
                id="wizard-hours"
                value={hours}
                onChange={(e) => onHoursChange(Number(e.target.value))}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {[1, 2, 3, 4, 5].map((h) => (
                  <option key={h} value={h}>{h} {h === 1 ? "hour" : "hours"}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <Info className="size-3.5 mt-0.5 shrink-0" />
            Analyzes all listings fetched in the last {hours} {hours === 1 ? "hour" : "hours"}. Previously analyzed listings use cached results instantly.
          </p>
          <div className="flex justify-end">
            <Button onClick={onStart}>Start Hourly Analysis</Button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Analyzing
// ---------------------------------------------------------------------------

function AnalyzingStep({
  progress,
  total,
  onStop,
  isStopping,
}: {
  progress: ProgressItem[];
  total: number;
  onStop: () => void;
  isStopping: boolean;
}) {
  const done = progress.filter((p) => p.phase === "done").length;
  const current = progress[progress.length - 1];
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="flex flex-col items-center gap-6 py-4">
      {/* Spinner + status text */}
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="size-10 text-indigo-500 animate-spin" />
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">
            {current
              ? current.phase === "fetching"
                ? `Fetching listing details…`
                : current.phase === "analyzing"
                  ? `Analyzing ${done + 1} of ${total}…`
                  : `Completed ${done} of ${total}`
              : "Starting analysis…"}
          </p>
          {current && (
            <p className="text-xs text-muted-foreground mt-1">{current.title}</p>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full">
        <div className="flex justify-between text-xs text-muted-foreground mb-1">
          <span>{done} done</span>
          <span>{total} total</span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-indigo-500 transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Completed items */}
      {progress.filter((p) => p.phase === "done").length > 0 && (
        <div className="w-full space-y-1 max-h-48 overflow-y-auto">
          {progress
            .filter((p) => p.phase === "done")
            .map((p) => (
              <div key={p.listingId} className="flex items-start gap-2 text-xs">
                <span className={`shrink-0 ${p.workable ? "text-green-500" : "text-muted-foreground"}`}>
                  {p.workable ? "✓" : "✗"}
                </span>
                <span className={p.workable ? "text-foreground" : "text-muted-foreground"}>
                  {p.title}
                </span>
              </div>
            ))}
        </div>
      )}

      {/* Stop button */}
      <button
        type="button"
        onClick={onStop}
        disabled={isStopping}
        className="flex items-center gap-2 px-4 py-2 text-sm rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/50 hover:bg-destructive/10 disabled:opacity-50 transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {isStopping
          ? <Loader2 className="size-3.5 animate-spin" />
          : <StopCircle className="size-3.5" />}
        {isStopping ? "Stopping…" : "Stop Analysis"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Results
// ---------------------------------------------------------------------------

function FailedListingRow({ listing }: { listing: WizardFailedListing }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = listing.reason || listing.blockers.length > 0;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((v) => !v)}
        className={`w-full flex items-center gap-2 px-3 py-2.5 text-left focus:outline-none ${hasDetails ? "cursor-pointer hover:bg-muted/40 transition-colors" : "cursor-default"}`}
      >
        <span className="shrink-0 text-muted-foreground/40">
          <Square className="size-4" />
        </span>
        <span className="flex-1 text-sm text-muted-foreground truncate">{listing.title}</span>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
            listing.filtered
              ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
              : "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400"
          }`}
        >
          {listing.filtered ? "Filtered" : "Analysis"}
        </span>
        {hasDetails && (
          <span className="shrink-0 text-muted-foreground">
            {expanded ? <ChevronDown className="size-3.5" /> : <Info className="size-3.5" />}
          </span>
        )}
      </button>
      {expanded && hasDetails && (
        <div className="px-3 pb-2.5 ml-6 space-y-1.5 text-xs text-muted-foreground">
          {listing.reason && <p>{listing.reason}</p>}
          {listing.blockers.length > 0 && (
            <ul className="list-disc list-inside space-y-0.5">
              {listing.blockers.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ResultsStep({
  workableListings,
  failedListings,
  selected,
  onToggle,
  onToggleAll,
  onShortlist,
  isShortlisting,
  preferredCurrency,
  currencyRates,
}: {
  workableListings: WizardWorkableListing[];
  failedListings: WizardFailedListing[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onShortlist: () => void;
  isShortlisting: boolean;
  preferredCurrency: string;
  currencyRates: Record<string, number>;
}) {
  const [showFailed, setShowFailed] = useState(workableListings.length === 0);

  if (workableListings.length === 0 && failedListings.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
        <span className="text-3xl" aria-hidden>🔍</span>
        <p className="text-sm font-medium text-foreground">No workable projects found</p>
        <p className="text-xs text-muted-foreground max-w-xs">
          None of the analyzed listings passed both checks (system requirements and AI capability).
          Try again after new listings are fetched, or check individual listings manually.
        </p>
      </div>
    );
  }

  const allSelected = workableListings.length > 0 && selected.size === workableListings.length;

  return (
    <div className="flex flex-col gap-4">
      {/* Workable section */}
      {workableListings.length > 0 ? (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {workableListings.length} workable {workableListings.length === 1 ? "project" : "projects"} found.
              Select the ones to shortlist.
            </p>
            <button
              type="button"
              onClick={onToggleAll}
              className="text-xs text-indigo-500 hover:text-indigo-600 font-medium focus:outline-none"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          </div>

          <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
            {workableListings.map((listing) => {
              const isSelected = selected.has(listing.id);
              const budget = buildBudgetDisplay(listing, preferredCurrency, currencyRates);
              return (
                <button
                  key={listing.id}
                  type="button"
                  onClick={() => onToggle(listing.id)}
                  className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors focus:outline-none ${
                    isSelected
                      ? "border-indigo-500 bg-indigo-500/5"
                      : "border-border bg-card hover:bg-muted/40"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span className={`shrink-0 ${isSelected ? "text-indigo-500" : "text-muted-foreground"}`}>
                      {isSelected ? <CheckSquare className="size-4" /> : <Square className="size-4" />}
                    </span>
                    <span className="flex-1 text-sm font-medium text-foreground truncate">{listing.title}</span>
                    {budget.primary && (
                      <span className="flex items-center gap-1 shrink-0 tabular-nums">
                        <span className="text-xs text-muted-foreground">{budget.primary}</span>
                        {budget.converted && (
                          budget.tooltipRate ? (
                            <Tip content={budget.tooltipRate} side="top">
                              <span className="text-xs font-semibold text-blue-900 dark:text-blue-300 cursor-default">
                                ({budget.converted})
                              </span>
                            </Tip>
                          ) : (
                            <span className="text-xs font-semibold text-blue-900 dark:text-blue-300 cursor-default">
                              ({budget.converted})
                            </span>
                          )
                        )}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No workable projects found.</p>
      )}

      {/* Failed section */}
      {failedListings.length > 0 && (
        <>
          <div className="border-t border-border pt-3">
            <button
              type="button"
              onClick={() => setShowFailed((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors focus:outline-none"
            >
              {showFailed ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              {failedListings.length} not workable
            </button>
          </div>
          {showFailed && (
            <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
              {failedListings.map((listing) => (
                <FailedListingRow key={listing.id} listing={listing} />
              ))}
            </div>
          )}
        </>
      )}

      {/* Footer actions */}
      {workableListings.length > 0 && (
        <div className="flex items-center justify-between pt-1 border-t border-border">
          <span className="text-xs text-muted-foreground">
            {selected.size} of {workableListings.length} selected
          </span>
          <Button
            onClick={onShortlist}
            disabled={selected.size === 0 || isShortlisting}
            className="gap-2"
          >
            {isShortlisting && <Loader2 className="size-3.5 animate-spin" />}
            {isShortlisting ? "Shortlisting…" : `Shortlist Selected (${selected.size})`}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------

interface FindWorkableModalProps {
  open: boolean;
  onClose: () => void;
  onShortlisted: () => void;
}

export function FindWorkableModal({ open, onClose, onShortlisted }: FindWorkableModalProps) {
  const [step, setStep] = useState<WizardStep>("config");
  const [mode, setMode] = useState<ConfigMode>("count");
  const [count, setCount] = useState(10);
  const [hours, setHours] = useState(1);
  const [total, setTotal] = useState(0);
  const [progress, setProgress] = useState<ProgressItem[]>([]);
  const [workableListings, setWorkableListings] = useState<WizardWorkableListing[]>([]);
  const [failedListings, setFailedListings] = useState<WizardFailedListing[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isShortlisting, setIsShortlisting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [wasStopped, setWasStopped] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [preferredCurrency, setPreferredCurrency] = useState("USD");
  const [currencyRates, setCurrencyRates] = useState<Record<string, number>>({});
  const progressRef = useRef<ProgressItem[]>([]);

  // Reset when modal opens and load currency settings
  useEffect(() => {
    if (open) {
      setStep("config");
      setMode("count");
      setCount(10);
      setHours(1);
      setTotal(0);
      setProgress([]);
      progressRef.current = [];
      setWorkableListings([]);
      setFailedListings([]);
      setSelected(new Set());
      setIsShortlisting(false);
      setIsStopping(false);
      setWasStopped(false);
      setErrorMsg(null);

      void Promise.all([rpc.freelanceGetSettings(), rpc.freelanceGetCurrencyRates()]).then(
        ([settings, ratesResult]) => {
          setPreferredCurrency(settings.preferredCurrency ?? "USD");
          setCurrencyRates(ratesResult.rates ?? {});
        },
      );
    }
  }, [open]);

  // Wizard broadcast events
  useEffect(() => {
    const onProgress = (e: Event) => {
      const detail = (e as CustomEvent<{
        current: number; total: number; listingId: string; title: string;
        phase: "fetching" | "analyzing" | "done"; workable?: boolean;
      }>).detail;

      setTotal(detail.total);

      setProgress((prev) => {
        const next = [...prev];
        const idx = next.findIndex((p) => p.listingId === detail.listingId);
        const item: ProgressItem = {
          listingId: detail.listingId,
          title: detail.title,
          phase: detail.phase,
          workable: detail.workable,
        };
        if (idx >= 0) next[idx] = item;
        else next.push(item);
        progressRef.current = next;
        return next;
      });
    };

    const onComplete = (e: Event) => {
      const { workableListings: wl, failedListings: fl } = (e as CustomEvent<{
        workableListings: WizardWorkableListing[];
        failedListings: WizardFailedListing[];
      }>).detail;
      setWorkableListings(wl);
      setFailedListings(fl ?? []);
      setSelected(new Set(wl.map((l) => l.id)));
      setStep("results");
    };

    const onError = (e: Event) => {
      const { error } = (e as CustomEvent<{ error: string }>).detail;
      setErrorMsg(error);
      setStep("results");
    };

    const onStopped = (e: Event) => {
      const { workableListings: wl, failedListings: fl } = (e as CustomEvent<{
        workableListings: WizardWorkableListing[];
        failedListings: WizardFailedListing[];
      }>).detail;
      setIsStopping(false);
      setWasStopped(true);
      setWorkableListings(wl);
      setFailedListings(fl ?? []);
      setSelected(new Set(wl.map((l) => l.id)));
      setStep("results");
    };

    window.addEventListener("agentdesk:freelance-wizard-progress", onProgress);
    window.addEventListener("agentdesk:freelance-wizard-complete", onComplete);
    window.addEventListener("agentdesk:freelance-wizard-error", onError);
    window.addEventListener("agentdesk:freelance-wizard-stopped", onStopped);
    return () => {
      window.removeEventListener("agentdesk:freelance-wizard-progress", onProgress);
      window.removeEventListener("agentdesk:freelance-wizard-complete", onComplete);
      window.removeEventListener("agentdesk:freelance-wizard-error", onError);
      window.removeEventListener("agentdesk:freelance-wizard-stopped", onStopped);
    };
  }, []);

  const handleStart = useCallback(async () => {
    setStep("analyzing");
    setProgress([]);
    progressRef.current = [];
    setErrorMsg(null);
    try {
      if (mode === "hourly") {
        await rpc.freelanceWizardStart({ hours });
      } else {
        await rpc.freelanceWizardStart({ count });
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to start analysis");
      setStep("results");
    }
  }, [mode, count, hours]);

  const handleToggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleToggleAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === workableListings.length
        ? new Set()
        : new Set(workableListings.map((l) => l.id)),
    );
  }, [workableListings]);

  const handleStop = useCallback(async () => {
    setIsStopping(true);
    try {
      await rpc.freelanceWizardStop();
    } catch (err) {
      console.error("[find-workable] Stop failed:", err);
      setIsStopping(false);
    }
  }, []);

  const handleShortlist = useCallback(async () => {
    if (selected.size === 0) return;
    setIsShortlisting(true);
    try {
      await rpc.freelanceShortlistListings([...selected]);
      onShortlisted();
      onClose();
    } catch (err) {
      console.error("[find-workable] Shortlist failed:", err);
    } finally {
      setIsShortlisting(false);
    }
  }, [selected, onShortlisted, onClose]);

  const title =
    step === "config" ? "Find Workable Projects"
    : step === "analyzing" ? "Analyzing Listings…"
    : "Workable Projects";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] w-[min(92vw,820px)] flex flex-col bg-background border border-border rounded-xl shadow-2xl overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          aria-describedby={undefined}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <DialogPrimitive.Title className="text-sm font-semibold text-foreground">
              {title}
            </DialogPrimitive.Title>
            {step !== "analyzing" && (
              <DialogPrimitive.Close
                className="p-1.5 rounded-md opacity-70 hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity focus:outline-none focus:ring-2 focus:ring-ring"
                aria-label="Close"
              >
                <X className="size-4" />
              </DialogPrimitive.Close>
            )}
          </div>

          {/* Body */}
          <div className="px-5 py-5">
            {errorMsg ? (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <AlertTriangle className="size-8 text-red-500" />
                <p className="text-sm font-medium text-foreground">Analysis failed</p>
                <p className="text-xs text-muted-foreground max-w-xs">{errorMsg}</p>
                <Button variant="outline" size="sm" onClick={() => setStep("config")}>
                  Try again
                </Button>
              </div>
            ) : step === "config" ? (
              <ConfigStep
                mode={mode}
                onModeChange={setMode}
                count={count}
                onCountChange={setCount}
                hours={hours}
                onHoursChange={setHours}
                onStart={() => void handleStart()}
              />
            ) : step === "analyzing" ? (
              <AnalyzingStep
                progress={progress}
                total={total}
                onStop={() => void handleStop()}
                isStopping={isStopping}
              />
            ) : (
              <>
                {wasStopped && (
                  <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-600 dark:text-amber-400">
                    <StopCircle className="size-3.5 shrink-0" />
                    Analysis was stopped early. Results below show what was found before stopping.
                  </div>
                )}
              <ResultsStep
                workableListings={workableListings}
                failedListings={failedListings}
                selected={selected}
                onToggle={handleToggle}
                onToggleAll={handleToggleAll}
                onShortlist={() => void handleShortlist()}
                isShortlisting={isShortlisting}
                preferredCurrency={preferredCurrency}
                currencyRates={currencyRates}
              />
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
