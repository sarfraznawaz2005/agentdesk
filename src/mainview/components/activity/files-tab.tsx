import { useState, useCallback, useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import {
  File,
  FileCode,
  FileText,
  FolderOpen,
  Folder,
  ChevronRight,
  ChevronDown,
  AlertCircle,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { rpc } from "../../lib/rpc";
import { ImageLightbox } from "@/components/chat/image-lightbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CodeBlock } from "@/components/chat/code-block";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  updatedAt: string;
}

interface TreeNode extends FileEntry {
  children?: TreeNode[];
  isLoaded: boolean;
  isExpanded: boolean;
}

interface FilesTabProps {
  projectId?: string;
}

export interface FilesTabHandle {
  refresh: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg"]);

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svg",
  "mp3", "mp4", "wav", "ogg", "webm", "avi", "mov",
  "zip", "tar", "gz", "rar", "7z", "bz2",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "exe", "dll", "so", "dylib", "bin", "dat",
  "woff", "woff2", "ttf", "eot", "otf",
  "sqlite", "db", "lock",
]);

function isBinaryFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXTENSIONS.has(ext);
}

function isImageFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

/** Derive a shiki language identifier from a filename extension. */
function getLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    jsonc: "json",
    md: "markdown",
    mdx: "markdown",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    less: "less",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    cpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sql: "sql",
    graphql: "graphql",
    gql: "graphql",
    xml: "xml",
    svg: "xml",
    txt: "plaintext",
    env: "bash",
    dockerfile: "dockerfile",
    makefile: "makefile",
  };
  return map[ext] ?? "plaintext";
}

/** Choose a lucide icon component for a file by its extension. */
function FileIcon({ name, className }: { name: string; className?: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const codeExts = new Set([
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "rs", "go",
    "java", "kt", "swift", "c", "cpp", "cs", "php", "sh", "bash", "zsh",
    "html", "htm", "css", "scss", "sass", "less", "graphql", "gql", "sql",
  ]);
  const textExts = new Set(["md", "mdx", "txt", "json", "jsonc", "yaml", "yml", "toml", "xml", "svg", "env"]);

  if (codeExts.has(ext)) return <FileCode className={className} aria-hidden="true" />;
  if (textExts.has(ext)) return <FileText className={className} aria-hidden="true" />;
  return <File className={className} aria-hidden="true" />;
}

/** Format bytes into a human-readable string. */
function formatSize(bytes: number): string {
  if (bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// TreeItem component — renders one row in the file tree
// ---------------------------------------------------------------------------

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  projectId: string;
  onToggle: (path: string) => void;
  onFileClick: (node: TreeNode) => void;
}

function TreeItem({ node, depth, projectId, onToggle, onFileClick }: TreeItemProps) {
  const indentPx = depth * 12;

  if (node.isDirectory) {
    return (
      <>
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          className={cn(
            "w-full flex items-center gap-1.5 px-2 py-1 text-left",
            "hover:bg-muted transition-colors focus:outline-none focus:bg-muted",
            "text-xs text-foreground/80",
          )}
          style={{ paddingLeft: `${8 + indentPx}px` }}
          aria-expanded={node.isExpanded}
        >
          {node.isExpanded ? (
            <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
          ) : (
            <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
          )}
          {node.isExpanded ? (
            <FolderOpen className="w-3.5 h-3.5 shrink-0 text-amber-400" aria-hidden="true" />
          ) : (
            <Folder className="w-3.5 h-3.5 shrink-0 text-amber-400" aria-hidden="true" />
          )}
          <span className="truncate font-medium">{node.name}</span>
        </button>

        {node.isExpanded && node.children && (
          <>
            {node.children.length === 0 && node.isLoaded ? (
              <div
                className="text-[10px] text-muted-foreground/60 italic py-1"
                style={{ paddingLeft: `${8 + indentPx + 24}px` }}
              >
                Empty
              </div>
            ) : (
              node.children.map((child) => (
                <TreeItem
                  key={child.path}
                  node={child}
                  depth={depth + 1}
                  projectId={projectId}
                  onToggle={onToggle}
                  onFileClick={onFileClick}
                />
              ))
            )}
          </>
        )}
      </>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onFileClick(node)}
      className={cn(
        "w-full flex items-center gap-1.5 px-2 py-1 text-left",
        "hover:bg-muted transition-colors focus:outline-none focus:bg-muted",
        "text-xs text-muted-foreground",
      )}
      style={{ paddingLeft: `${8 + indentPx + 16}px` }}
    >
      <FileIcon name={node.name} className="w-3.5 h-3.5 shrink-0 text-blue-400" />
      <span className="truncate flex-1">{node.name}</span>
      {node.size > 0 && (
        <span className="text-[10px] text-muted-foreground/60 shrink-0 ml-1">{formatSize(node.size)}</span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// FilesTab — main exported component
// ---------------------------------------------------------------------------

export const FilesTab = forwardRef<FilesTabHandle, FilesTabProps>(function FilesTab({ projectId }, ref) {
  const [rootNodes, setRootNodes] = useState<TreeNode[] | null>(null);
  const [isLoadingRoot, setIsLoadingRoot] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<{ node: TreeNode; content: string | null } | null>(null);
  const [imagePreview, setImagePreview] = useState<{ data: string; mimeType: string } | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // This component lives inside ChatLayout/ContextPanel, which stays mounted
  // across a project switch when the user lands on the Chat tab (ProjectPage
  // always force-selects "chat" on a project change) — unlike the other
  // project tabs, there's no unmount to reset stale in-flight fetches. Track
  // the latest projectId in a ref so an async callback can tell, after its
  // await, whether it's still relevant. Assigned in an effect (not during
  // render) per react-hooks/refs.
  const projectIdRef = useRef(projectId);
  useEffect(() => { projectIdRef.current = projectId; });

  // ----- Root load on first render -----

  const loadRoot = useCallback(async () => {
    if (!projectId) return;
    setIsLoadingRoot(true);
    setRootError(null);
    try {
      const entries = await rpc.listWorkspaceFiles(projectId);
      // A rapid project switch (A -> B) before this resolves must not let A's
      // stale response overwrite B's already-loaded tree.
      if (projectIdRef.current !== projectId) return;
      setRootNodes(
        entries.map((e) => ({
          ...e,
          isLoaded: false,
          isExpanded: false,
          children: e.isDirectory ? undefined : undefined,
        })),
      );
    } catch {
      if (projectIdRef.current === projectId) setRootError("Could not list workspace files");
    } finally {
      if (projectIdRef.current === projectId) setIsLoadingRoot(false);
    }
  }, [projectId]);

  // Reset and reload whenever projectId changes (covers project switcher navigation)
  useEffect(() => {
    setRootNodes(null);
    setRootError(null);
    setSelectedFile(null);
    setImagePreview(null);
    setFileError(null);
    if (projectId) loadRoot();
  // loadRoot already captures projectId; only re-run when projectId itself changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Expose refresh() to parent via ref so the context-panel toolbar can trigger it
  useImperativeHandle(ref, () => ({ refresh: loadRoot }), [loadRoot]);

  // Live-refresh when agents finish, PM stream completes, or a kanban task moves columns
  useEffect(() => {
    if (!projectId) return;
    const refresh = () => loadRoot();
    const onKanbanMove = (e: Event) => {
      const { action } = (e as CustomEvent<{ action: string }>).detail ?? {};
      if (action === "moved") loadRoot();
    };
    window.addEventListener("agentdesk:agent-inline-complete", refresh);
    window.addEventListener("agentdesk:stream-complete", refresh);
    window.addEventListener("agentdesk:kanban-task-updated", onKanbanMove);
    return () => {
      window.removeEventListener("agentdesk:agent-inline-complete", refresh);
      window.removeEventListener("agentdesk:stream-complete", refresh);
      window.removeEventListener("agentdesk:kanban-task-updated", onKanbanMove);
    };
  }, [projectId, loadRoot]);

  // ----- Directory toggle -----

  const handleToggle = useCallback(
    async (path: string) => {
      if (!projectId || !rootNodes) return;

      // Helper that walks and mutates a node array by path
      function toggle(nodes: TreeNode[]): TreeNode[] {
        return nodes.map((n) => {
          if (n.path === path) {
            const nowExpanded = !n.isExpanded;
            // If already loaded, just flip expansion
            if (n.isLoaded) return { ...n, isExpanded: nowExpanded };
            // Mark as pending — will be filled after the async load below
            return { ...n, isExpanded: nowExpanded };
          }
          if (n.children) return { ...n, children: toggle(n.children) };
          return n;
        });
      }

      // Flip expansion immediately
      setRootNodes((prev) => (prev ? toggle(prev) : prev));

      // Check if this node needs lazy loading
      const findNode = (nodes: TreeNode[], p: string): TreeNode | null => {
        for (const n of nodes) {
          if (n.path === p) return n;
          if (n.children) {
            const found = findNode(n.children, p);
            if (found) return found;
          }
        }
        return null;
      };

      const node = findNode(rootNodes, path);
      if (!node || node.isLoaded) return;

      // Lazy load children
      try {
        const entries = await rpc.listWorkspaceFiles(projectId, path);
        const children: TreeNode[] = entries.map((e) => ({
          ...e,
          isLoaded: false,
          isExpanded: false,
        }));

        // Inject children into the tree
        function inject(nodes: TreeNode[]): TreeNode[] {
          return nodes.map((n) => {
            if (n.path === path) return { ...n, isLoaded: true, children };
            if (n.children) return { ...n, children: inject(n.children) };
            return n;
          });
        }
        setRootNodes((prev) => (prev ? inject(prev) : prev));
      } catch {
        // Silently fail — directory shows as empty
      }
    },
    [projectId, rootNodes],
  );

  // ----- File click -----

  const handleFileClick = useCallback(
    async (node: TreeNode) => {
      if (!projectId) return;
      setSelectedFile(null);
      setFileError(null);
      setImagePreview(null);

      if (isImageFile(node.name)) {
        setIsLoadingFile(true);
        try {
          const result = await rpc.readWorkspaceImageFile(projectId, node.path);
          if (result.error) {
            setFileError(result.error);
            setSelectedFile({ node, content: null });
          } else {
            setImagePreview({ data: result.data, mimeType: result.mimeType });
          }
        } catch {
          setFileError("Could not load image");
          setSelectedFile({ node, content: null });
        } finally {
          setIsLoadingFile(false);
        }
        return;
      }

      if (isBinaryFile(node.name)) {
        setSelectedFile({ node, content: null });
        return;
      }

      setIsLoadingFile(true);

      try {
        const result = await rpc.readWorkspaceFile(projectId, node.path);
        if (result.error) {
          setFileError(result.error);
        } else {
          setSelectedFile({ node, content: result.content });
        }
      } catch {
        setFileError("Could not read file");
      } finally {
        setIsLoadingFile(false);
      }
    },
    [projectId],
  );

  // ----- Empty / no project state -----

  if (!projectId) {
    return (
      <div
        id="files-tab-panel"
        role="tabpanel"
        aria-label="Files"
        className="flex-1 flex items-center justify-center p-4"
      >
        <div className="text-center">
          <FolderOpen className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">No project selected</p>
        </div>
      </div>
    );
  }

  // ----- Loading state -----

  if (isLoadingRoot) {
    return (
      <div
        id="files-tab-panel"
        role="tabpanel"
        aria-label="Files"
        className="flex-1 flex items-center justify-center p-4"
      >
        <p className="text-sm text-muted-foreground/60">Loading files...</p>
      </div>
    );
  }

  // ----- Error state -----

  if (rootError) {
    return (
      <div
        id="files-tab-panel"
        role="tabpanel"
        aria-label="Files"
        className="flex-1 flex flex-col items-center justify-center p-4 gap-2"
      >
        <AlertCircle className="w-6 h-6 text-red-400" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{rootError}</p>
        <button
          type="button"
          onClick={loadRoot}
          className="flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-700 transition-colors"
        >
          <RefreshCw className="w-3 h-3" aria-hidden="true" />
          Retry
        </button>
      </div>
    );
  }

  // ----- Empty workspace -----

  if (rootNodes && rootNodes.length === 0) {
    return (
      <div
        id="files-tab-panel"
        role="tabpanel"
        aria-label="Files"
        className="flex-1 flex items-center justify-center p-4"
      >
        <div className="text-center">
          <FolderOpen className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">Workspace is empty</p>
          <p className="text-xs text-muted-foreground/60 mt-1">Files created by agents will appear here</p>
        </div>
      </div>
    );
  }

  // ----- Tree view -----

  return (
    <div
      id="files-tab-panel"
      role="tabpanel"
      aria-label="Files"
      className="flex flex-col flex-1 min-h-0"
    >
      {/* Toolbar */}
      <div className="flex items-center px-3 py-1.5 bg-muted border-b border-border shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Workspace
        </span>
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto">
        {rootNodes?.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            projectId={projectId}
            onToggle={handleToggle}
            onFileClick={handleFileClick}
          />
        ))}
      </div>

      {/* File content modal */}
      <Dialog
        open={selectedFile !== null || isLoadingFile || fileError !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedFile(null);
            setFileError(null);
          }
        }}
      >
        <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              {selectedFile?.node.name ?? (isLoadingFile ? "Loading..." : "Error")}
            </DialogTitle>
            {selectedFile && (
              <p className="text-[11px] text-muted-foreground font-mono mt-0.5">
                {selectedFile.node.path}
              </p>
            )}
          </DialogHeader>

          <div className="flex-1 overflow-y-auto min-h-0 mt-2">
            {isLoadingFile && (
              <p className="text-sm text-muted-foreground/60 p-4">Loading file content...</p>
            )}
            {fileError && (
              <div className="flex items-center gap-2 p-4 text-sm text-red-500">
                <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                {fileError}
              </div>
            )}
            {selectedFile && selectedFile.content === null && (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground/60">
                <File className="w-12 h-12 mb-3" aria-hidden="true" />
                <p className="text-sm font-medium">Binary file</p>
                <p className="text-xs mt-1">Preview not available for this file type</p>
              </div>
            )}
            {selectedFile && selectedFile.content !== null && (
              <CodeBlock
                language={getLanguage(selectedFile.node.name)}
                code={selectedFile.content}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {imagePreview && (
        <ImageLightbox
          src={`data:${imagePreview.mimeType};base64,${imagePreview.data}`}
          alt="Image preview"
          onClose={() => setImagePreview(null)}
        />
      )}
    </div>
  );
});
