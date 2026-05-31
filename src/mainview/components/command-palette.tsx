import { useState, useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { rpc } from "@/lib/rpc";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  LayoutDashboard,
  Bot,
  Settings,
  Plus,
  FolderOpen,
  MessageSquare,
  CheckSquare,
  FileText,
  Inbox,
  Clock,
} from "lucide-react";

const RECENT_SEARCHES_KEY = "agentdesk:recent-searches";
const MAX_RECENT_SEARCHES = 5;

function getRecentSearches(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_SEARCHES_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function addRecentSearch(query: string): void {
  if (!query.trim()) return;
  const recent = getRecentSearches().filter((s) => s !== query);
  recent.unshift(query);
  localStorage.setItem(
    RECENT_SEARCHES_KEY,
    JSON.stringify(recent.slice(0, MAX_RECENT_SEARCHES)),
  );
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface Project {
  id: string;
  name: string;
}

interface SearchResult {
  type: string;
  id: string;
  title: string;
  description: string;
  projectId?: string;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [searchValue, setSearchValue] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      setRecentSearches(getRecentSearches()); // eslint-disable-line react-hooks/set-state-in-effect
      rpc.getProjects().then(setProjects).catch(() => { /* empty */ });
    } else {
      // Clear search state when palette closes
      setSearchValue("");
      setSearchResults([]);
    }
  }, [open]);

  // Debounced global search
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (searchValue.length < 2) {
      setSearchResults([]); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }

    debounceRef.current = setTimeout(() => {
      rpc
        .globalSearch(searchValue)
        .then((results) => {
          setSearchResults(results);
          addRecentSearch(searchValue);
          setRecentSearches(getRecentSearches());
        })
        .catch(() => setSearchResults([]));
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [searchValue]);

  function runCommand(fn: () => void) {
    onOpenChange(false);
    fn();
  }

  function getSearchResultIcon(type: string) {
    switch (type) {
      case "project":
        return <FolderOpen className="mr-2 size-4 shrink-0" />;
      case "conversation":
        return <MessageSquare className="mr-2 size-4 shrink-0" />;
      case "task":
        return <CheckSquare className="mr-2 size-4 shrink-0" />;
      case "doc":
        return <FileText className="mr-2 size-4 shrink-0" />;
      default:
        return <FolderOpen className="mr-2 size-4 shrink-0" />;
    }
  }

  function navigateToResult(result: SearchResult) {
    switch (result.type) {
      case "project":
        navigate({ to: "/project/$projectId", params: { projectId: result.id } });
        break;
      case "conversation":
        if (result.projectId) {
          navigate({ to: "/project/$projectId", params: { projectId: result.projectId } });
        }
        break;
      case "task":
        if (result.projectId) {
          navigate({ to: "/project/$projectId", params: { projectId: result.projectId } });
        }
        break;
      case "doc":
        if (result.projectId) {
          navigate({ to: "/project/$projectId", params: { projectId: result.projectId } });
        }
        break;
    }
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder="Type a command or search..."
        value={searchValue}
        onValueChange={setSearchValue}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {searchResults.length > 0 && (
          <>
            <CommandGroup heading="Search Results">
              {searchResults.map((result) => (
                <CommandItem
                  key={`${result.type}-${result.id}`}
                  onSelect={() =>
                    runCommand(() => navigateToResult(result))
                  }
                >
                  {getSearchResultIcon(result.type)}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{result.title}</span>
                    {result.description && (
                      <span className="text-muted-foreground truncate text-xs">
                        {result.description}
                      </span>
                    )}
                  </div>
                  <span className="text-muted-foreground ml-2 shrink-0 rounded border px-1 py-0.5 text-xs capitalize">
                    {result.type}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        <CommandGroup heading="Navigation">
          <CommandItem onSelect={() => runCommand(() => navigate({ to: "/" }))}>
            <LayoutDashboard className="mr-2 size-4" />
            Dashboard
            <CommandShortcut>⌘1</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => navigate({ to: "/agents" }))}>
            <Bot className="mr-2 size-4" />
            Agents
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => navigate({ to: "/settings" }))}>
            <Settings className="mr-2 size-4" />
            Settings
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => navigate({ to: "/inbox" }))}>
            <Inbox className="mr-2 size-4" />
            Inbox
          </CommandItem>
        </CommandGroup>

        {searchValue === "" && recentSearches.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recent Searches">
              {recentSearches.map((query) => (
                <CommandItem
                  key={query}
                  onSelect={() => setSearchValue(query)}
                >
                  <Clock className="mr-2 size-4 text-muted-foreground" />
                  {query}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />

        <CommandGroup heading="Actions">
          <CommandItem
            onSelect={() =>
              runCommand(() => {
                window.dispatchEvent(new CustomEvent("agentdesk:new-project"));
              })
            }
          >
            <Plus className="mr-2 size-4" />
            New Project
          </CommandItem>
        </CommandGroup>

        {projects.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Projects">
              {projects.map((p) => (
                <CommandItem
                  key={p.id}
                  onSelect={() =>
                    runCommand(() =>
                      navigate({
                        to: "/project/$projectId",
                        params: { projectId: p.id },
                      })
                    )
                  }
                >
                  <FolderOpen className="mr-2 size-4" />
                  {p.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

      </CommandList>
    </CommandDialog>
  );
}
