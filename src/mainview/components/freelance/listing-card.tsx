import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Tip } from "../ui/tooltip";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Bookmark, Bot, Check, CheckCircle, CheckCircle2, Copy, Download, ExternalLink, Filter, Globe, Loader2, MapPin, MessageSquare, RefreshCw, ShieldCheck, Sparkles, Star, ThumbsDown, Timer, Trash2, UserX, Wrench, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../ui/dialog";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { downloadMarkdown } from "@/lib/export-markdown";
import { FreelanceChatModal } from "./freelance-chat-modal";
import type { FreelanceListingDto, FreelanceBlockKind, BidQuestionDto, BidAnswerDto } from "../../../shared/rpc/freelance";
import { BidRequirementsModal } from "./bid-requirements-modal";
import { pillLabel, pillTone, type PillTone } from "./block-kind";
import { getCurrencySymbol } from "../../../shared/freelance-currencies";

// ---------------------------------------------------------------------------
// Currency conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert amount using USD-based rates (same algorithm as backend currency-exchange.ts).
 * rates["pkr"] = 278.5 means 1 USD = 278.5 PKR.
 */
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

function fmtNum(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 100) return Math.round(amount).toLocaleString();
  return amount.toFixed(2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(isoString: string | null): string {
  if (!isoString) return "";
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 0) return "just now";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatFullDate(isoString: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(isoString));
  } catch {
    return new Date(isoString).toLocaleString();
  }
}

interface BudgetDisplay {
  primary: string;
  converted: string | null;
  tooltipRate: string | null; // e.g. "1 USD = 278.5 PKR"
}

function buildBudgetDisplay(
  listing: FreelanceListingDto,
  preferredCurrency: string,
  rates: Record<string, number>,
): BudgetDisplay {
  const { budgetMin, budgetMax, budgetType, currency } = listing;

  if (budgetMin === null && budgetMax === null) {
    return { primary: "Budget not specified", converted: null, tooltipRate: null };
  }

  const listingCurrency = currency.toUpperCase();
  const symbol = getCurrencySymbol(listingCurrency);
  const typeLabel = budgetType === "fixed" ? "Fixed" : "Hourly";
  const rateLabel = budgetType === "hourly" ? "/hr" : "";

  let primary: string;
  if (budgetMin !== null && budgetMax !== null) {
    primary = `${symbol}${budgetMin.toLocaleString()}–${symbol}${budgetMax.toLocaleString()}${rateLabel} · ${typeLabel}`;
  } else if (budgetMin !== null) {
    primary = `${symbol}${budgetMin.toLocaleString()}+${rateLabel} · ${typeLabel}`;
  } else {
    primary = `Up to ${symbol}${(budgetMax ?? 0).toLocaleString()}${rateLabel} · ${typeLabel}`;
  }

  // Skip conversion if preferred currency = listing currency or no rates
  const target = preferredCurrency.toUpperCase();
  if (target === listingCurrency || !rates || Object.keys(rates).length === 0) {
    return { primary, converted: null, tooltipRate: null };
  }

  // Build converted annotation
  let converted: string | null = null;
  if (budgetMin !== null && budgetMax !== null) {
    const cvMin = convertAmount(budgetMin, listingCurrency, target, rates);
    const cvMax = convertAmount(budgetMax, listingCurrency, target, rates);
    if (cvMin !== null && cvMax !== null) {
      converted = `${fmtNum(cvMin)} – ${fmtNum(cvMax)} ${target}`;
    }
  } else if (budgetMin !== null) {
    const cv = convertAmount(budgetMin, listingCurrency, target, rates);
    if (cv !== null) converted = `${fmtNum(cv)}+ ${target}`;
  } else if (budgetMax !== null) {
    const cv = convertAmount(budgetMax, listingCurrency, target, rates);
    if (cv !== null) converted = `up to ${fmtNum(cv)} ${target}`;
  }

  // Build tooltip: "1 USD = 278.5 PKR"
  let tooltipRate: string | null = null;
  const rate = convertAmount(1, listingCurrency, target, rates);
  if (rate !== null) {
    const formatted = rate >= 100 ? Math.round(rate).toLocaleString() : rate.toFixed(4).replace(/\.?0+$/, "");
    tooltipRate = `1 ${listingCurrency} = ${formatted} ${target}`;
  }

  return { primary, converted, tooltipRate };
}

// ---------------------------------------------------------------------------
// Platform badge
// ---------------------------------------------------------------------------

const TEXT = "text-foreground";

const PLATFORM_COLORS: Record<string, { bg: string; border: string }> = {
  "freelancer.com": { bg: "bg-green-100  dark:bg-green-500/20",  border: "border-green-200  dark:border-green-500/30"  },
  "upwork":         { bg: "bg-teal-100   dark:bg-teal-500/20",   border: "border-teal-200   dark:border-teal-500/30"   },
  "guru":           { bg: "bg-violet-100 dark:bg-violet-500/20", border: "border-violet-200 dark:border-violet-500/30" },
  "toptal":         { bg: "bg-cyan-100   dark:bg-cyan-500/20",   border: "border-cyan-200   dark:border-cyan-500/30"   },
};

const PALETTE_FALLBACK = [
  { bg: "bg-pink-100   dark:bg-pink-500/20",   border: "border-pink-200   dark:border-pink-500/30"   },
  { bg: "bg-amber-100  dark:bg-amber-500/20",  border: "border-amber-200  dark:border-amber-500/30"  },
  { bg: "bg-indigo-100 dark:bg-indigo-500/20", border: "border-indigo-200 dark:border-indigo-500/30" },
  { bg: "bg-rose-100   dark:bg-rose-500/20",   border: "border-rose-200   dark:border-rose-500/30"   },
  { bg: "bg-blue-100   dark:bg-blue-500/20",   border: "border-blue-200   dark:border-blue-500/30"   },
];

function getPlatformColor(platform: string) {
  const key = platform.toLowerCase().replace(/\s+/g, "");
  if (PLATFORM_COLORS[key]) return PLATFORM_COLORS[key];
  const hash = [...platform].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return PALETTE_FALLBACK[hash % PALETTE_FALLBACK.length];
}

function PlatformBadge({ platform }: { platform: string }) {
  const { bg, border } = getPlatformColor(platform);
  return (
    <span className={`inline-flex items-center rounded-md border px-2.5 py-1 text-sm font-semibold ${bg} ${border} ${TEXT}`}>
      {platform}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Skills chips
// ---------------------------------------------------------------------------

function SkillChips({ skills }: { skills: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {skills.map((skill) => (
        <Badge
          key={skill}
          variant="secondary"
          className="rounded-full px-2.5 py-0.5 text-xs font-normal"
        >
          {skill}
        </Badge>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown component overrides for analysis modal (mirrors freelance-chat-modal)
// ---------------------------------------------------------------------------

const ANALYSIS_MD_COMPONENTS = {
  p: ({ children }: { children: React.ReactNode }) => <p className="mb-2 last:mb-0 text-sm text-foreground leading-relaxed">{children}</p>,
  ul: ({ children }: { children: React.ReactNode }) => <ul className="list-disc pl-4 mb-2 text-sm text-foreground">{children}</ul>,
  ol: ({ children }: { children: React.ReactNode }) => <ol className="list-decimal pl-4 mb-2 text-sm text-foreground">{children}</ol>,
  li: ({ children }: { children: React.ReactNode }) => <li className="mb-1 text-sm text-foreground">{children}</li>,
  h1: ({ children }: { children: React.ReactNode }) => <h1 className="text-base font-semibold mb-2 mt-4 text-foreground">{children}</h1>,
  h2: ({ children }: { children: React.ReactNode }) => <h2 className="text-sm font-semibold mb-1.5 mt-3 text-foreground">{children}</h2>,
  h3: ({ children }: { children: React.ReactNode }) => <h3 className="text-sm font-semibold mb-1 mt-3 text-foreground">{children}</h3>,
  strong: ({ children }: { children: React.ReactNode }) => <strong className="font-semibold text-foreground">{children}</strong>,
  code({ className, children, ref: _ref, ...props }: Record<string, unknown>) {
    const match = /language-(\w+)/.exec((className as string) ?? "");
    if (!match) {
      return (
        <code {...props} className="text-[12px] font-mono bg-muted px-1 py-0.5 rounded text-rose-600 dark:text-orange-300">
          {children as React.ReactNode}
        </code>
      );
    }
    return (
      <pre className="my-2 p-3 rounded-lg bg-muted overflow-x-auto text-xs font-mono text-foreground">
        <code>{children as React.ReactNode}</code>
      </pre>
    );
  },
  pre: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  blockquote: ({ children }: { children: React.ReactNode }) => (
    <blockquote className="border-l-2 border-border pl-3 italic mb-2 text-muted-foreground">{children}</blockquote>
  ),
  table: ({ children }: { children: React.ReactNode }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }: { children: React.ReactNode }) => <thead className="bg-muted/50 border-b border-border">{children}</thead>,
  th: ({ children }: { children: React.ReactNode }) => <th className="px-3 py-1.5 text-left font-semibold text-foreground/80">{children}</th>,
  td: ({ children }: { children: React.ReactNode }) => <td className="px-3 py-1.5 text-foreground/80 border-t border-border/50">{children}</td>,
  hr: () => <hr className="my-3 border-t border-border" />,
};

// ---------------------------------------------------------------------------
// AI Analysis modal
// ---------------------------------------------------------------------------

function AnalysisModal({
  open,
  onClose,
  title,
  verdict,
  filtered,
  reason,
  blockers,
  analysisText,
  blockKind,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  verdict: "workable" | "not_workable" | null;
  filtered: boolean;
  reason: string | null;
  blockers: string[] | null;
  analysisText: string | null;
  blockKind: FreelanceBlockKind | null;
}) {
  const [copied, setCopied] = useState(false);
  if (!open) return null;
  const isWorkable = verdict === "workable";
  const tone = verdict ? pillTone(verdict, blockKind, filtered) : "red";
  // Mirror the card pill exactly: same tone → same color family, same label.
  const MODAL_BADGE_CLASSES: Record<string, string> = {
    green: "bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/30",
    amber: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30",
    sky:   "bg-sky-500/15 text-sky-600 dark:text-sky-400 border border-sky-500/30",
    red:   "bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/30",
  };
  const MODAL_BULLET_CLASSES: Record<string, string> = {
    green: "bg-green-400",
    amber: "bg-amber-400",
    sky:   "bg-sky-400",
    red:   "bg-red-400",
  };
  const badgeClass = MODAL_BADGE_CLASSES[tone];
  const bulletClass = MODAL_BULLET_CLASSES[tone];
  const badgeLabel = verdict ? pillLabel(verdict, blockKind) : "Not Workable";

  // Assemble the analysis as a standalone Markdown document: verdict line, the
  // full AI analysis prose, then the verdict summary + blockers.
  const buildAnalysisMarkdown = (): string => {
    const lines = [`# ${title} — AI Analysis\n`, `**Verdict:** ${badgeLabel}\n`];
    if (analysisText) {
      lines.push(analysisText.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "");
    }
    if (reason) {
      lines.push("## Verdict Summary\n", reason);
      if (blockers && blockers.length > 0) {
        lines.push("");
        for (const b of blockers) lines.push(`- ${b}`);
      }
    }
    return lines.join("\n");
  };

  const hasExportableAnalysis = Boolean(analysisText || reason);

  const handleCopyAnalysis = () => {
    void navigator.clipboard.writeText(buildAnalysisMarkdown()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const handleExportAnalysis = () => {
    downloadMarkdown(`${title} - AI Analysis`, buildAnalysisMarkdown());
    toast("success", "Analysis exported as Markdown.");
  };

  // Portal to <body> so the modal escapes the listing card's DOM subtree.
  // Rendered inline, it inherited the card's `opacity-60` (closed listings),
  // colour tints, and stacking context — making the panel translucent so the
  // cards behind bled through. At the body root, `bg-card` renders fully opaque.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl max-h-[85vh] rounded-xl border bg-card shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — fixed */}
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <Sparkles className="size-4 text-violet-500 shrink-0" />
            <span className="text-sm font-semibold text-foreground">AI Analysis</span>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
                badgeClass,
              )}
            >
              {isWorkable ? <CheckCircle className="size-3.5" />
                : blockKind === "skill_gate" ? <Wrench className="size-3.5" />
                : blockKind === "non_software" ? <UserX className="size-3.5" />
                : blockKind === "client_quality" ? (
                  reason?.includes("review") ? <ThumbsDown className="size-3.5" />
                  : reason?.includes("joined") ? <Timer className="size-3.5" />
                  : reason?.includes("is from") ? <Globe className="size-3.5" />
                  : <Filter className="size-3.5" />
                ) : <Bot className="size-3.5" />}
              {badgeLabel}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {hasExportableAnalysis && (
              <>
                <Tip content={copied ? "Copied!" : "Copy analysis"} side="bottom">
                  <button
                    type="button"
                    onClick={handleCopyAnalysis}
                    className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    aria-label="Copy analysis"
                  >
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  </button>
                </Tip>
                <Tip content="Export as markdown" side="bottom">
                  <button
                    type="button"
                    onClick={handleExportAnalysis}
                    className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    aria-label="Export analysis as markdown"
                  >
                    <Download className="size-4" />
                  </button>
                </Tip>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4 min-h-0">
          {/* Full analysis text — markdown rendered */}
          {analysisText && (
            <div>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSanitize]}
                components={ANALYSIS_MD_COMPONENTS as never}
              >
                {analysisText.replace(/\r\n/g, "\n").replace(/\r/g, "\n")}
              </ReactMarkdown>
            </div>
          )}

          {/* Summary verdict line — always shown */}
          {reason && (
            <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 flex flex-col gap-2">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Verdict Summary</span>
              <p className="text-sm text-foreground leading-relaxed">{reason}</p>
              {blockers && blockers.length > 0 && (
                <ul className="mt-1 flex flex-col gap-1">
                  {blockers.map((b, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                      <span className={cn("mt-1.5 size-1.5 rounded-full shrink-0", bulletClass)} />
                      {b}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface FreelanceListingCardProps {
  listing: FreelanceListingDto;
  onApprove: () => Promise<void>;
  onDelete: () => Promise<void>;
  onShortlist?: () => Promise<void>;
  onMarkDone?: () => Promise<void>;
  onAnalyze?: () => Promise<{ verdict: "workable" | "not_workable"; reason: string; blockers: string[]; analysisText: string; filtered: boolean; blockKind: FreelanceBlockKind | null }>;
  isAnalyzing?: boolean;
  autoOpenAnalysis?: boolean;
  onAnalysisModalClose?: () => void;
  timezone?: string;
  preferredCurrency?: string;
  currencyRates?: Record<string, number>;
  autoEarnEnabled?: boolean;
  /** When true, the card shows a selection checkbox (multi-select delete mode). */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}

const DESCRIPTION_TRUNCATE_LENGTH = 200; // only used to decide whether to show "View Full Description"

// Verdict-pill color per tone (see pillTone). client_quality → sky, distinct
// from the amber skill/keyword filters; workable → green; AI fail → red.
const PILL_TONE_CLASSES: Record<PillTone, string> = {
  green: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30 hover:bg-green-500/20",
  amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/20",
  sky: "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30 hover:bg-sky-500/20",
  red: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30 hover:bg-red-500/20",
};

export function FreelanceListingCard({
  listing,
  onApprove,
  onDelete,
  onShortlist,
  onMarkDone,
  onAnalyze,
  isAnalyzing = false,
  autoOpenAnalysis = false,
  onAnalysisModalClose,
  timezone = "UTC",
  preferredCurrency = "USD",
  currencyRates = {},
  autoEarnEnabled = false,
  selectable = false,
  selected = false,
  onToggleSelect,
}: FreelanceListingCardProps) {
  const [isApproving, setIsApproving] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [isShortlisting, setIsShortlisting] = useState(false);
  const [isMarkingDone, setIsMarkingDone] = useState(false);
  const [isDrafting, setIsDrafting] = useState(false);
  const [isCheckingReqs, setIsCheckingReqs] = useState(false);
  const [requirementsQuestions, setRequirementsQuestions] = useState<BidQuestionDto[] | null>(null);

  const createProposal = useCallback(async (humanAnswers?: BidAnswerDto[]) => {
    setIsDrafting(true);
    try {
      await rpc.freelanceOutboxDraftBid(listing.id, undefined, humanAnswers);
      toast("success", "Proposal created — review it in Inbox → Drafts.");
      window.dispatchEvent(new CustomEvent("agentdesk:freelance-open-inbox"));
    } catch (err) {
      toast("error", `Create failed: ${String((err as Error)?.message ?? err)}`);
    } finally {
      setIsDrafting(false);
      setRequirementsQuestions(null);
    }
  }, [listing.id]);
  const [localAnalysis, setLocalAnalysis] = useState<{
    verdict: "workable" | "not_workable";
    reason: string;
    blockers: string[];
    analysisText: string;
    filtered: boolean;
    blockKind: FreelanceBlockKind | null;
  } | null>(null);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // Tracks whether AI is actively streaming for this listing so the modal
  // stays mounted (and its state preserved) even while chatOpen is false.
  const [chatStreaming, setChatStreaming] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [localDescription, setLocalDescription] = useState<string | null | undefined>(listing.fullDescription);
  const [refreshingDesc, setRefreshingDesc] = useState(false);

  // Sent-proposal viewer (opened from the "Bid Placed" pill). The body we sent
  // is persisted as the outbox row's final_body; fetched on demand.
  const [sentBidOpen, setSentBidOpen] = useState(false);
  const [sentBidBody, setSentBidBody] = useState<string | null>(null);
  const [sentBidSentAt, setSentBidSentAt] = useState<string | null>(null);
  const [sentBidLoading, setSentBidLoading] = useState(false);
  const [sentBidCopied, setSentBidCopied] = useState(false);

  const handleViewSentBid = useCallback(async () => {
    setSentBidOpen(true);
    setSentBidLoading(true);
    try {
      const res = await rpc.freelanceOutboxGetSentBid(listing.id);
      setSentBidBody(res.body);
      setSentBidSentAt(res.sentAt);
    } catch {
      setSentBidBody(null);
      setSentBidSentAt(null);
    } finally {
      setSentBidLoading(false);
    }
  }, [listing.id]);

  // Sync when the parent refreshes the listing (e.g. after Analyze fetches the description)
  useEffect(() => {
    setLocalDescription(listing.fullDescription);
  }, [listing.fullDescription]);

  useEffect(() => {
    const onActive = (e: Event) => {
      const detail = (e as CustomEvent<{ listingId: string }>).detail;
      if (detail.listingId === listing.id) setChatStreaming(true);
    };
    const onDone = (e: Event) => {
      const detail = (e as CustomEvent<{ listingId: string }>).detail;
      if (detail.listingId === listing.id) setChatStreaming(false);
    };
    window.addEventListener("agentdesk:freelance-chat-token", onActive);
    window.addEventListener("agentdesk:freelance-chat-fetching", onActive);
    window.addEventListener("agentdesk:freelance-chat-complete", onDone);
    window.addEventListener("agentdesk:freelance-chat-error", onDone);
    window.addEventListener("agentdesk:freelance-chat-stopped", onDone);
    return () => {
      window.removeEventListener("agentdesk:freelance-chat-token", onActive);
      window.removeEventListener("agentdesk:freelance-chat-fetching", onActive);
      window.removeEventListener("agentdesk:freelance-chat-complete", onDone);
      window.removeEventListener("agentdesk:freelance-chat-error", onDone);
      window.removeEventListener("agentdesk:freelance-chat-stopped", onDone);
    };
  }, [listing.id]);

  const analysisData = localAnalysis ?? (listing.wizardVerdict !== null ? {
    verdict: listing.wizardVerdict,
    reason: listing.wizardReason ?? "",
    blockers: listing.wizardBlockers ?? [],
    analysisText: listing.wizardAnalysisText ?? "",
    filtered: listing.wizardFiltered,
    blockKind: listing.wizardBlockKind,
  } : null);
  const hasAnalysis = Boolean(analysisData);

  // Auto-open modal when parent signals analysis just completed (survives tab navigation)
  useEffect(() => {
    if (autoOpenAnalysis && hasAnalysis && !analysisOpen) {
      setAnalysisOpen(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenAnalysis, hasAnalysis]);

  const handleApprove = async () => {
    setIsApproving(true);
    try {
      await onApprove();
    } finally {
      setIsApproving(false);
    }
  };

  const handleShortlist = async () => {
    if (!onShortlist) return;
    setIsShortlisting(true);
    try {
      await onShortlist();
    } finally {
      setIsShortlisting(false);
    }
  };

  const handleMarkDone = async () => {
    if (!onMarkDone) return;
    setIsMarkingDone(true);
    try {
      await onMarkDone();
    } finally {
      setIsMarkingDone(false);
    }
  };

  const handleAnalyze = async () => {
    if (!onAnalyze) return;
    const result = await onAnalyze();
    setLocalAnalysis(result);
    setAnalysisOpen(true);
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await onDelete();
    } finally {
      setIsDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleViewOnPlatform = () => {
    rpc.openExternalUrl(listing.url).catch(() => {});
  };

  const isTruncatable = listing.description.length > DESCRIPTION_TRUNCATE_LENGTH;

  const postedAgo = relativeTime(listing.postedAt);
  const isNew = listing.status === "new";
  const isShortlisted = listing.status === "shortlisted";
  const isClosed = listing.status === "closed";

  return (
    <div
      className={cn(
        "rounded-xl border bg-card text-card-foreground shadow-sm",
        "flex flex-col gap-3 p-4",
        "hover:border-zinc-600 transition-colors",
        listing.status === "approved" && "border-green-500/30 bg-green-500/5",
        isShortlisted && "border-indigo-500/30 bg-indigo-500/5",
        isClosed && "opacity-60",
        selected && "ring-2 ring-primary border-primary",
      )}
    >
      {/* Header row: badges + posted time (left) | chat + analysis (right) */}
      <div className="-mx-4 px-4 pb-3 border-b border-border flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          {selectable && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              aria-label={selected ? "Deselect listing" : "Select listing"}
              className="size-4 shrink-0 cursor-pointer accent-primary"
            />
          )}
          <PlatformBadge platform={listing.platform} />
          {isShortlisted && (
            <span className="inline-flex items-center rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-xs font-semibold text-indigo-500">
              Shortlisted
            </span>
          )}
          {isClosed && (
            <span className="inline-flex items-center rounded-md border border-zinc-500/30 bg-zinc-500/10 px-2 py-0.5 text-xs font-semibold text-zinc-500">
              Done
            </span>
          )}
          {postedAgo && listing.postedAt && (
            <Tip content={`Posted: ${formatFullDate(listing.postedAt, timezone)}`} side="top">
              <span className="text-xs text-muted-foreground">{postedAgo}</span>
            </Tip>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {!isClosed && listing.status !== "approved" && (
            <button
              type="button"
              onClick={() => setChatOpen(true)}
              aria-label="Open listing chat"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-violet-500/15 text-violet-500 border border-violet-500/30 hover:bg-violet-500/25 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MessageSquare className="size-3.5" />
              Chat
            </button>
          )}
          {analysisData && (
            <Tip
              content={
                analysisData.verdict !== "workable" && analysisData.reason
                  ? analysisData.reason
                  : "View AI analysis"
              }
              side="top"
            >
              <button
                type="button"
                onClick={() => setAnalysisOpen(true)}
                aria-label="View AI analysis"
                className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                PILL_TONE_CLASSES[pillTone(analysisData.verdict, analysisData.blockKind, analysisData.filtered)],
              )}
            >
              {analysisData.verdict === "workable" ? (
                <CheckCircle className="size-3.5" />
              ) : analysisData.blockKind === "skill_gate" ? (
                <Wrench className="size-3.5" />
              ) : analysisData.blockKind === "non_software" ? (
                <UserX className="size-3.5" />
              ) : analysisData.blockKind === "client_quality" ? (
                analysisData.reason.includes("review") ? <ThumbsDown className="size-3.5" />
                : analysisData.reason.includes("joined") ? <Timer className="size-3.5" />
                : analysisData.reason.includes("is from") ? <Globe className="size-3.5" />
                : <Filter className="size-3.5" />
              ) : (
                <Bot className="size-3.5" />
              )}
              {pillLabel(analysisData.verdict, analysisData.blockKind)}
              </button>
            </Tip>
          )}
        </div>
      </div>

      {/* Title + description (left) | country + budget (right) */}
      {(() => {
        const budget = buildBudgetDisplay(listing, preferredCurrency, currencyRates);
        return (
          <div className="flex items-stretch justify-between gap-3">
            {/* Left: title + description stacked */}
            <div className="flex flex-col gap-4 min-w-0">
              <h3 className="text-sm font-semibold text-foreground leading-snug">
                {listing.title}
              </h3>
              {listing.description && (
                <div className="text-sm text-foreground leading-relaxed">
                  <span>{listing.description}</span>
                  {isTruncatable && listing.fullDescription && (
                    <button
                      type="button"
                      onClick={() => setDescriptionOpen(true)}
                      className="ml-1.5 text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
                    >
                      View Full Description
                    </button>
                  )}
                </div>
              )}
              {/* Skills */}
              {listing.skills.length > 0 && <SkillChips skills={listing.skills} />}
            </div>
            <div className="w-px self-stretch bg-border shrink-0" />
            {/* Right: country + client info + budget stacked */}
            <div className="flex flex-col items-end justify-center gap-1.5 shrink-0">
              {listing.clientCountry && (
                <Tip content={`Client is from ${listing.clientCountry}`} side="top">
                  <span className="flex items-center gap-1 text-base font-semibold text-foreground/70 cursor-default">
                    <MapPin className="size-3 shrink-0" />
                    {listing.clientCountry}
                  </span>
                </Tip>
              )}
              {(listing.clientReviewCount !== null || listing.clientPaymentVerified) && (
                <div className="flex items-center gap-2 text-xs font-semibold text-foreground/70">
                  {listing.clientReviewCount !== null && (
                    <Tip
                      content={
                        listing.clientReviewCount === 0
                          ? "Client has no reviews yet"
                          : listing.clientRating !== null && listing.clientRating > 0
                            ? `${listing.clientRating.toFixed(1)} avg rating across ${listing.clientReviewCount} review${listing.clientReviewCount !== 1 ? "s" : ""}`
                            : `${listing.clientReviewCount} review${listing.clientReviewCount !== 1 ? "s" : ""}`
                      }
                      side="top"
                    >
                      <span className="flex items-center gap-1 cursor-default">
                        {listing.clientRating !== null && listing.clientRating > 0 ? (
                          <>
                            <Star className="size-3 fill-amber-400 text-amber-400 shrink-0" />
                            {listing.clientRating.toFixed(1)}
                            <span className="text-foreground/70">({listing.clientReviewCount})</span>
                          </>
                        ) : (
                          <>
                            <Star className="size-3 text-foreground/50 shrink-0" />
                            {listing.clientReviewCount} reviews
                          </>
                        )}
                      </span>
                    </Tip>
                  )}
                  {listing.clientPaymentVerified && (
                    <Tip content="Payment method verified by Freelancer.com" side="top">
                      <span className="flex items-center gap-0.5 text-green-600 dark:text-green-400 cursor-default">
                        <ShieldCheck className="size-3 shrink-0" />
                      </span>
                    </Tip>
                  )}
                </div>
              )}
              <span className="text-sm font-semibold text-foreground tabular-nums">
                {budget.primary}
              </span>
              {budget.converted && (
                budget.tooltipRate ? (
                  <Tip content={budget.tooltipRate} side="top">
                    <span className="text-sm font-semibold text-blue-900 dark:text-blue-300 tabular-nums cursor-default">
                      ({budget.converted})
                    </span>
                  </Tip>
                ) : (
                  <span className="text-sm font-semibold text-blue-900 dark:text-blue-300 tabular-nums cursor-default">
                    ({budget.converted})
                  </span>
                )
              )}
            </div>
          </div>
        );
      })()}

      {/* Actions */}
      <div className="-mx-4 px-4 pt-3 border-t border-border flex items-center gap-2">
        {/* Analyze — visible for listings not yet AI-analyzed (pre-filters don't count) */}
        {(isNew || isShortlisted) && !(listing.wizardVerdict === "workable" || listing.wizardBlockKind === "analysis") && onAnalyze && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleAnalyze()}
            disabled={isAnalyzing}
            className="gap-1.5"
            aria-label="Analyze listing workability"
          >
            {isAnalyzing ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            {isAnalyzing ? "Analyzing…" : "Analyze"}
          </Button>
        )}

        {/* Shortlist — visible for new listings only */}
        {(isNew) && onShortlist && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleShortlist()}
            disabled={isShortlisting}
            className="gap-1.5"
            aria-label="Shortlist listing"
          >
            {isShortlisting ? <Loader2 className="size-3.5 animate-spin" /> : <Bookmark className="size-3.5" />}
            {isShortlisting ? "Shortlisting…" : "Shortlist"}
          </Button>
        )}

        {/* Create Proposal (bid) — Auto-Earn only, shortlisted listings only: queue an AI proposal */}
        {autoEarnEnabled && isShortlisted && !isClosed && (
          listing.hasBid ? (
            <Tip content="View the proposal you sent" side="top">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleViewSentBid()}
                className="gap-1.5 text-green-600 dark:text-green-400 border-green-500/40 hover:bg-green-500/10 hover:text-green-700 dark:hover:text-green-300"
                aria-label="View the proposal you sent"
              >
                <CheckCircle2 className="size-3.5" />
                Bid Placed
              </Button>
            </Tip>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={isDrafting || isCheckingReqs}
                onClick={async () => {
                  setIsCheckingReqs(true);
                  try {
                    const result = await rpc.freelanceAnalyzeBidRequirements(listing.id);
                    const humanNeeded = result.questions.filter((q) => !q.canAiAnswer);
                    if (humanNeeded.length > 0) {
                      setRequirementsQuestions(result.questions);
                    } else {
                      await createProposal(result.questions.length > 0
                        ? result.questions.map((q) => ({ question: q.question, answer: q.aiAnswer ?? "" })).filter((a) => a.answer)
                        : undefined);
                    }
                  } catch {
                    await createProposal();
                  } finally {
                    setIsCheckingReqs(false);
                  }
                }}
                className="gap-1.5"
                aria-label="Create Proposal for listing"
              >
                {(isDrafting || isCheckingReqs) ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                {isDrafting ? "Creating…" : isCheckingReqs ? "Analyzing…" : "Create Proposal"}
              </Button>
              {requirementsQuestions && (
                <BidRequirementsModal
                  listingTitle={listing.title}
                  questions={requirementsQuestions}
                  generating={isDrafting}
                  onGenerate={(answers) => { void createProposal(answers); }}
                  onCancel={() => setRequirementsQuestions(null)}
                />
              )}
            </>
          )
        )}

        {(isNew || isShortlisted) && !isClosed && (
          <Button
            size="sm"
            onClick={() => setConfirmApprove(true)}
            disabled={isApproving}
            className="gap-1.5"
            aria-label="Approve listing"
          >
            {isApproving && <Loader2 className="size-3.5 animate-spin" />}
            {isApproving ? "Approving…" : "Approve"}
          </Button>
        )}

        {/* Mark Done — visible for all non-closed listings */}
        {!isClosed && onMarkDone && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleMarkDone()}
            disabled={isMarkingDone}
            className="gap-1.5 text-zinc-600 hover:text-zinc-800"
            aria-label="Mark listing as done"
          >
            {isMarkingDone ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
            {isMarkingDone ? "Marking…" : "Mark Done"}
          </Button>
        )}

        {/* Delete with inline confirmation */}
        {confirmDelete ? (
          <>
            <span className="text-xs text-muted-foreground">Delete this listing?</span>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
              className="gap-1.5"
              aria-label="Confirm delete"
            >
              {isDeleting && <Loader2 className="size-3.5 animate-spin" />}
              {isDeleting ? "Deleting…" : "Delete"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmDelete(false)}
              disabled={isDeleting}
              aria-label="Cancel delete"
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirmDelete(true)}
            disabled={false}
            className="gap-1.5 text-destructive hover:text-destructive hover:bg-destructive/10"
            aria-label="Delete listing"
          >
            <Trash2 className="size-3.5" />
            Delete
          </Button>
        )}

        <Button
          size="sm"
          variant="link"
          onClick={handleViewOnPlatform}
          className="ml-auto gap-1.5 text-blue-500 dark:text-blue-400 hover:underline"
          aria-label="View listing on platform"
        >
          View on Platform
          <ExternalLink className="size-3.5" />
        </Button>
      </div>

      {/* Approve confirmation dialog */}
      <Dialog open={confirmApprove} onOpenChange={setConfirmApprove}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Has the client approved your bid?</DialogTitle>
            <DialogDescription className="pt-1 text-foreground">
              Only approve <span className="font-medium">"{listing.title}"</span> once the
              client has awarded you the project on Freelancer.com. This will create a new
              AgentDesk project and start the agent workflow.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-2">
            <Button
              variant="outline"
              onClick={() => setConfirmApprove(false)}
              disabled={isApproving}
            >
              No
            </Button>
            <Button
              onClick={async () => {
                setConfirmApprove(false);
                await handleApprove();
              }}
              disabled={isApproving}
              className="gap-1.5"
            >
              {isApproving && <Loader2 className="size-3.5 animate-spin" />}
              {isApproving ? "Approving…" : "Yes, proceed"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Chat modal — stays mounted while chatOpen OR while AI is streaming
          so state (isSending, streaming content) survives close+reopen */}
      {(chatOpen || chatStreaming) && (
        <FreelanceChatModal
          listing={listing}
          open={chatOpen}
          onClose={() => setChatOpen(false)}
        />
      )}

      {/* AI Analysis modal */}
      {analysisData && (
        <AnalysisModal
          open={analysisOpen}
          onClose={() => {
            setAnalysisOpen(false);
            onAnalysisModalClose?.();
          }}
          title={listing.title}
          verdict={analysisData.verdict}
          filtered={analysisData.filtered}
          reason={analysisData.reason}
          blockers={analysisData.blockers}
          analysisText={analysisData.analysisText}
          blockKind={analysisData.blockKind}
        />
      )}

      {/* Full description modal */}
      <Dialog open={descriptionOpen} onOpenChange={setDescriptionOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <div className="flex items-start justify-between gap-2 pr-6">
              <div>
                <DialogTitle className="text-sm font-semibold leading-snug">
                  {listing.title}
                </DialogTitle>
                <p className="text-xs text-muted-foreground mt-0.5">Full project description</p>
              </div>
              <Tip content="Re-fetch description" side="left">
                <button
                  type="button"
                  onClick={async () => {
                    setRefreshingDesc(true);
                    try {
                      const result = await rpc.freelanceRefreshListingDescription(listing.id);
                      setLocalDescription(result.description);
                    } catch { /* ignore */ } finally {
                      setRefreshingDesc(false);
                    }
                  }}
                  disabled={refreshingDesc}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-50 transition-colors"
                >
                  <RefreshCw className={`size-3.5 ${refreshingDesc ? "animate-spin" : ""}`} />
                </button>
              </Tip>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto min-h-0 mt-1 prose-sm prose-neutral dark:prose-invert max-w-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSanitize]}
              components={ANALYSIS_MD_COMPONENTS as never}
            >
              {(localDescription ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")}
            </ReactMarkdown>
          </div>
        </DialogContent>
      </Dialog>

      {/* Sent-proposal modal — read-only view of the bid we actually submitted */}
      <Dialog open={sentBidOpen} onOpenChange={setSentBidOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <div className="flex items-start justify-between gap-2 pr-6">
              <div>
                <DialogTitle className="text-sm font-semibold leading-snug flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-green-600 dark:text-green-400 shrink-0" />
                  Proposal sent
                </DialogTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {sentBidSentAt
                    ? `Sent ${formatFullDate(sentBidSentAt, timezone)}`
                    : "The proposal you submitted for this project"}
                </p>
              </div>
              {sentBidBody && (
                <Tip content={sentBidCopied ? "Copied!" : "Copy proposal"} side="left">
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(sentBidBody).then(() => {
                        setSentBidCopied(true);
                        setTimeout(() => setSentBidCopied(false), 1500);
                      });
                    }}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                    aria-label="Copy proposal"
                  >
                    {sentBidCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  </button>
                </Tip>
              )}
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto min-h-0 mt-1">
            {sentBidLoading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : sentBidBody ? (
              <div className="whitespace-pre-wrap break-words text-sm text-foreground leading-relaxed">
                {sentBidBody}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-6 text-center">
                The sent proposal couldn't be found — it may have been cleared.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
