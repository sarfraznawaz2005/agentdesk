import { useState, useEffect, useCallback, useMemo } from "react";
import { Sparkles, RefreshCw, FolderOpen, Pencil, Info, Wrench, AlertTriangle, Trash2, Package, Search } from "lucide-react";
import { useHeaderActions } from "@/lib/header-context";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { SkillsSearchChatModal } from "@/components/skills/skills-search-chat-modal";

interface SkillValidationError {
  field: string;
  message: string;
}

interface SkillSummary {
  name: string;
  description: string;
  preferredAgent: string | null;
  allowedTools: string[];
  argumentHint: string | null;
  supportingFileCount: number;
  errors: SkillValidationError[];
  isBundled: boolean;
}

interface SkillDetail extends SkillSummary {
  content: string;
  supportingFiles: string[];
  dirPath: string;
}

interface ToolDef {
  name: string;
  category: string;
  description: string;
}

function ToolsReferenceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tools, setTools] = useState<ToolDef[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (tools.length > 0) return;
    setLoading(true); // eslint-disable-line react-hooks/set-state-in-effect
    rpc.getAvailableTools()
      .then((result) => setTools(result))
      .catch(() => toast("error", "Failed to load tools"))
      .finally(() => setLoading(false));
  }, [open, tools.length]);

  const grouped = useMemo(() => {
    const map = new Map<string, ToolDef[]>();
    for (const t of tools) {
      const list = map.get(t.category) ?? [];
      list.push(t);
      map.set(t.category, list);
    }
    return map;
  }, [tools]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-5xl max-h-[70vh] flex flex-col">
        <DialogHeader className="flex-row items-center gap-2 space-y-0">
          <Wrench className="h-4 w-4 text-muted-foreground" />
          <DialogTitle className="text-base">Available Tools Reference</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground -mt-1">Use these names in the <code className="px-1 py-0.5 rounded bg-muted font-mono">allowed-tools</code> field of your SKILL.md frontmatter.</p>
        <div className="flex-1 overflow-y-auto border-t pt-3 mt-1">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : (
            Array.from(grouped.entries()).map(([category, categoryTools]) => (
              <div key={category} className="mb-3 last:mb-0">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">{category}</h4>
                <div className="grid gap-1">
                  {categoryTools.map((t) => (
                    <div key={t.name} className="flex items-baseline gap-2 text-sm leading-relaxed">
                      <code className="text-indigo-600 dark:text-indigo-400 font-mono shrink-0">{t.name}</code>
                      <span className="text-muted-foreground truncate">{t.description.slice(0, 100)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SkillCard({ skill, onEdit, onClick, onViewErrors, onDelete }: {
  skill: SkillSummary;
  onEdit: (name: string) => void;
  onClick: () => void;
  onViewErrors: (skill: SkillSummary) => void;
  onDelete: (skill: SkillSummary) => void;
}) {
  const hasErrors = skill.errors.length > 0;

  return (
    <div
      className={`border-2 rounded-lg bg-card h-full flex flex-col cursor-pointer overflow-hidden transition-all hover:border-primary/40 ${
        hasErrors ? "border-red-400 dark:border-red-600" : ""
      }`}
      onClick={onClick}
    >
      {/* Header — matches project card style */}
      <div className={`border-b px-4 py-1.5 flex items-center gap-2 ${
        hasErrors ? "bg-red-50 dark:bg-red-950/30" : "bg-muted/50"
      }`}>
        {hasErrors && <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
        <h3 className="text-sm font-semibold leading-snug flex-1 min-w-0 line-clamp-1">{skill.name}</h3>
        {skill.isBundled && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground shrink-0">
            <Package className="h-2.5 w-2.5" />
            Bundled
          </span>
        )}
        {skill.preferredAgent && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-purple-100 text-purple-800 shrink-0">
            {skill.preferredAgent}
          </span>
        )}
        <div className="-mr-2 shrink-0 flex items-center" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => onEdit(skill.name)}
            title="Edit in default editor"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          {!skill.isBundled && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-red-500"
              onClick={() => onDelete(skill)}
              title="Delete skill"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
      {/* Body */}
      <div className="px-4 py-3 flex-1 flex flex-col">
        <p className="text-xs text-gray-600 dark:text-gray-400 line-clamp-2">{skill.description || "(no description)"}</p>
        {hasErrors && (
          <button
            type="button"
            className="mt-2 text-xs text-red-600 dark:text-red-400 font-medium hover:underline self-start"
            onClick={(e) => { e.stopPropagation(); onViewErrors(skill); }}
          >
            View {skill.errors.length} Error{skill.errors.length !== 1 ? "s" : ""}
          </button>
        )}
      </div>
    </div>
  );
}

const SKILL_MD_COMPONENTS = {
   
  code({ className, children, ref: _ref, ...props }: Record<string, unknown>) {
    const match = /language-(\w+)/.exec((className as string) ?? "");
    const isInline = !match;
    if (isInline) {
      return (
        <code className="px-1.5 py-0.5 rounded text-xs font-mono bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200" {...props}>
          {children as React.ReactNode}
        </code>
      );
    }
    return (
      <pre className="bg-gray-50 dark:bg-gray-800 border rounded-lg p-3 overflow-x-auto mb-3 text-xs">
        <code className="font-mono text-gray-800 dark:text-gray-200">{children as React.ReactNode}</code>
      </pre>
    );
  },
  p: ({ children }: { children: React.ReactNode }) => <p className="mb-2 last:mb-0 text-sm text-gray-700 dark:text-gray-300 leading-relaxed">{children}</p>,
  ul: ({ children }: { children: React.ReactNode }) => <ul className="list-disc pl-5 mb-2 text-sm text-gray-700 dark:text-gray-300">{children}</ul>,
  ol: ({ children }: { children: React.ReactNode }) => <ol className="list-decimal pl-5 mb-2 text-sm text-gray-700 dark:text-gray-300">{children}</ol>,
  li: ({ children }: { children: React.ReactNode }) => <li className="mb-1">{children}</li>,
  h1: ({ children }: { children: React.ReactNode }) => <h1 className="text-base font-bold mb-2 mt-4 first:mt-0 text-gray-900 dark:text-gray-100">{children}</h1>,
  h2: ({ children }: { children: React.ReactNode }) => <h2 className="text-sm font-bold mb-2 mt-3 first:mt-0 text-gray-900 dark:text-gray-100">{children}</h2>,
  h3: ({ children }: { children: React.ReactNode }) => <h3 className="text-sm font-semibold mb-1 mt-2 first:mt-0 text-gray-900 dark:text-gray-100">{children}</h3>,
  blockquote: ({ children }: { children: React.ReactNode }) => (
    <blockquote className="border-l-2 border-gray-300 dark:border-gray-600 pl-3 italic mb-2 text-gray-600 dark:text-gray-400">{children}</blockquote>
  ),
  strong: ({ children }: { children: React.ReactNode }) => <strong className="font-semibold text-gray-900 dark:text-gray-100">{children}</strong>,
  hr: () => <hr className="my-3 border-gray-200 dark:border-gray-700" />,
};

function SkillDetailDialog({ skill, open, onClose }: {
  skill: SkillSummary | null;
  open: boolean;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !skill) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDetail(null);
      return;
    }
    setLoading(true);
    rpc.getSkill(skill.name)
      .then((result) => setDetail(result as SkillDetail | null))
      .catch(() => toast("error", "Failed to load skill detail"))
      .finally(() => setLoading(false));
  }, [open, skill]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader className="flex-row items-center gap-2 flex-wrap space-y-0">
          <DialogTitle className="text-base">{skill?.name}</DialogTitle>
          {skill?.preferredAgent && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-purple-100 text-purple-800">
              {skill.preferredAgent}
            </span>
          )}
        </DialogHeader>

        {skill && (
          <p className="text-sm text-gray-700 dark:text-gray-300 -mt-2">{skill.description}</p>
        )}

        {skill && (skill.allowedTools.length > 0 || skill.supportingFileCount > 0 || skill.argumentHint) && (
          <div className="flex items-center gap-3 text-xs text-gray-600 dark:text-gray-400 flex-wrap">
            {skill.allowedTools.length > 0 && (
              <span>Tools: {skill.allowedTools.map((t, i) => (
                <span key={t}>{i > 0 && ", "}<span className="font-semibold">{t}</span></span>
              ))}</span>
            )}
            {skill.supportingFileCount > 0 && (
              <span>{skill.supportingFileCount} supporting file{skill.supportingFileCount !== 1 ? "s" : ""}</span>
            )}
            {skill.argumentHint && (
              <span>Args: {skill.argumentHint}</span>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto border-t pt-4 -mt-2">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : detail?.content ? (
            <div className="max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={SKILL_MD_COMPONENTS as never}>
                {detail.content}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No content</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SkillErrorsDialog({ skill, open, onClose }: {
  skill: SkillSummary | null;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader className="flex-row items-center gap-2 space-y-0">
          <AlertTriangle className="h-4 w-4 text-red-500" />
          <DialogTitle className="text-base">Validation Errors — {skill?.name}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground -mt-1">
          This skill has issues that must be fixed in its <code className="px-1 py-0.5 rounded bg-muted font-mono text-xs">SKILL.md</code> frontmatter.
        </p>
        <div className="border-t pt-3 mt-1 space-y-2">
          {skill?.errors.map((err, i) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <span className="font-mono text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 px-1.5 py-0.5 rounded shrink-0">{err.field}</span>
              <span className="text-gray-700 dark:text-gray-300">{err.message}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null);
  const [errorsSkill, setErrorsSkill] = useState<SkillSummary | null>(null);
  const [toolsRefOpen, setToolsRefOpen] = useState(false);
  const [searchChatOpen, setSearchChatOpen] = useState(false);

  const filteredSkills = useMemo(() => {
    if (!search.trim()) return skills;
    const q = search.toLowerCase();
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [skills, search]);

  const errorCount = useMemo(() => skills.filter((s) => s.errors.length > 0).length, [skills]);

  const loadSkills = useCallback(async () => {
    try {
      const result = await rpc.getSkills();
      setSkills(result);
    } catch {
      toast("error", "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  // Auto-refresh the grid whenever the Search Remote Skills chat installs or
  // otherwise changes a skill — no manual Refresh click needed.
  useEffect(() => {
    const onRegistryRefreshed = () => { loadSkills(); };
    window.addEventListener("agentdesk:skills-chat-registry-refreshed", onRegistryRefreshed);
    return () => window.removeEventListener("agentdesk:skills-chat-registry-refreshed", onRegistryRefreshed);
  }, [loadSkills]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await rpc.refreshSkills();
      toast("success", `Reloaded ${result.count} skill${result.count !== 1 ? "s" : ""}`);
      await loadSkills();
    } catch {
      toast("error", "Failed to refresh skills");
    } finally {
      setRefreshing(false);
    }
  }, [loadSkills]);

  const handleOpenFolder = useCallback(async () => {
    try {
      await rpc.openSkillsFolder();
    } catch {
      toast("error", "Failed to open skills directory");
    }
  }, []);

  const handleEdit = useCallback(async (name: string) => {
    try {
      const result = await rpc.openSkillInEditor(name);
      if (!result.success) {
        toast("error", result.error ?? "Failed to open editor");
      }
    } catch {
      toast("error", "Failed to open skill in editor");
    }
  }, []);

  const [deleteSkill, setDeleteSkill] = useState<SkillSummary | null>(null);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteSkill) return;
    try {
      const result = await rpc.deleteSkill(deleteSkill.name);
      if (result.success) {
        toast("success", `Deleted skill "${deleteSkill.name}"`);
        await loadSkills();
      } else {
        toast("error", result.error ?? "Failed to delete skill");
      }
    } catch {
      toast("error", "Failed to delete skill");
    }
  }, [deleteSkill, loadSkills]);

  useHeaderActions(
    () => (
      <>
        <Button variant="outline" size="sm" onClick={() => setSearchChatOpen(true)}>
          <Search className="h-3.5 w-3.5 mr-1.5" />
          Search Remote Skills
        </Button>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
        <Button variant="outline" size="sm" onClick={handleOpenFolder}>
          <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
          Open Skills Folder
        </Button>
      </>
    ),
    [refreshing],
  );

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6 max-w-7xl mx-auto">
      {/* Sub-header: count, error badge, search */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Sparkles className="h-5 w-5 text-indigo-500" />
          {!loading && (
            <>
              <span className="text-sm text-muted-foreground">{skills.length} skill{skills.length !== 1 ? "s" : ""}</span>
              {errorCount > 0 && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 px-2 py-0.5 rounded-full">
                  <AlertTriangle className="h-3 w-3" />
                  {errorCount} with errors
                </span>
              )}
            </>
          )}
        </div>
        {!loading && skills.length > 0 && (
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Filter skills..."
            className="w-48"
          />
        )}
      </div>

      {/* Info banner */}
      <div className="mb-5 flex items-start gap-2.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-800 px-4 py-3">
        <Info className="h-4 w-4 text-indigo-500 mt-0.5 shrink-0" />
        <div className="text-sm text-indigo-800 dark:text-indigo-300">
          <p>
            Skills are specialized instruction sets that extend agent capabilities. Place a folder containing a{" "}
            <code className="text-xs bg-indigo-100 dark:bg-indigo-900 px-1 rounded">SKILL.md</code> file in your skills directory.
            Agents see a compact listing and load full skill content on demand via <code className="text-xs bg-indigo-100 dark:bg-indigo-900 px-1 rounded">read_skill</code>.
            {" "}For tools reference{" "}
            <button type="button" onClick={() => setToolsRefOpen(true)} className="font-semibold underline underline-offset-2 hover:text-indigo-600 dark:hover:text-indigo-200 transition-colors">
              click here
            </button>.
          </p>
        </div>
      </div>


      {/* Content */}
      {loading ? (
        <div className="text-center py-12 text-sm text-muted-foreground">Loading skills...</div>
      ) : skills.length === 0 ? (
        <div className="text-center py-16">
          <Sparkles className="h-10 w-10 text-muted-foreground/40 mx-auto mb-4" />
          <h2 className="text-sm font-medium text-foreground mb-2">No skills found</h2>
          <p className="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
            Create a folder with a <code className="text-xs bg-muted px-1 rounded">SKILL.md</code> file in your skills
            directory to get started. Each skill folder should contain a SKILL.md with YAML frontmatter describing the skill.
          </p>
          <Button variant="outline" size="sm" onClick={handleOpenFolder}>
            <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
            Open Skills Folder
          </Button>
        </div>
      ) : (
        <div>
          {filteredSkills.length === 0 ? (
            <p className="text-center py-8 text-sm text-muted-foreground">No skills matching "{search}"</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredSkills.map((skill) => (
                <SkillCard
                  key={skill.name}
                  skill={skill}
                  onEdit={handleEdit}
                  onClick={() => setSelectedSkill(skill)}
                  onViewErrors={setErrorsSkill}
                  onDelete={setDeleteSkill}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Skill detail dialog */}
      <SkillDetailDialog
        skill={selectedSkill}
        open={selectedSkill !== null}
        onClose={() => setSelectedSkill(null)}
      />
      <ToolsReferenceDialog open={toolsRefOpen} onClose={() => setToolsRefOpen(false)} />
      <SkillErrorsDialog
        skill={errorsSkill}
        open={errorsSkill !== null}
        onClose={() => setErrorsSkill(null)}
      />
      <ConfirmationDialog
        open={deleteSkill !== null}
        onOpenChange={(open) => { if (!open) setDeleteSkill(null); }}
        title={`Delete skill "${deleteSkill?.name}"`}
        description="This skill and all its files will be permanently removed from disk. This action cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteSkill(null)}
      />
      <SkillsSearchChatModal
        open={searchChatOpen}
        onClose={() => setSearchChatOpen(false)}
      />
    </div>
  );
}
