import { useState, useEffect, useCallback } from "react";
import { Eye, EyeOff, Github, Check } from "lucide-react";
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
// Types
// ---------------------------------------------------------------------------

type ConnectionStatus = "not-configured" | "connected" | "invalid";

// ---------------------------------------------------------------------------
// Status indicator
// ---------------------------------------------------------------------------

interface StatusIndicatorProps {
  status: ConnectionStatus;
  username?: string;
}

function StatusIndicator({ status, username }: StatusIndicatorProps) {
  if (status === "connected") {
    return (
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full bg-green-500"
          aria-hidden="true"
        />
        <span className="text-sm text-green-700">
          Connected
          {username ? (
            <>
              {" "}as{" "}
              <span className="font-medium">@{username}</span>
            </>
          ) : null}
        </span>
      </div>
    );
  }

  if (status === "invalid") {
    return (
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full bg-red-500"
          aria-hidden="true"
        />
        <span className="text-sm text-red-700">Invalid token</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span
        className="inline-block h-2 w-2 rounded-full bg-gray-300 dark:bg-gray-600"
        aria-hidden="true"
      />
      <span className="text-sm text-muted-foreground">Not configured</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export function GithubSettings() {
  const [pat, setPat] = useState("");
  const [showPat, setShowPat] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>("not-configured");
  const [username, setUsername] = useState<string | undefined>(undefined);
  const [isSaving, setIsSaving] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isValidated, setIsValidated] = useState(false);

  // Load persisted settings on mount
  useEffect(() => {
    let cancelled = false;

    rpc
      .getSettings("github")
      .then((settings) => {
        if (cancelled) return;

        const savedPat = settings["github_pat"];
        const savedStatus = settings["github_status"];
        const savedUsername = settings["github_username"];

        if (typeof savedPat === "string" && savedPat.length > 0) {
          setPat(savedPat);
        }
        if (savedStatus === "connected") {
          setStatus("connected");
          setIsValidated(true);
          if (typeof savedUsername === "string" && savedUsername !== "github-user") {
            setUsername(savedUsername);
          }
        }
      })
      .catch(() => {
        // Settings not yet seeded — start fresh
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // When the PAT changes after a successful validation, reset validated state
  // so the user knows they need to re-validate the new value.
  const handlePatChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setPat(e.target.value);
      setIsValidated(false);
      if (status !== "not-configured") {
        setStatus("not-configured");
        setUsername(undefined);
      }
    },
    [status],
  );

  const handleValidate = useCallback(async () => {
    if (!pat.trim()) {
      toast("warning", "Please enter a Personal Access Token before validating.");
      return;
    }

    setIsValidating(true);
    try {
      const result = await rpc.validateGithubToken(pat.trim());
      if (result.valid) {
        setStatus("connected");
        setUsername(result.username);
        setIsValidated(true);
        toast("success", `GitHub token validated — authenticated as @${result.username}`);
      } else {
        setStatus("invalid");
        setUsername(undefined);
        setIsValidated(false);
        toast("error", `Token invalid: ${result.error ?? "Bad credentials"}`);
      }
    } catch {
      setStatus("invalid");
      setIsValidated(false);
      toast("error", "Failed to validate token. Please try again.");
    } finally {
      setIsValidating(false);
    }
  }, [pat]);

  const handleSave = useCallback(async () => {
    if (!pat.trim()) {
      toast("warning", "Enter a Personal Access Token before saving.");
      return;
    }

    setIsSaving(true);
    try {
      await rpc.saveSetting("github_pat", pat.trim(), "github");
      await rpc.saveSetting(
        "github_status",
        status === "connected" ? "connected" : "not-configured",
        "github",
      );
      if (username) {
        await rpc.saveSetting("github_username", username, "github");
      }
      toast("success", "GitHub settings saved.");
    } catch {
      toast("error", "Failed to save GitHub settings. Please try again.");
    } finally {
      setIsSaving(false);
    }
  }, [pat, status, username]);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h3 className="text-lg font-semibold">GitHub Integration</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Connect AgentDesk to GitHub using a Personal Access Token. The token
          is stored locally and never sent to any third-party service.
        </p>
      </div>

      <Separator />

      {/* Connection card */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Github
                className="h-5 w-5 text-foreground"
                aria-hidden="true"
              />
              <CardTitle className="text-base">Connection Status</CardTitle>
            </div>
            <StatusIndicator status={status} username={username} />
          </div>
          <CardDescription>
            A token with{" "}
            <code className="text-xs font-mono bg-muted px-1 py-0.5 rounded">
              repo
            </code>{" "}
            and{" "}
            <code className="text-xs font-mono bg-muted px-1 py-0.5 rounded">
              read:user
            </code>{" "}
            scopes is required.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* PAT field */}
          <div className="space-y-2">
            <Label htmlFor="github-pat">Personal Access Token</Label>
            <div className="relative">
              <Input
                id="github-pat"
                type={showPat ? "text" : "password"}
                value={pat}
                onChange={handlePatChange}
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                autoComplete="off"
                spellCheck={false}
                className="pr-10 font-mono text-sm"
                aria-describedby="github-pat-hint"
              />
              <button
                type="button"
                onClick={() => setShowPat((prev) => !prev)}
                aria-label={showPat ? "Hide token" : "Show token"}
                className={cn(
                  "absolute inset-y-0 right-0 flex items-center px-3",
                  "text-muted-foreground transition-colors hover:text-foreground",
                  "rounded-r-md",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                )}
              >
                {showPat ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
            <p id="github-pat-hint" className="text-xs text-muted-foreground">
              Generate a token at{" "}
              <span className="font-mono">github.com/settings/tokens</span>.
            </p>
          </div>

          {/* Validate row */}
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleValidate}
              disabled={!pat.trim() || isValidating || isSaving}
              aria-label="Validate Personal Access Token"
            >
              {isValidating ? (
                "Validating..."
              ) : isValidated ? (
                <>
                  <Check
                    className="h-4 w-4 text-green-600"
                    aria-hidden="true"
                  />
                  Validated
                </>
              ) : (
                "Validate"
              )}
            </Button>

            {isValidated && status === "connected" && username && (
              <p className="text-sm text-muted-foreground">
                Authenticated as{" "}
                <span className="font-medium text-foreground">
                  @{username}
                </span>
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Save action */}
      <div className="flex justify-end">
        <Button
          type="button"
          onClick={handleSave}
          disabled={!pat.trim() || isSaving || isValidating}
        >
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
