import { useState, useEffect, useCallback } from "react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// ---------------------------------------------------------------------------
// Default constitution text
// ---------------------------------------------------------------------------

const DEFAULT_CONSTITUTION = `## CRITICAL RULES:

- If you are unsure about any requirement, behavior, or implementation detail, ask clarifying questions **before** writing code.
- At every step, provide a **high-level explanation** of what changes were made and why.
- After implementing changes or new features, always provide a list of **suggestions or improvements**, even if they differ from the user's original request.
- If the user requests a change or feature that is an **anti-pattern** or violates well-established best practices, clearly explain the issue and ask for confirmation before proceeding.
- Always follow established best practices in your implementations.
- Simplicity is key. If something can be done in easy way without complexity, prefer that.
- Follow established principles such as DRY, KISS, SOLID, etc. for coding tasks.
- Always create todos before implementations.`;

// ---------------------------------------------------------------------------
// ConstitutionSettings
// ---------------------------------------------------------------------------

export function ConstitutionSettings() {
  const [text, setText] = useState(DEFAULT_CONSTITUTION);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // ---- Load constitution on mount ------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function loadConstitution() {
      try {
        const result = await rpc.getSettings("system");
        if (cancelled) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stored = (result as any)?.constitution;

        if (typeof stored === "string" && stored.trim().length > 0) {
          setText(stored);
        }
      } catch {
        if (!cancelled) {
          toast("error", "Failed to load constitution.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadConstitution();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Save ----------------------------------------------------------------

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await rpc.saveSetting("constitution", text, "system");
      setDirty(false);
      toast("success", "Constitution saved.");
    } catch {
      toast("error", "Failed to save constitution. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [text]);

  // ---- Reset to default ----------------------------------------------------

  const handleReset = useCallback(() => {
    setText(DEFAULT_CONSTITUTION);
    setDirty(true);
  }, []);

  // ---- Render --------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading constitution…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 py-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground">Constitution</h3>
        <p className="text-sm text-muted-foreground mt-1">
          The agent constitution defines standing rules that every agent must
          follow regardless of the task or project.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Agent Constitution</CardTitle>
          <CardDescription>
            Write your rules in plain text. Agents will be given this text as
            a system-level constraint at the start of every session.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            id="constitution-text"
            aria-label="Agent constitution"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
            rows={12}
            className="font-mono text-sm resize-y min-h-[200px]"
            placeholder={DEFAULT_CONSTITUTION}
            spellCheck={false}
          />
        </CardContent>
      </Card>

      {/* ---- Footer actions ----------------------------------------------- */}
      <div className="flex items-center justify-between gap-3">
        <Button
          variant="outline"
          onClick={handleReset}
          disabled={saving || text === DEFAULT_CONSTITUTION}
        >
          Reset to Default
        </Button>

        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
