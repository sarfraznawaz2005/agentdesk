import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ChevronDown, Search, Brain, Cpu, Check, ShieldCheck, Hammer, Eye } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Tip, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";
import { ContextIndicator } from "./context-indicator";
import type { Message } from "@/stores/chat-store";

interface ProviderModels {
  providerId: string;
  providerName: string;
  providerType: string;
  models: string[];
}

const THINKING_LEVELS = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;

interface ModelSelectorProps {
  projectId: string;
  messages: Message[];
}

export function ModelSelector({ projectId, messages }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderModels[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [selectedThinking, setSelectedThinking] = useState<string>("");
  const [shellApproval, setShellApproval] = useState<boolean>(true);
  const [planMode, setPlanMode] = useState<boolean>(false);
  const [defaultModelName, setDefaultModelName] = useState<string>("");
  const searchRef = useRef<HTMLInputElement>(null);
  const hasFetched = useRef(false);

  // Load saved selection from project settings + resolve default model name
  useEffect(() => {
    Promise.all([
      rpc.getProjectSettings(projectId),
      rpc.getProviders(),
    ]).then(([settings, providersList]) => {
      const s = settings as Record<string, string>;
      const pid = s.chatProviderId ?? "";
      const mid = s.chatModelId ?? "";
      const tl = s.chatThinkingLevel ?? "";
      const sam = s.shellApprovalMode ?? "ask";
      setShellApproval(sam === "ask");
      setPlanMode(s.planMode === "true");
      // Resolve the default provider's model name
      const defaultProv = providersList.find((p) => p.isDefault) ?? providersList[0];
      const defaultModel = defaultProv?.defaultModel ?? defaultProv?.providerType ?? "";

      // If user hasn't made a selection, use the default provider/model
      setSelectedProviderId(pid || defaultProv?.id || "");
      setSelectedModelId(mid || defaultModel);
      setSelectedThinking(tl);
      setDefaultModelName(defaultModel);
    }).catch(() => {});
  }, [projectId]);

  // Fetch models when popover opens for the first time
  const fetchModels = useCallback(async () => {
    if (hasFetched.current) return;
    setLoading(true);
    try {
      const result = await rpc.getConnectedProviderModels();
      setProviders(result);
      hasFetched.current = true;
    } catch {
      // Failed to fetch — show empty
    }
    setLoading(false);
  }, []);

  const handleOpenChange = useCallback((isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) {
      fetchModels();
      setTimeout(() => searchRef.current?.focus(), 100);
    } else {
      setSearch("");
    }
  }, [fetchModels]);

  const selectModel = useCallback(async (providerId: string, modelId: string) => {
    setSelectedProviderId(providerId);
    setSelectedModelId(modelId);
    setOpen(false);
    // Persist
    await Promise.all([
      rpc.saveProjectSetting(projectId, "chatProviderId", providerId),
      rpc.saveProjectSetting(projectId, "chatModelId", modelId),
    ]).catch(() => {});
  }, [projectId]);

  const selectThinking = useCallback(async (level: string) => {
    setSelectedThinking(level);
    setThinkingOpen(false);
    await rpc.saveProjectSetting(projectId, "chatThinkingLevel", level).catch(() => {});
  }, [projectId]);

  const toggleShellApproval = useCallback(async () => {
    const next = !shellApproval;
    setShellApproval(next);
    await rpc.saveProjectSetting(projectId, "shellApprovalMode", next ? "ask" : "auto").catch(() => {});
  }, [projectId, shellApproval]);

  const togglePlanMode = useCallback(async () => {
    const next = !planMode;
    setPlanMode(next);
    await rpc.saveProjectSetting(projectId, "planMode", String(next)).catch(() => {});
  }, [projectId, planMode]);

  // Display label for selected model
  const displayLabel = useMemo(() => {
    if (!selectedModelId) return defaultModelName || "Loading...";
    // Find provider name for context
    const prov = providers.find((p) => p.providerId === selectedProviderId);
    if (prov) {
      // Shorten model name: remove provider prefix if present
      return selectedModelId.replace(`${prov.providerType}/`, "");
    }
    return selectedModelId;
  }, [selectedModelId, selectedProviderId, providers, defaultModelName]);

  const thinkingLabel = useMemo(() => {
    if (!selectedThinking) return "Default";
    return THINKING_LEVELS.find((t) => t.value === selectedThinking)?.label ?? "Default";
  }, [selectedThinking]);

  // Filter providers/models by search
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return providers;
    return providers
      .map((p) => ({
        ...p,
        models: p.models.filter((m) => m.toLowerCase().includes(q) || p.providerName.toLowerCase().includes(q)),
      }))
      .filter((p) => p.models.length > 0 || p.providerName.toLowerCase().includes(q));
  }, [providers, search]);

  return (
    <div className="flex flex-wrap items-center gap-2 gap-y-2 px-4 pb-1.5">
      {/* Build / Plan mode toggle */}
      <Tip content={planMode ? "Plan Mode: read-only planning. Agents propose, useful for complex tasks." : "Build Mode: agents can write files and execute."} side="top">
        <button
          type="button"
          onClick={togglePlanMode}
          className={cn(
            "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors",
            "border border-transparent",
            planMode
              ? "text-violet-700 bg-violet-50 border-violet-200 hover:bg-violet-100"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
        >
          {planMode
            ? <Eye className="w-3.5 h-3.5 text-violet-500" />
            : <Hammer className="w-3.5 h-3.5 text-muted-foreground/60" />}
          <span>{planMode ? "Plan" : "Build"}</span>
        </button>
      </Tip>

      {/* Model selector */}
      <Popover open={open} onOpenChange={handleOpenChange}>
        <Tooltip delayDuration={300}>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs",
                  "text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
                  "border border-transparent hover:border-border",
                  open && "bg-muted border-border text-foreground",
                )}
              >
                <Cpu className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
                <span className="max-w-[40vw] sm:max-w-[200px] truncate">{displayLabel}</span>
                <ChevronDown className="w-3 h-3 text-muted-foreground/60" />
              </button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent side="top">Choose Model</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={4}
          className="w-[320px] p-0 max-h-[400px] flex flex-col"
        >
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
            <Search className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models..."
              className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground/60"
            />
          </div>

          {/* Model list */}
          <div className="overflow-y-auto flex-1 py-1">
            {loading && (
              <div className="px-3 py-4 text-xs text-muted-foreground/60 text-center">
                Loading models...
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground/60 text-center">
                No providers configured
              </div>
            )}
            {!loading && filtered.map((provider, idx) => (
              <div key={provider.providerId}>
                {/* Provider separator + header */}
                {idx > 0 && <hr className="border-t border-border my-1" />}
                <div className="px-3 py-1.5 text-xs font-bold text-indigo-600 uppercase tracking-wider">
                  {provider.providerName}
                </div>
                {provider.models.length === 0 ? (
                  <div className="px-3 py-1.5 text-xs text-muted-foreground/60 italic">
                    No Models Found
                  </div>
                ) : (
                  provider.models.map((model) => {
                    const isSelected = selectedModelId === model;
                    return (
                      <button
                        key={`${provider.providerId}-${model}`}
                        type="button"
                        onClick={() => selectModel(provider.providerId, model)}
                        className={cn(
                          "w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors",
                          isSelected && "bg-indigo-50 text-indigo-700 font-medium",
                        )}
                      >
                        <span>{model}</span>
                        {isSelected && <Check className="w-3.5 h-3.5 text-indigo-600 shrink-0" />}
                      </button>
                    );
                  })
                )}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* Thinking level selector */}
      <Popover open={thinkingOpen} onOpenChange={setThinkingOpen}>
        <Tooltip delayDuration={300}>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs",
                  "text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
                  "border border-transparent hover:border-border",
                  thinkingOpen && "bg-muted border-border text-foreground",
                )}
              >
                <Brain className="w-3.5 h-3.5 text-muted-foreground/60" />
                <span>{thinkingLabel}</span>
                <ChevronDown className="w-3 h-3 text-muted-foreground/60" />
              </button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent side="top">Choose Thinking Level</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={4}
          className="w-[140px] p-1"
        >
          {THINKING_LEVELS.map((level) => (
            <button
              key={level.value}
              type="button"
              onClick={() => selectThinking(level.value)}
              className={cn(
                "w-full text-left px-2.5 py-1.5 text-xs rounded-md hover:bg-muted/50 transition-colors",
                selectedThinking === level.value && "bg-indigo-50 text-indigo-700 font-medium",
              )}
            >
              {level.label}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {/* Shell approval toggle */}
      <Tip content={shellApproval ? "Shell commands require approval" : "Shell commands auto-approved"} side="top">
        <button
          type="button"
          onClick={toggleShellApproval}
          className={cn(
            "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors",
            "border border-transparent",
            shellApproval
              ? "text-emerald-700 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-950/30"
              : "text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-950/30",
          )}
        >
          <ShieldCheck className={cn("w-3.5 h-3.5", shellApproval ? "text-emerald-600" : "text-red-600")} />
          <span>{shellApproval ? "Shell: Ask" : "Shell: Auto"}</span>
        </button>
      </Tip>

      {/* Context usage — pushed to far right */}
      {messages?.length > 0 && (
        <div className="ml-auto">
          <ContextIndicator messages={messages} projectId={projectId} variant="inline" />
        </div>
      )}
    </div>
  );
}
