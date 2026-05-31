import { useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronsUpDown, LayoutDashboard, Layers } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { rpc } from "@/lib/rpc";

interface Project {
  id: string;
  name: string;
  status: string;
}

interface ProjectSwitcherProps {
  currentProjectId: string;
}

export function ProjectSwitcher({ currentProjectId }: ProjectSwitcherProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    rpc.getProjects().then((result) => {
      const data = result as unknown;
      setProjects(Array.isArray(data) ? (data as Project[]) : []);
    }).catch(() => {});
  }, [open]);

  function handleSelect(projectId: string) {
    setOpen(false);
    if (projectId !== currentProjectId) {
      navigate({ to: "/project/$projectId", params: { projectId } });
    }
  }

  function handleGoToDashboard() {
    setOpen(false);
    navigate({ to: "/" });
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm",
            "text-muted-foreground hover:text-foreground hover:bg-muted",
            "transition-colors border border-transparent hover:border-border",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          )}
          aria-label="Switch project"
          title="Switch project"
        >
          <Layers className="w-3.5 h-3.5 shrink-0" />
          <span className="text-xs font-medium hidden sm:inline">Projects</span>
          <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
          Switch project
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {projects.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground/60 text-center">Loading…</div>
        ) : (
          projects.map((project) => {
            const isCurrent = project.id === currentProjectId;
            return (
              <DropdownMenuItem
                key={project.id}
                onSelect={() => handleSelect(project.id)}
                className={cn(
                  "flex items-center gap-2 cursor-pointer",
                  isCurrent && "bg-accent"
                )}
              >
                <span className="flex-1 truncate text-sm">{project.name}</span>
                {isCurrent && <Check className="w-3.5 h-3.5 text-blue-600 shrink-0" />}
              </DropdownMenuItem>
            );
          })
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={handleGoToDashboard}
          className="flex items-center gap-2 cursor-pointer text-muted-foreground"
        >
          <LayoutDashboard className="w-3.5 h-3.5" />
          <span className="text-sm">All projects</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
