import { useState, useEffect, useCallback } from "react";
import { BookOpen, Plus, Pencil, Trash2, Search, X } from "lucide-react";
import { useHeaderActions } from "@/lib/header-context";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Prompt {
  id: string;
  name: string;
  description: string;
  content: string;
  category: string;
  createdAt: string;
  updatedAt: string;
}

function PromptForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Prompt | null;
  onSave: (data: { id?: string; name: string; description: string; content: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !content.trim()) {
      toast("error", "Name and content are required.");
      return;
    }
    setSaving(true);
    try {
      await onSave({ id: initial?.id, name: name.trim(), description: description.trim(), content: content.trim() });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Code Review"
          className="w-full px-3 py-2 text-sm border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Short description of what this prompt does"
          className="w-full px-3 py-2 text-sm border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Content</label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="The prompt text that will be inserted into chat..."
          rows={6}
          className="w-full px-3 py-2 text-sm border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y"
        />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? "Saving..." : initial ? "Update" : "Create"}
        </Button>
      </div>
    </form>
  );
}

export function PromptsPage() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [editingPrompt, setEditingPrompt] = useState<Prompt | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const results = await rpc.getPrompts();
      setPrompts(results as Prompt[]);
    } catch {
      toast("error", "Failed to load prompts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = search.trim()
    ? prompts.filter(
        (p) =>
          p.name.toLowerCase().includes(search.toLowerCase()) ||
          p.description.toLowerCase().includes(search.toLowerCase()),
      )
    : prompts;

  const builtins = filtered.filter((p) => p.category === "builtin");
  const custom = filtered.filter((p) => p.category !== "builtin");

  const handleSave = async (data: { id?: string; name: string; description: string; content: string }) => {
    try {
      await rpc.savePrompt(data);
      toast("success", data.id ? "Prompt updated." : "Prompt created.");
      setShowCreate(false);
      setEditingPrompt(null);
      await load();
    } catch {
      toast("error", "Failed to save prompt.");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await rpc.deletePrompt(id);
      toast("success", "Prompt deleted.");
      setDeleteConfirm(null);
      await load();
    } catch {
      toast("error", "Failed to delete prompt.");
    }
  };

  useHeaderActions(
    () => (
      <Button size="sm" onClick={() => setShowCreate(true)}>
        <Plus className="w-3.5 h-3.5 mr-1.5" /> New Prompt
      </Button>
    ),
    [],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 pt-4 pb-4 border-b shrink-0">
        {/* Search */}
        <div className="relative mt-4 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search prompts..."
            className="w-full pl-8 pr-8 py-1.5 text-sm border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <p className="text-sm text-muted-foreground text-center py-12">Loading...</p>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-sm text-muted-foreground">
            <BookOpen className="w-8 h-8 mb-3 opacity-30" />
            <p>{search ? "No prompts match your search." : "No prompts yet."}</p>
            {!search && (
              <p className="text-xs mt-1">Click "New Prompt" to create your first template.</p>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {/* Custom prompts */}
            {custom.length > 0 && (
              <section>
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
                  Custom ({custom.length})
                </h3>
                <div className="grid gap-2">
                  {custom.map((p) => (
                    <PromptCard
                      key={p.id}
                      prompt={p}
                      onEdit={() => setEditingPrompt(p)}
                      onDelete={() => setDeleteConfirm(p.id)}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Built-in prompts */}
            {builtins.length > 0 && (
              <section>
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
                  Built-in ({builtins.length})
                </h3>
                <div className="grid gap-2">
                  {builtins.map((p) => (
                    <PromptCard
                      key={p.id}
                      prompt={p}
                      onEdit={() => setEditingPrompt(p)}
                      onDelete={() => setDeleteConfirm(p.id)}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Prompt</DialogTitle>
          </DialogHeader>
          <PromptForm onSave={handleSave} onCancel={() => setShowCreate(false)} />
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editingPrompt} onOpenChange={(open) => { if (!open) setEditingPrompt(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Prompt</DialogTitle>
          </DialogHeader>
          {editingPrompt && (
            <PromptForm
              initial={editingPrompt}
              onSave={handleSave}
              onCancel={() => setEditingPrompt(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Prompt</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete this prompt? This cannot be undone.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => deleteConfirm && handleDelete(deleteConfirm)}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PromptCard({
  prompt,
  onEdit,
  onDelete,
}: {
  prompt: Prompt;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex items-start gap-3 border rounded-lg px-4 py-3 hover:bg-muted/30 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{prompt.name}</p>
          {prompt.category === "builtin" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 font-medium">
              Built-in
            </span>
          )}
        </div>
        {prompt.description && (
          <p className="text-xs text-muted-foreground mt-0.5">{prompt.description}</p>
        )}
        <p className="text-xs text-muted-foreground/60 mt-1 font-mono truncate">
          {prompt.content.slice(0, 100)}{prompt.content.length > 100 ? "..." : ""}
        </p>
      </div>
      <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onEdit}
          className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Edit prompt"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onDelete}
          className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600 transition-colors"
          aria-label="Delete prompt"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
