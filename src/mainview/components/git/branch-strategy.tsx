import { useState, useEffect } from "react";
import { GitBranch, Trash2, RefreshCw } from "lucide-react";
import { rpc } from "../../lib/rpc";

interface BranchStrategyProps {
  projectId: string;
  onRefresh?: () => void;
}

type Strategy = Awaited<ReturnType<typeof rpc.getBranchStrategy>>;

const MODELS = [
  { value: "github-flow", label: "GitHub Flow", desc: "Simple: main + short-lived feature branches" },
  { value: "gitflow", label: "Git Flow", desc: "Full: main, develop, feature, release, hotfix" },
  { value: "trunk", label: "Trunk-based", desc: "All commits directly to main; feature flags" },
];

export function BranchStrategy({ projectId, onRefresh }: BranchStrategyProps) {
  const [_strategy, setStrategy] = useState<Strategy>(null);
  const [saving, setSaving] = useState(false);
  const [mergedBranches, setMergedBranches] = useState<string[]>([]);
  const [cleaning, setCleaning] = useState(false);
  const [loadingMerged, setLoadingMerged] = useState(false);

  // Local editable copies
  const [model, setModel] = useState("github-flow");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [featurePrefix, setFeaturePrefix] = useState("feature/");
  const [releasePrefix, setReleasePrefix] = useState("release/");
  const [hotfixPrefix, setHotfixPrefix] = useState("hotfix/");
  const [namingTemplate, setNamingTemplate] = useState("feature/{task-id}-{slug}");
  const [protectedBranches, setProtectedBranches] = useState("main,master");
  const [autoCleanup, setAutoCleanup] = useState(false);

  useEffect(() => {
    rpc.getBranchStrategy(projectId).then((s) => {
      if (s) {
        setStrategy(s);
        setModel(s.model);
        setDefaultBranch(s.defaultBranch);
        setFeaturePrefix(s.featureBranchPrefix);
        setReleasePrefix(s.releaseBranchPrefix);
        setHotfixPrefix(s.hotfixBranchPrefix);
        setNamingTemplate(s.namingTemplate);
        setProtectedBranches(s.protectedBranches.join(","));
        setAutoCleanup(s.autoCleanup);
      }
    }).catch(() => {});
  }, [projectId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await rpc.saveBranchStrategy({
        projectId,
        model,
        defaultBranch,
        featureBranchPrefix: featurePrefix,
        releaseBranchPrefix: releasePrefix,
        hotfixBranchPrefix: hotfixPrefix,
        namingTemplate,
        protectedBranches: protectedBranches.split(",").map((s) => s.trim()).filter(Boolean),
        autoCleanup,
      });
    } finally {
      setSaving(false);
    }
  };

  const loadMergedBranches = async () => {
    setLoadingMerged(true);
    try {
      const res = await rpc.getMergedBranches(projectId);
      setMergedBranches(res.branches);
    } finally {
      setLoadingMerged(false);
    }
  };

  const handleCleanup = async () => {
    setCleaning(true);
    try {
      await rpc.cleanupMergedBranches(projectId);
      setMergedBranches([]);
      onRefresh?.();
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Branching model */}
      <div>
        <label className="text-xs text-muted-foreground block mb-2">Branching model</label>
        <div className="grid gap-2">
          {MODELS.map((m) => (
            <label
              key={m.value}
              className={`flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                model === m.value ? "border-primary bg-primary/5" : "hover:bg-muted/30"
              }`}
            >
              <input
                type="radio"
                name="branch-model"
                value={m.value}
                checked={model === m.value}
                onChange={() => setModel(m.value)}
                className="mt-0.5"
              />
              <div>
                <p className="text-sm font-medium">{m.label}</p>
                <p className="text-xs text-muted-foreground">{m.desc}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Branch prefixes */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Default branch</label>
          <input
            type="text"
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            className="w-full text-sm px-2 py-1.5 rounded border bg-background"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Feature prefix</label>
          <input
            type="text"
            value={featurePrefix}
            onChange={(e) => setFeaturePrefix(e.target.value)}
            className="w-full text-sm px-2 py-1.5 rounded border bg-background"
          />
        </div>
        {model === "gitflow" && (
          <>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Release prefix</label>
              <input
                type="text"
                value={releasePrefix}
                onChange={(e) => setReleasePrefix(e.target.value)}
                className="w-full text-sm px-2 py-1.5 rounded border bg-background"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Hotfix prefix</label>
              <input
                type="text"
                value={hotfixPrefix}
                onChange={(e) => setHotfixPrefix(e.target.value)}
                className="w-full text-sm px-2 py-1.5 rounded border bg-background"
              />
            </div>
          </>
        )}
      </div>

      {/* Naming template */}
      <div>
        <label className="text-xs text-muted-foreground block mb-1">
          Branch naming template
        </label>
        <input
          type="text"
          value={namingTemplate}
          onChange={(e) => setNamingTemplate(e.target.value)}
          className="w-full text-sm px-2 py-1.5 rounded border bg-background font-mono"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Variables: <code className="bg-muted px-1 rounded">{"{task-id}"}</code>{" "}
          <code className="bg-muted px-1 rounded">{"{slug}"}</code>{" "}
          <code className="bg-muted px-1 rounded">{"{prefix}"}</code>
        </p>
      </div>

      {/* Protected branches */}
      <div>
        <label className="text-xs text-muted-foreground block mb-1">Protected branches (comma-separated)</label>
        <input
          type="text"
          value={protectedBranches}
          onChange={(e) => setProtectedBranches(e.target.value)}
          placeholder="main,master,develop"
          className="w-full text-sm px-2 py-1.5 rounded border bg-background"
        />
      </div>

      {/* Auto cleanup */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={autoCleanup}
          onChange={(e) => setAutoCleanup(e.target.checked)}
          className="w-4 h-4"
        />
        <span className="text-sm">Auto-delete merged branches</span>
      </label>

      {/* Save */}
      <button
        onClick={handleSave}
        disabled={saving}
        className="px-3 py-1.5 rounded bg-primary text-primary-foreground text-sm disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save strategy"}
      </button>

      {/* Merged branches cleanup */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Merged branches
          </span>
          <button
            onClick={loadMergedBranches}
            disabled={loadingMerged}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${loadingMerged ? "animate-spin" : ""}`} />
            Scan
          </button>
        </div>

        {mergedBranches.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {mergedBranches.map((b) => (
                <span key={b} className="text-xs bg-muted px-2 py-0.5 rounded font-mono flex items-center gap-1">
                  <GitBranch className="w-3 h-3" />
                  {b}
                </span>
              ))}
            </div>
            <button
              onClick={handleCleanup}
              disabled={cleaning}
              className="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded border border-red-500/30 text-red-700 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50"
            >
              <Trash2 className="w-3 h-3" />
              {cleaning ? "Deleting…" : `Delete ${mergedBranches.length} merged branches`}
            </button>
          </div>
        )}

        {mergedBranches.length === 0 && !loadingMerged && (
          <p className="text-xs text-muted-foreground">Click Scan to find merged branches that can be cleaned up.</p>
        )}
      </div>
    </div>
  );
}
