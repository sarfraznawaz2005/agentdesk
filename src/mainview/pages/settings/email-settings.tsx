import { useState, useEffect, useCallback } from "react";
import { Eye, EyeOff, Trash2, Plus, Check, AlertCircle, Mail } from "lucide-react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const PRESETS: Record<
  string,
  {
    imapHost: string;
    imapPort: number;
    imapTls: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpTls: boolean;
  }
> = {
  gmail: {
    imapHost: "imap.gmail.com",
    imapPort: 993,
    imapTls: true,
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    smtpTls: true,
  },
  outlook: {
    imapHost: "outlook.office365.com",
    imapPort: 993,
    imapTls: true,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    smtpTls: true,
  },
  yahoo: {
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    imapTls: true,
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    smtpTls: true,
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EmailChannel {
  id: string;
  projectId: string | null;
  platform: string;
  config: string;
  enabled: number;
  createdAt: string;
  updatedAt: string;
}

interface ParsedEmailConfig {
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpTls: boolean;
}

interface Project {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Helper — safe JSON parse
// ---------------------------------------------------------------------------

function parseEmailConfig(raw: string): ParsedEmailConfig {
  try {
    return JSON.parse(raw) as ParsedEmailConfig;
  } catch {
    return {
      imapHost: "",
      imapPort: 993,
      imapUser: "",
      imapPass: "",
      imapTls: true,
      smtpHost: "",
      smtpPort: 587,
      smtpUser: "",
      smtpPass: "",
      smtpTls: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Reusable toggle switch
// ---------------------------------------------------------------------------

function ToggleSwitch({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <label
        htmlFor={id}
        className="text-sm font-medium leading-none cursor-pointer"
      >
        {label}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent",
          "transition-colors duration-200 ease-in-out",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          checked ? "bg-primary" : "bg-input",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg",
            "transform transition duration-200 ease-in-out",
            checked ? "translate-x-4" : "translate-x-0",
          )}
        />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Password input with show/hide toggle
// ---------------------------------------------------------------------------

function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  show,
  onToggleShow,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  show: boolean;
  onToggleShow: () => void;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="pr-10 font-mono text-sm"
      />
      <button
        type="button"
        onClick={onToggleShow}
        aria-label={show ? "Hide password" : "Show password"}
        className={cn(
          "absolute inset-y-0 right-0 flex items-center px-3",
          "text-muted-foreground transition-colors hover:text-foreground",
          "rounded-r-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        )}
      >
        {show ? (
          <EyeOff className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Eye className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Config form — used for both create and edit
// ---------------------------------------------------------------------------

interface ConfigFormProps {
  initial?: {
    id: string;
    parsed: ParsedEmailConfig;
    projectId: string | null;
    enabled: boolean;
  };
  projects: Project[];
  onSaved: () => void;
  onCancel: () => void;
}

function ConfigForm({ initial, projects, onSaved, onCancel }: ConfigFormProps) {
  // IMAP fields
  const [imapHost, setImapHost] = useState(initial?.parsed.imapHost ?? "");
  const [imapPort, setImapPort] = useState(initial?.parsed.imapPort ?? 993);
  const [imapUser, setImapUser] = useState(initial?.parsed.imapUser ?? "");
  const [imapPass, setImapPass] = useState(initial?.parsed.imapPass ?? "");
  const [imapTls, setImapTls] = useState(initial?.parsed.imapTls ?? true);
  const [showImapPass, setShowImapPass] = useState(false);

  // SMTP fields
  const [smtpHost, setSmtpHost] = useState(initial?.parsed.smtpHost ?? "");
  const [smtpPort, setSmtpPort] = useState(initial?.parsed.smtpPort ?? 587);
  const [smtpUser, setSmtpUser] = useState(initial?.parsed.smtpUser ?? "");
  const [smtpPass, setSmtpPass] = useState(initial?.parsed.smtpPass ?? "");
  const [smtpTls, setSmtpTls] = useState(initial?.parsed.smtpTls ?? true);
  const [showSmtpPass, setShowSmtpPass] = useState(false);

  // Shared
  const [projectId, setProjectId] = useState(initial?.projectId ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    success?: boolean;
    error?: string;
  } | null>(null);

  // Apply a preset — fills host/port/TLS, leaves credentials alone
  const handlePreset = useCallback(
    (key: string) => {
      if (key === "") return;
      const preset = PRESETS[key];
      if (!preset) return;
      setImapHost(preset.imapHost);
      setImapPort(preset.imapPort);
      setImapTls(preset.imapTls);
      setSmtpHost(preset.smtpHost);
      setSmtpPort(preset.smtpPort);
      setSmtpTls(preset.smtpTls);
      setTestResult(null);
    },
    [],
  );

  const handleTest = useCallback(async () => {
    if (!imapHost.trim() || !smtpHost.trim()) {
      toast("warning", "Enter at least the IMAP and SMTP hosts before testing.");
      return;
    }
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await rpc.testEmailConnection({
        imapHost: imapHost.trim(),
        imapPort,
        imapUser: imapUser.trim(),
        imapPass,
        imapTls,
        smtpHost: smtpHost.trim(),
        smtpPort,
        smtpUser: smtpUser.trim(),
        smtpPass,
        smtpTls,
      });
      if (result.success) {
        setTestResult({ success: true });
        toast("success", "Connection test passed for both IMAP and SMTP.");
      } else {
        setTestResult({ error: result.error ?? "Connection failed" });
        toast("error", result.error ?? "Connection test failed.");
      }
    } catch {
      setTestResult({ error: "Unexpected error during test" });
      toast("error", "Unexpected error during connection test.");
    } finally {
      setIsTesting(false);
    }
  }, [imapHost, imapPort, imapUser, imapPass, imapTls, smtpHost, smtpPort, smtpUser, smtpPass, smtpTls]);

  const handleSave = useCallback(async () => {
    if (!imapHost.trim()) {
      toast("warning", "IMAP host is required.");
      return;
    }
    if (!imapUser.trim()) {
      toast("warning", "IMAP username is required.");
      return;
    }
    if (!smtpHost.trim()) {
      toast("warning", "SMTP host is required.");
      return;
    }
    if (!smtpUser.trim()) {
      toast("warning", "SMTP username is required.");
      return;
    }

    setIsSaving(true);
    try {
      await rpc.saveEmailConfig({
        id: initial?.id,
        projectId: projectId || undefined,
        imapHost: imapHost.trim(),
        imapPort,
        imapUser: imapUser.trim(),
        imapPass,
        imapTls,
        smtpHost: smtpHost.trim(),
        smtpPort,
        smtpUser: smtpUser.trim(),
        smtpPass,
        smtpTls,
        enabled,
      });
      toast("success", initial?.id ? "Email config updated." : "Email config saved.");
      onSaved();
    } catch {
      toast("error", "Failed to save email config. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }, [
    imapHost, imapPort, imapUser, imapPass, imapTls,
    smtpHost, smtpPort, smtpUser, smtpPass, smtpTls,
    projectId, enabled, initial, onSaved,
  ]);

  const canSave =
    imapHost.trim() !== "" &&
    imapUser.trim() !== "" &&
    smtpHost.trim() !== "" &&
    smtpUser.trim() !== "" &&
    !isSaving &&
    !isTesting;

  return (
    <div className="space-y-4">
      {/* Preset selector */}
      <div className="space-y-2">
        <Label htmlFor="email-preset">Quick Setup</Label>
        <select
          id="email-preset"
          defaultValue=""
          onChange={(e) => handlePreset(e.target.value)}
          className={cn(
            "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1",
            "text-sm shadow-sm transition-colors",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          <option value="">Select a provider preset...</option>
          <option value="gmail">Gmail</option>
          <option value="outlook">Outlook / Office 365</option>
          <option value="yahoo">Yahoo Mail</option>
        </select>
        <p className="text-xs text-muted-foreground">
          Selecting a preset fills in the server addresses and ports. Your
          credentials are not affected.
        </p>
      </div>

      <Separator />

      {/* IMAP section */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">
            IMAP Configuration
          </CardTitle>
          <CardDescription className="text-xs">
            Incoming mail — used to receive and read messages.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Host + Port row */}
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div className="space-y-2">
              <Label htmlFor="imap-host">Host</Label>
              <Input
                id="imap-host"
                value={imapHost}
                onChange={(e) => { setImapHost(e.target.value); setTestResult(null); }}
                placeholder="imap.example.com"
                spellCheck={false}
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="imap-port">Port</Label>
              <Input
                id="imap-port"
                type="number"
                min={1}
                max={65535}
                value={imapPort}
                onChange={(e) => setImapPort(Number(e.target.value))}
                className="w-24 font-mono text-sm"
              />
            </div>
          </div>

          {/* Username */}
          <div className="space-y-2">
            <Label htmlFor="imap-user">Username</Label>
            <Input
              id="imap-user"
              type="email"
              value={imapUser}
              onChange={(e) => setImapUser(e.target.value)}
              placeholder="you@example.com"
              autoComplete="off"
              className="text-sm"
            />
          </div>

          {/* Password */}
          <div className="space-y-2">
            <Label htmlFor="imap-pass">Password</Label>
            <PasswordInput
              id="imap-pass"
              value={imapPass}
              onChange={(v) => { setImapPass(v); setTestResult(null); }}
              placeholder="IMAP password or app password"
              show={showImapPass}
              onToggleShow={() => setShowImapPass((prev) => !prev)}
            />
          </div>

          {/* TLS */}
          <ToggleSwitch
            id="imap-tls"
            checked={imapTls}
            onChange={setImapTls}
            label="Use TLS"
          />
        </CardContent>
      </Card>

      {/* SMTP section */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">
            SMTP Configuration
          </CardTitle>
          <CardDescription className="text-xs">
            Outgoing mail — used to send replies and notifications.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Host + Port row */}
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div className="space-y-2">
              <Label htmlFor="smtp-host">Host</Label>
              <Input
                id="smtp-host"
                value={smtpHost}
                onChange={(e) => { setSmtpHost(e.target.value); setTestResult(null); }}
                placeholder="smtp.example.com"
                spellCheck={false}
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtp-port">Port</Label>
              <Input
                id="smtp-port"
                type="number"
                min={1}
                max={65535}
                value={smtpPort}
                onChange={(e) => setSmtpPort(Number(e.target.value))}
                className="w-24 font-mono text-sm"
              />
            </div>
          </div>

          {/* Username */}
          <div className="space-y-2">
            <Label htmlFor="smtp-user">Username</Label>
            <Input
              id="smtp-user"
              type="email"
              value={smtpUser}
              onChange={(e) => setSmtpUser(e.target.value)}
              placeholder="you@example.com"
              autoComplete="off"
              className="text-sm"
            />
          </div>

          {/* Password */}
          <div className="space-y-2">
            <Label htmlFor="smtp-pass">Password</Label>
            <PasswordInput
              id="smtp-pass"
              value={smtpPass}
              onChange={(v) => { setSmtpPass(v); setTestResult(null); }}
              placeholder="SMTP password or app password"
              show={showSmtpPass}
              onToggleShow={() => setShowSmtpPass((prev) => !prev)}
            />
          </div>

          {/* TLS */}
          <ToggleSwitch
            id="smtp-tls"
            checked={smtpTls}
            onChange={setSmtpTls}
            label="Use TLS"
          />
        </CardContent>
      </Card>

      {/* Test Connection */}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleTest}
          disabled={!imapHost.trim() || !smtpHost.trim() || isTesting || isSaving}
        >
          {isTesting ? "Testing..." : "Test Connection"}
        </Button>
        {testResult?.success && (
          <span className="flex items-center gap-1 text-sm text-green-700">
            <Check className="h-4 w-4" aria-hidden="true" />
            IMAP and SMTP connected
          </span>
        )}
        {testResult?.error && (
          <span className="flex items-center gap-1 text-sm text-red-600">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            {testResult.error}
          </span>
        )}
      </div>

      <Separator />

      {/* Project assignment */}
      <div className="space-y-2">
        <Label htmlFor="email-project">Project (optional)</Label>
        <select
          id="email-project"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className={cn(
            "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1",
            "text-sm shadow-sm transition-colors",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          <option value="">No project (global)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {/* Enable toggle */}
      <ToggleSwitch
        id="email-enabled"
        checked={enabled}
        onChange={setEnabled}
        label="Enable this configuration"
      />

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={isSaving}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={!canSave}
        >
          {isSaving ? "Saving..." : initial?.id ? "Update" : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main settings component
// ---------------------------------------------------------------------------

export function EmailSettings() {
  const [configs, setConfigs] = useState<EmailChannel[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingConfig, setEditingConfig] = useState<EmailChannel | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [cfgs, projs] = await Promise.all([
        rpc.getEmailConfigs(),
        rpc.getProjects(),
      ]);
      setConfigs(cfgs);
      setProjects(projs);
    } catch {
      toast("error", "Failed to load email settings.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = useCallback(async (id: string) => {
    setDeletingId(id);
    try {
      await rpc.deleteEmailConfig(id);
      toast("success", "Email config deleted.");
      setConfigs((prev) => prev.filter((c) => c.id !== id));
    } catch {
      toast("error", "Failed to delete email config.");
    } finally {
      setDeletingId(null);
    }
  }, []);

  const handleSaved = useCallback(() => {
    setShowForm(false);
    setEditingConfig(null);
    load();
  }, [load]);

  const handleCancel = useCallback(() => {
    setShowForm(false);
    setEditingConfig(null);
  }, []);

  function projectName(id: string | null): string {
    if (!id) return "Global";
    return projects.find((p) => p.id === id)?.name ?? id;
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-32 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold">Email Integration</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Connect an email account via IMAP and SMTP to let AgentDesk receive
          messages, convert them to tasks, and send replies on your behalf.
        </p>
      </div>

      <Separator />

      {/* Info card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-foreground" aria-hidden="true" />
            <CardTitle className="text-base">IMAP / SMTP</CardTitle>
          </div>
          <CardDescription>
            Use an app-specific password where possible (Gmail, Yahoo, Outlook
            all support this). Credentials are stored locally and never
            transmitted outside your machine.
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Existing configurations */}
      {configs.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium">Configured Accounts</h4>
          {configs.map((cfg) => {
            const parsed = parseEmailConfig(cfg.config);
            return (
              <Card key={cfg.id}>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "inline-block h-2 w-2 rounded-full shrink-0",
                            cfg.enabled ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600",
                          )}
                          aria-hidden="true"
                        />
                        <span className="text-sm font-medium truncate">
                          {projectName(cfg.projectId)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground font-mono">
                        IMAP: {parsed.imapHost || "—"}:{parsed.imapPort} &bull;
                        SMTP: {parsed.smtpHost || "—"}:{parsed.smtpPort}
                      </p>
                      {parsed.imapUser && (
                        <p className="text-xs text-muted-foreground">
                          {parsed.imapUser}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditingConfig(cfg);
                          setShowForm(false);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleDelete(cfg.id)}
                        disabled={deletingId === cfg.id}
                        aria-label="Delete this email configuration"
                      >
                        {deletingId === cfg.id ? (
                          "..."
                        ) : (
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* Inline edit form */}
                  {editingConfig?.id === cfg.id && (
                    <div className="mt-4 pt-4 border-t">
                      <ConfigForm
                        initial={{
                          id: cfg.id,
                          parsed: parseEmailConfig(cfg.config),
                          projectId: cfg.projectId,
                          enabled: cfg.enabled === 1,
                        }}
                        projects={projects}
                        onSaved={handleSaved}
                        onCancel={handleCancel}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add new configuration */}
      {showForm ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">New Email Configuration</CardTitle>
          </CardHeader>
          <CardContent>
            <ConfigForm
              projects={projects}
              onSaved={handleSaved}
              onCancel={handleCancel}
            />
          </CardContent>
        </Card>
      ) : (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setShowForm(true);
            setEditingConfig(null);
          }}
          className="flex items-center gap-2"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add Email Configuration
        </Button>
      )}
    </div>
  );
}
