import { useState, useEffect, useCallback } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { rpc } from "@/lib/rpc";
import { ScheduleBuilder } from "./schedule-builder";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Rome",
  "Europe/Madrid",
  "Europe/Amsterdam",
  "Europe/Stockholm",
  "Europe/Helsinki",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Pacific/Auckland",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProjectOption {
  id: string;
  name: string;
}

export interface CronJob {
  id: string;
  name: string;
  cronExpression: string;
  timezone: string | null;
  taskType: string;
  taskConfig: string;
  enabled: number; // 0 | 1
  oneShot: number; // 0 | 1
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  createdAt: string;
}

type TaskType = "reminder" | "shell" | "webhook" | "agent_task" | "agent_task_simple";

interface AgentOption {
  name: string;
  displayName: string;
}

interface TaskConfig {
  // agent_task / pm_prompt (legacy)
  projectId?: string;
  prompt?: string;
  agentId?: string;
  // reminder
  message?: string;
  // shell
  command?: string;
  timeout?: string;
  // webhook
  url?: string;
  method?: string;
  headers?: string;
  body?: string;
  // agent_task
  instructions?: string;
}

export interface CronJobFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  job?: CronJob;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CRON = "0 9 * * *";

function parseTaskConfig(taskConfig: string): TaskConfig {
  try {
    return JSON.parse(taskConfig) as TaskConfig;
  } catch {
    return {};
  }
}

function buildTaskConfig(type: TaskType, config: TaskConfig): string {
  switch (type) {
    case "reminder":
      return JSON.stringify({ message: config.message ?? "" });
    case "agent_task_simple":
      return JSON.stringify({
        instructions: config.instructions ?? "",
        agentId: config.agentId || "project-manager",
      });
    case "shell":
      return JSON.stringify({ command: config.command ?? "", timeout: Number(config.timeout ?? 60000) });
    case "webhook":
      return JSON.stringify({
        url: config.url ?? "",
        method: config.method ?? "GET",
        headers: config.headers ?? "",
        body: config.body ?? "",
      });
    case "agent_task":
      return JSON.stringify({
        projectId: config.projectId ?? "",
        instructions: config.instructions ?? "",
        agentId: config.agentId || "project-manager",
      });
    default:
      return "{}";
  }
}

// ---------------------------------------------------------------------------
// Task-type-specific fields
// ---------------------------------------------------------------------------

const READ_ONLY_AGENTS = new Set(["code-explorer", "research-expert", "task-planner"]);

interface TaskFieldsProps {
  type: TaskType;
  config: TaskConfig;
  onChange: (patch: Partial<TaskConfig>) => void;
  projects: ProjectOption[];
  agents: AgentOption[];
}

function ProjectSelect({ value, onChange, projects, required }: { value: string; onChange: (v: string) => void; projects: ProjectOption[]; required?: boolean }) {
  return (
    <Select value={value || (required ? "" : "__global__")} onValueChange={(v) => onChange(v === "__global__" ? "" : v)}>
      <SelectTrigger>
        <SelectValue placeholder="Select project" />
      </SelectTrigger>
      <SelectContent>
        {!required && <SelectItem value="__global__">Global (no project)</SelectItem>}
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TaskFields({ type, config, onChange, projects, agents }: TaskFieldsProps) {
  switch (type) {
    case "reminder":
      return (
        <div className="space-y-1.5">
          <Label htmlFor="tf-message">Message</Label>
          <Textarea
            id="tf-message"
            value={config.message ?? ""}
            onChange={(e) => onChange({ message: e.target.value })}
            placeholder="Reminder message..."
            rows={3}
          />
        </div>
      );

    case "shell":
      return (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tf-command">Command</Label>
            <Input
              id="tf-command"
              value={config.command ?? ""}
              onChange={(e) => onChange({ command: e.target.value })}
              placeholder="e.g. /usr/bin/my-script.sh"
              className="font-mono text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tf-timeout">Timeout (ms)</Label>
            <Input
              id="tf-timeout"
              type="number"
              min={1000}
              value={config.timeout ?? "60000"}
              onChange={(e) => onChange({ timeout: e.target.value })}
              placeholder="60000"
            />
          </div>
        </div>
      );

    case "webhook":
      return (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tf-url">URL</Label>
            <Input
              id="tf-url"
              type="url"
              value={config.url ?? ""}
              onChange={(e) => onChange({ url: e.target.value })}
              placeholder="https://example.com/webhook"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tf-method">Method</Label>
            <Select
              value={config.method ?? "GET"}
              onValueChange={(v) => onChange({ method: v })}
            >
              <SelectTrigger id="tf-method" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="GET">GET</SelectItem>
                <SelectItem value="POST">POST</SelectItem>
                <SelectItem value="PUT">PUT</SelectItem>
                <SelectItem value="DELETE">DELETE</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tf-headers">Headers (JSON)</Label>
            <Textarea
              id="tf-headers"
              value={config.headers ?? ""}
              onChange={(e) => onChange({ headers: e.target.value })}
              placeholder='{"Authorization": "Bearer ..."}'
              rows={2}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tf-body">Body</Label>
            <Textarea
              id="tf-body"
              value={config.body ?? ""}
              onChange={(e) => onChange({ body: e.target.value })}
              placeholder="Request body..."
              rows={3}
              className="font-mono text-xs"
            />
          </div>
        </div>
      );

    case "agent_task_simple":
      return (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Agent</Label>
            <Select
              value={config.agentId || "project-manager"}
              onValueChange={(v) => onChange({ agentId: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="project-manager">Project Manager</SelectItem>
                {agents
                  .filter((a) => a.name !== "project-manager")
                  .map((a) => (
                    <SelectItem key={a.name} value={a.name}>
                      {a.displayName}{READ_ONLY_AGENTS.has(a.name) ? " (read-only)" : ""}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tf-instructions-simple">Instructions</Label>
            <Textarea
              id="tf-instructions-simple"
              value={config.instructions ?? ""}
              onChange={(e) => onChange({ instructions: e.target.value })}
              placeholder="Instructions for the agent..."
              rows={4}
            />
          </div>
        </div>
      );

    case "agent_task":
      return (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Project</Label>
            <ProjectSelect value={config.projectId ?? ""} onChange={(v) => onChange({ projectId: v })} projects={projects} required />
          </div>
          <div className="space-y-1.5">
            <Label>Agent</Label>
            <Select
              value={config.agentId || "project-manager"}
              onValueChange={(v) => onChange({ agentId: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="project-manager">Project Manager</SelectItem>
                {agents
                  .filter((a) => a.name !== "project-manager")
                  .map((a) => (
                    <SelectItem key={a.name} value={a.name}>
                      {a.displayName}{READ_ONLY_AGENTS.has(a.name) ? " (read-only)" : ""}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tf-instructions">Instructions</Label>
            <Textarea
              id="tf-instructions"
              value={config.instructions ?? ""}
              onChange={(e) => onChange({ instructions: e.target.value })}
              placeholder="Instructions for the agent..."
              rows={4}
            />
          </div>
        </div>
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// CronJobForm
// ---------------------------------------------------------------------------

export function CronJobForm({ open, onOpenChange, onSaved, job }: CronJobFormProps) {
  const isEditing = !!job;

  // Form state
  const [name, setName] = useState("");
  const [cronExpr, setCronExpr] = useState(DEFAULT_CRON);
  const [timezone, setTimezone] = useState("UTC");
  const [taskType, setTaskType] = useState<TaskType>("reminder");
  const [taskConfig, setTaskConfig] = useState<TaskConfig>({ agentId: "project-manager" });
  const [oneShot, setOneShot] = useState(false);
  const [saving, setSaving] = useState(false);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);

  // Load projects and agents once when dialog opens
  useEffect(() => {
    if (!open) return;
    rpc.getProjects().then((result) => {
      setProjects(Array.isArray(result) ? (result as unknown as ProjectOption[]) : []);
    }).catch(() => { /* ignore */ });
    rpc.getAgents().then((result) => {
      setAgents(result.filter((a) => a.isEnabled).map((a) => ({ name: a.name, displayName: a.displayName })));
    }).catch(() => { /* ignore */ });
  }, [open]);

  // Reset form whenever the dialog opens/closes or the job changes
  useEffect(() => {
    if (!open) return;

    if (job) {
      setName(job.name);
      setCronExpr(job.cronExpression);
      setTimezone(job.timezone ?? "UTC");
      setTaskType((job.taskType as TaskType) ?? "reminder");
      setTaskConfig(parseTaskConfig(job.taskConfig));
      setOneShot(job.oneShot === 1);
    } else {
      setName("");
      setCronExpr(DEFAULT_CRON);
      setTimezone("UTC");
      setTaskType("reminder");
      setTaskConfig({});
      setOneShot(false);
      // Prefill timezone from global setting
      rpc.getSetting("timezone", "general").then((val) => {
        if (val && typeof val === "string" && val.length > 0) {
          setTimezone(val);
        }
      }).catch(() => { /* keep UTC fallback */ });
    }
  }, [open, job]);

  const handleTaskConfigChange = useCallback((patch: Partial<TaskConfig>) => {
    setTaskConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  // Validation
  function validate(): string | null {
    if (!name.trim()) return "Name is required.";
    if (!cronExpr.trim()) return "Schedule expression is required.";
    if (taskType === "webhook" && !taskConfig.url?.trim()) return "Webhook URL is required.";
    if (taskType === "shell" && !taskConfig.command?.trim()) return "Shell command is required.";
    if (taskType === "reminder" && !taskConfig.message?.trim()) return "Reminder message is required.";
    if (taskType === "agent_task" && !taskConfig.projectId?.trim()) return "A project is required for agent tasks.";
    if (taskType === "agent_task_simple" && !taskConfig.instructions?.trim()) return "Instructions are required.";
    return null;
  }

  async function handleSave() {
    const err = validate();
    if (err) {
      toast("error", err);
      return;
    }

    setSaving(true);
    try {
      const configStr = buildTaskConfig(taskType, taskConfig);

      if (isEditing && job) {
        await rpc.updateCronJob({
          id: job.id,
          name: name.trim(),
          cronExpression: cronExpr.trim(),
          timezone: timezone.trim() || "UTC",
          taskType,
          taskConfig: configStr,
          oneShot,
        });
        toast("success", "Cron job updated.");
      } else {
        await rpc.createCronJob({
          name: name.trim(),
          cronExpression: cronExpr.trim(),
          timezone: timezone.trim() || "UTC",
          taskType,
          taskConfig: configStr,
          enabled: true,
          oneShot,
        });
        toast("success", "Cron job created.");
      }

      onSaved();
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save cron job.";
      toast("error", msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Cron Job" : "New Cron Job"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-1">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="cjf-name">Name</Label>
            <Input
              id="cjf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Daily report"
              autoFocus
            />
          </div>


          {/* Schedule section */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">Schedule</Label>
            <ScheduleBuilder
              value={cronExpr}
              onChange={setCronExpr}
              timezone={timezone}
            />
          </div>


          {/* Timezone */}
          <div className="space-y-1.5">
            <Label htmlFor="cjf-tz">Timezone</Label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger id="cjf-tz">
                <SelectValue placeholder="Select timezone" />
              </SelectTrigger>
              <SelectContent>
                {COMMON_TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>


          {/* Task type */}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cjf-type" className="text-sm font-semibold">Task type</Label>
              <Select
                value={taskType}
                onValueChange={(v) => {
                  setTaskType(v as TaskType);
                  const needsAgent = v === "agent_task" || v === "agent_task_simple";
                  setTaskConfig(needsAgent ? { agentId: "project-manager" } : {});
                }}
              >
                <SelectTrigger id="cjf-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="agent_task_simple">Agent Task</SelectItem>
                  <SelectItem value="agent_task">Agent Project Task</SelectItem>
                  <SelectItem value="reminder">Reminder</SelectItem>
                  <SelectItem value="shell">Shell Command</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <TaskFields
              type={taskType}
              config={taskConfig}
              onChange={handleTaskConfigChange}
              projects={projects}
              agents={agents}
            />
          </div>


          {/* One-shot toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="cjf-oneshot">Run once then delete</Label>
              <p className="text-xs text-muted-foreground">
                The job will be permanently deleted after it runs successfully the first time.
              </p>
            </div>
            <Switch
              id="cjf-oneshot"
              checked={oneShot}
              onCheckedChange={setOneShot}
            />
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <DialogClose asChild>
            <Button variant="outline" disabled={saving}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : isEditing ? "Save changes" : "Create job"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
