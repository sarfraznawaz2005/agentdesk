import { useState, useEffect, useCallback } from "react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tip } from "@/components/ui/tooltip";
import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { IssueFixerConfigDto } from "../../../shared/rpc/issue-fixer";

interface KeywordDef {
	keyword: string;
	intent: string;
	description: string;
}

const POLL_OPTIONS = [
	{ value: 15, label: "Every 15 minutes" },
	{ value: 30, label: "Every 30 minutes" },
	{ value: 60, label: "Hourly" },
	{ value: 120, label: "Every 2 hours" },
	{ value: 180, label: "Every 3 hours" },
	{ value: 300, label: "Every 5 hours" },
];

type FormState = Omit<IssueFixerConfigDto, "projectId" | "cursorAt" | "lastPolledAt">;

/** Renders a labelled list of options for a help tooltip. */
function OptionHelp({ intro, items }: { intro: string; items: { name: string; desc: string }[] }) {
	return (
		<div className="space-y-1.5">
			<p>{intro}</p>
			<ul className="space-y-1">
				{items.map((it) => (
					<li key={it.name}>
						<span className="font-semibold">{it.name}</span> — {it.desc}
					</li>
				))}
			</ul>
		</div>
	);
}

const AUTH_HELP = (
	<OptionHelp
		intro="Controls who is allowed to start an Issue Fixer run."
		items={[
			{
				name: "Collaborators (keywords) or label",
				desc: "A repo owner, member, or collaborator can trigger with a keyword, OR anyone can trigger by adding an agentdesk-* label. Most permissive.",
			},
			{
				name: "Collaborators only (keywords)",
				desc: "Only owners/members/collaborators can trigger, and only via keywords. Labels are ignored.",
			},
			{
				name: "Label-gated only",
				desc: "A run starts only when an agentdesk-* label is present, regardless of who applied it. Keywords are ignored. Most restrictive.",
			},
		]}
	/>
);

const AUTONOMY_HELP = (
	<OptionHelp
		intro="How far the agent goes on its own. It never merges — you always review and merge."
		items={[
			{
				name: "Branch + PR (no merge)",
				desc: "Creates a branch, commits the fix, and opens a normal pull request for your review.",
			},
			{
				name: "Dry-run / Draft PR",
				desc: "Opens the PR as a draft (also used automatically when the test/build gate fails), signalling it is not ready to merge.",
			},
		]}
	/>
);

const DEFAULT_FORM: FormState = {
	enabled: false,
	keywords: ["agentdesk-task", "agentdesk-fix"],
	labels: ["agentdesk-task"],
	authMode: "both",
	pollIntervalMin: 60,
	autonomy: "branch_pr",
	testCommand: null,
	customInstructions: null,
	tokenSource: "global",
	cooldownSec: 0,
	maxPerHour: 5,
	notifyChannels: [],
};

function Row({
	label,
	description,
	help,
	children,
}: {
	label: string;
	description?: string;
	/** Optional rich explanation surfaced via a help icon next to the label. */
	help?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[260px_1fr]">
			<div className="space-y-1">
				<div className="flex items-center gap-1.5">
					<Label>{label}</Label>
					{help && (
						<Tip content={help} side="right">
							<button
								type="button"
								aria-label={`What does "${label}" mean?`}
								className="text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground"
							>
								<HelpCircle className="h-3.5 w-3.5" />
							</button>
						</Tip>
					)}
				</div>
				{description && <p className="text-xs text-muted-foreground">{description}</p>}
			</div>
			<div className="w-full max-w-md">{children}</div>
		</div>
	);
}

export function IssueFixerSettingsTab({
	projectId,
	config,
	configLoaded,
	onSaved,
}: {
	projectId: string;
	/** Config supplied by the host (already fetched there) — avoids a duplicate fetch. */
	config: IssueFixerConfigDto | null;
	/** True once the host has finished its config fetch (null config then means "no row yet"). */
	configLoaded: boolean;
	/** Fired after a successful save so a host can refresh derived state (e.g. enabled). */
	onSaved?: () => void;
}) {
	const [form, setForm] = useState<FormState>(DEFAULT_FORM);
	const [catalog, setCatalog] = useState<KeywordDef[]>([]);
	const [catalogLoaded, setCatalogLoaded] = useState(false);
	const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [customKeyword, setCustomKeyword] = useState("");
	const [customLabel, setCustomLabel] = useState("");
	const [customToken, setCustomToken] = useState("");

	const loading = !configLoaded || !catalogLoaded;

	// Trigger catalog is static-ish and not held by the host, so fetch it here.
	useEffect(() => {
		let cancelled = false;
		rpc.getIssueFixerKeywordCatalog()
			.then((res) => {
				if (!cancelled) setCatalog(res.keywords);
			})
			.catch(() => {
				if (!cancelled) toast("error", "Failed to load Issue Fixer trigger catalog.");
			})
			.finally(() => {
				if (!cancelled) setCatalogLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Seed the editable form from the host-provided config (re-runs after a save, when the
	// host re-fetches and passes a fresh config object).
	useEffect(() => {
		if (!configLoaded) return;
		if (config) {
			setForm({
				enabled: config.enabled,
				keywords: config.keywords.length ? config.keywords : ["agentdesk-task", "agentdesk-fix"],
				labels: config.labels,
				authMode: config.authMode,
				pollIntervalMin: config.pollIntervalMin,
				autonomy: config.autonomy,
				testCommand: config.testCommand,
				customInstructions: config.customInstructions,
				tokenSource: config.tokenSource,
				cooldownSec: config.cooldownSec,
				maxPerHour: config.maxPerHour,
				notifyChannels: config.notifyChannels,
			});
			setLastPolledAt(config.lastPolledAt);
		}
		setDirty(false);
	}, [config, configLoaded]);

	function update<K extends keyof FormState>(key: K, value: FormState[K]) {
		setForm((p) => ({ ...p, [key]: value }));
		setDirty(true);
	}

	function toggleKeyword(kw: string) {
		setForm((p) => ({
			...p,
			keywords: p.keywords.includes(kw) ? p.keywords.filter((k) => k !== kw) : [...p.keywords, kw],
		}));
		setDirty(true);
	}

	function addCustomKeyword() {
		const kw = customKeyword.trim().toLowerCase();
		if (!kw) return;
		if (!kw.startsWith("agentdesk-")) {
			toast("error", "Keywords must start with \"agentdesk-\".");
			return;
		}
		if (!form.keywords.includes(kw)) update("keywords", [...form.keywords, kw]);
		setCustomKeyword("");
	}

	function addLabel() {
		const l = customLabel.trim().toLowerCase();
		if (!l) return;
		if (!l.startsWith("agentdesk-")) {
			toast("error", "Labels must start with \"agentdesk-\".");
			return;
		}
		if (!form.labels.includes(l)) update("labels", [...form.labels, l]);
		setCustomLabel("");
	}

	const handleSave = useCallback(async () => {
		setSaving(true);
		try {
			if (form.tokenSource === "custom" && customToken.trim()) {
				await rpc.saveProjectSetting(projectId, "githubToken", customToken.trim());
			}
			await rpc.saveIssueFixerConfig(projectId, form);
			setDirty(false);
			setCustomToken("");
			toast("success", "Issue Fixer settings saved.");
			onSaved?.();
		} catch {
			toast("error", "Failed to save Issue Fixer settings.");
		} finally {
			setSaving(false);
		}
	}, [form, customToken, projectId, onSaved]);

	if (loading) {
		return <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">Loading…</div>;
	}

	const isPredefined = (kw: string) => catalog.some((c) => c.keyword === kw);

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<CardTitle>Automatic Issue Fixing</CardTitle>
					<CardDescription>
						Poll this project's GitHub repo for issues/comments and let the Issue Fixer agent open
						a pull request automatically. It never merges — humans review and merge.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					<Row label="Enabled" description="Master switch for this project.">
						<Switch checked={form.enabled} onCheckedChange={(v) => update("enabled", v)} />
					</Row>
					<Separator />
					<Row label="Poll interval">
						<Select
							value={String(form.pollIntervalMin)}
							onValueChange={(v) => update("pollIntervalMin", parseInt(v, 10))}
						>
							<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
							<SelectContent>
								{POLL_OPTIONS.map((o) => (
									<SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Row>
					<Separator />
					<Row label="Last polled">
						<span className="text-sm text-muted-foreground">{lastPolledAt ?? "Never"}</span>
					</Row>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Triggers</CardTitle>
					<CardDescription>
						Issue Fixer only runs when a trigger matches in the issue <strong>title</strong> or an
						authorized <strong>comment</strong> (never the issue body), or via a trigger label.
						All trigger keywords/labels must be prefixed <code>agentdesk-</code> (case-insensitive).
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					<Row label="Trigger keywords" description="Click to enable/disable. Each is real work that produces a branch + PR.">
						<div className="space-y-3">
							<div className="flex flex-wrap gap-2">
								{catalog.map((k) => (
									<button
										key={k.keyword}
										type="button"
										onClick={() => toggleKeyword(k.keyword)}
										title={k.description}
										className={cn(
											"rounded-md border px-2 py-1 text-xs transition-colors",
											form.keywords.includes(k.keyword)
												? "border-primary bg-primary/10 text-foreground"
												: "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60",
										)}
									>
										{k.keyword}
									</button>
								))}
							</div>
							{form.keywords.some((k) => !isPredefined(k)) && (
								<div className="flex flex-wrap gap-2">
									{form.keywords.filter((k) => !isPredefined(k)).map((k) => (
										<Badge key={k} variant="secondary" className="cursor-pointer" onClick={() => toggleKeyword(k)}>
											{k} ✕
										</Badge>
									))}
								</div>
							)}
							<div className="flex gap-2">
								<Input
									value={customKeyword}
									onChange={(e) => setCustomKeyword(e.target.value)}
									onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addCustomKeyword())}
									placeholder="agentdesk-custom"
									className="font-mono text-xs"
								/>
								<Button type="button" variant="outline" onClick={addCustomKeyword}>Add</Button>
							</div>
						</div>
					</Row>
					<Separator />
					<Row label="Trigger labels" description="An agentdesk-* label on an issue (permission-gated — recommended).">
						<div className="space-y-2">
							<div className="flex flex-wrap gap-2">
								{form.labels.map((l) => (
									<Badge key={l} variant="secondary" className="cursor-pointer" onClick={() => update("labels", form.labels.filter((x) => x !== l))}>
										{l} ✕
									</Badge>
								))}
							</div>
							<div className="flex gap-2">
								<Input
									value={customLabel}
									onChange={(e) => setCustomLabel(e.target.value)}
									onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addLabel())}
									placeholder="agentdesk-fix"
									className="font-mono text-xs"
								/>
								<Button type="button" variant="outline" onClick={addLabel}>Add</Button>
							</div>
						</div>
					</Row>
					<Separator />
					<Row label="Authorization" description="Who may trigger a run." help={AUTH_HELP}>
						<Select value={form.authMode} onValueChange={(v) => update("authMode", v as FormState["authMode"])}>
							<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
							<SelectContent>
								<SelectItem value="both">Collaborators (keywords) or label</SelectItem>
								<SelectItem value="collab">Collaborators only (keywords)</SelectItem>
								<SelectItem value="label">Label-gated only</SelectItem>
							</SelectContent>
						</Select>
					</Row>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Behaviour</CardTitle>
				</CardHeader>
				<CardContent className="space-y-5">
					<Row label="Autonomy" description="branch + PR is the safe default. Never auto-merges." help={AUTONOMY_HELP}>
						<Select value={form.autonomy} onValueChange={(v) => update("autonomy", v as FormState["autonomy"])}>
							<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
							<SelectContent>
								<SelectItem value="branch_pr">Branch + PR (no merge)</SelectItem>
								<SelectItem value="draft">Dry-run / Draft PR</SelectItem>
							</SelectContent>
						</Select>
					</Row>
					<Separator />
					<Row label="Test / build command" description="Run as a gate before opening a non-draft PR. Leave blank to skip.">
						<Input
							value={form.testCommand ?? ""}
							onChange={(e) => update("testCommand", e.target.value || null)}
							placeholder="npm test"
							className="font-mono text-xs"
						/>
					</Row>
					<Separator />
					<Row label="Custom instructions" description="Repo conventions injected into the agent prompt.">
						<Textarea
							value={form.customInstructions ?? ""}
							onChange={(e) => update("customInstructions", e.target.value || null)}
							rows={3}
							placeholder="e.g. Always add a test. Follow the existing code style."
						/>
					</Row>
					<Separator />
					<Row label="Cooldown (seconds)" description="Minimum gap between runs.">
						<Input
							type="number"
							min={0}
							value={form.cooldownSec}
							onChange={(e) => update("cooldownSec", Math.max(0, parseInt(e.target.value, 10) || 0))}
						/>
					</Row>
					<Separator />
					<Row label="Max fixes per hour">
						<Input
							type="number"
							min={1}
							value={form.maxPerHour}
							onChange={(e) => update("maxPerHour", Math.max(1, parseInt(e.target.value, 10) || 1))}
						/>
					</Row>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>GitHub Token</CardTitle>
					<CardDescription>Used to read issues and open the PR.</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					<Row label="Token source">
						<Select value={form.tokenSource} onValueChange={(v) => update("tokenSource", v as FormState["tokenSource"])}>
							<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
							<SelectContent>
								<SelectItem value="global">Use global default (Settings → GitHub)</SelectItem>
								<SelectItem value="custom">Custom token for this project</SelectItem>
							</SelectContent>
						</Select>
					</Row>
					{form.tokenSource === "custom" && (
						<>
							<Separator />
							<Row label="Custom token" description="Stored per-project. Leave blank to keep the existing one.">
								<Input
									type="password"
									value={customToken}
									onChange={(e) => setCustomToken(e.target.value)}
									placeholder="ghp_…"
									className="font-mono text-xs"
								/>
							</Row>
						</>
					)}
				</CardContent>
			</Card>

			<p className="text-xs text-muted-foreground">
				Run summaries are sent to all connected channels (Discord/email) on success and failure.
			</p>

			<div className="flex items-center justify-end gap-3">
				<p className={cn("text-xs text-muted-foreground transition-opacity", dirty ? "opacity-100" : "opacity-0")}>
					You have unsaved changes.
				</p>
				<Button onClick={handleSave} disabled={saving || !dirty}>
					{saving ? "Saving…" : "Save Issue Fixer Settings"}
				</Button>
			</div>
		</div>
	);
}
