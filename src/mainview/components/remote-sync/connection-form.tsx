import { useState, useEffect, useCallback } from "react";
import { rpc } from "@/lib/rpc";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Loader2, CheckCircle2, XCircle, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
	RemoteSyncConfigDto,
	RemoteSyncConfigInput,
	RemoteProtocol,
	RemoteAuthType,
} from "../../../shared/rpc/remote-sync";

function Row({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
	return (
		<div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(240px,300px)_1fr]">
			<div className="space-y-1 pr-4">
				<Label>{label}</Label>
				{description && <p className="text-xs text-muted-foreground">{description}</p>}
			</div>
			<div className="w-full max-w-lg">{children}</div>
		</div>
	);
}

const DEFAULT_PORT: Record<RemoteProtocol, number> = { sftp: 22, ftp: 21, ftps: 21 };

export function RemoteConnectionForm({
	projectId,
	config,
	onSaved,
}: {
	projectId: string;
	config: RemoteSyncConfigDto | null;
	onSaved: (config: RemoteSyncConfigDto) => void;
}) {
	const [enabled, setEnabled] = useState(false);
	const [protocol, setProtocol] = useState<RemoteProtocol>("sftp");
	const [host, setHost] = useState("");
	const [port, setPort] = useState(22);
	const [username, setUsername] = useState("");
	const [authType, setAuthType] = useState<RemoteAuthType>("password");
	const [remoteBasePath, setRemoteBasePath] = useState("/");
	const [localSubdir, setLocalSubdir] = useState("");
	const [rejectUnauthorized, setRejectUnauthorized] = useState(false);
	const [excludePatterns, setExcludePatterns] = useState<string[]>([]);
	const [excludeInput, setExcludeInput] = useState("");
	const [forgettingKey, setForgettingKey] = useState(false);
	// Secrets: empty string = "unchanged"; the DTO tells us if one is already saved.
	const [password, setPassword] = useState("");
	const [privateKey, setPrivateKey] = useState("");
	const [passphrase, setPassphrase] = useState("");
	const [portTouched, setPortTouched] = useState(false);

	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
	const [dirty, setDirty] = useState(false);

	// Seed from config.
	useEffect(() => {
		if (!config) return;
		setEnabled(config.enabled);
		setProtocol(config.protocol);
		setHost(config.host);
		setPort(config.port);
		setUsername(config.username);
		setAuthType(config.authType);
		setRemoteBasePath(config.remoteBasePath);
		setLocalSubdir(config.localSubdir);
		setRejectUnauthorized(config.rejectUnauthorized);
		setExcludePatterns(config.excludePatterns);
		setPassword("");
		setPrivateKey("");
		setPassphrase("");
		setDirty(false);
		setPortTouched(true); // existing config — don't auto-rewrite the saved port
	}, [config]);

	const touch = () => setDirty(true);

	// Auto-fill the default port when switching protocol (unless the user set one).
	const onProtocolChange = (p: RemoteProtocol) => {
		setProtocol(p);
		if (!portTouched) setPort(DEFAULT_PORT[p]);
		if (p !== "sftp") setAuthType("password"); // key auth is SFTP-only
		touch();
	};

	const buildInput = useCallback((): RemoteSyncConfigInput => {
		const input: RemoteSyncConfigInput = {
			enabled,
			protocol,
			host,
			port,
			username,
			authType,
			remoteBasePath,
			localSubdir,
			rejectUnauthorized,
			excludePatterns,
		};
		// Only send secrets the user actually typed (empty = keep existing).
		if (password) input.password = password;
		if (authType === "key") {
			if (privateKey) input.privateKey = privateKey;
			if (passphrase) input.passphrase = passphrase;
		}
		return input;
	}, [enabled, protocol, host, port, username, authType, remoteBasePath, localSubdir, rejectUnauthorized, excludePatterns, password, privateKey, passphrase]);

	const addExclude = (raw: string) => {
		const p = raw.trim();
		if (!p) return;
		if (!excludePatterns.includes(p)) { setExcludePatterns([...excludePatterns, p]); touch(); }
		setExcludeInput("");
	};
	const removeExclude = (p: string) => { setExcludePatterns(excludePatterns.filter((x) => x !== p)); touch(); };

	const forgetHostKey = useCallback(async () => {
		setForgettingKey(true);
		try {
			const res = await rpc.saveRemoteSyncConfig(projectId, { hostKeyFingerprint: null });
			onSaved(res.config);
			toast("success", "Forgot the saved host key. It will be re-trusted on the next connection.");
		} catch {
			toast("error", "Failed to forget the host key.");
		} finally {
			setForgettingKey(false);
		}
	}, [projectId, onSaved]);

	// Fetch + fill a saved secret on explicit reveal (eye icon while the field is empty).
	const revealSecret = useCallback(
		async (which: "password" | "passphrase") => {
			try {
				const res = await rpc.revealRemoteSyncSecret(projectId);
				if (which === "password" && res.password) setPassword(res.password);
				if (which === "passphrase" && res.passphrase) setPassphrase(res.passphrase);
			} catch {
				/* ignore — leave field empty */
			}
		},
		[projectId],
	);

	const save = useCallback(async (): Promise<RemoteSyncConfigDto | null> => {
		setSaving(true);
		try {
			const res = await rpc.saveRemoteSyncConfig(projectId, buildInput());
			setDirty(false);
			setPassword("");
			setPrivateKey("");
			setPassphrase("");
			onSaved(res.config);
			return res.config;
		} catch {
			toast("error", "Failed to save connection settings.");
			return null;
		} finally {
			setSaving(false);
		}
	}, [projectId, buildInput, onSaved]);

	const saveAndTest = useCallback(async () => {
		const saved = await save();
		if (!saved) return;
		setTesting(true);
		setTestResult(null);
		try {
			const res = await rpc.testRemoteConnection(projectId);
			setTestResult({ ok: res.ok, text: res.ok ? res.message ?? "Connected." : res.error ?? "Connection failed." });
		} catch {
			setTestResult({ ok: false, text: "Connection test failed." });
		} finally {
			setTesting(false);
		}
	}, [projectId, save]);

	return (
		<div className="space-y-5">
			<Row label="Protocol" description="SFTP (over SSH) or FTP / FTPS.">
				<Select value={protocol} onValueChange={(v) => onProtocolChange(v as RemoteProtocol)}>
					<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
					<SelectContent>
						<SelectItem value="sftp">SFTP (SSH)</SelectItem>
						<SelectItem value="ftp">FTP (plain)</SelectItem>
						<SelectItem value="ftps">FTPS (FTP over TLS)</SelectItem>
					</SelectContent>
				</Select>
			</Row>
			<Separator />

			<Row label="Host">
				<Input value={host} onChange={(e) => { setHost(e.target.value); touch(); }} placeholder="example.com or 203.0.113.5" />
			</Row>
			<Separator />

			<Row label="Port">
				<Input
					type="number"
					min={1}
					max={65535}
					value={port}
					onChange={(e) => { setPort(Math.max(1, parseInt(e.target.value, 10) || DEFAULT_PORT[protocol])); setPortTouched(true); touch(); }}
					className="w-32"
				/>
			</Row>
			<Separator />

			<Row label="Username">
				<Input value={username} onChange={(e) => { setUsername(e.target.value); touch(); }} placeholder="deploy" />
			</Row>
			<Separator />

			{protocol === "sftp" && (
				<>
					<Row label="Authentication">
						<Select value={authType} onValueChange={(v) => { setAuthType(v as RemoteAuthType); touch(); }}>
							<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
							<SelectContent>
								<SelectItem value="password">Password</SelectItem>
								<SelectItem value="key">Private key</SelectItem>
							</SelectContent>
						</Select>
					</Row>
					<Separator />
				</>
			)}

			{authType === "password" ? (
				<Row label="Password" description={config?.hasPassword ? "Saved — blank keeps it." : undefined}>
					<PasswordInput
						value={password}
						onChange={(e) => { setPassword(e.target.value); touch(); }}
						onReveal={() => revealSecret("password")}
						placeholder={config?.hasPassword ? "•••••••• (saved)" : "Password"}
						className="font-mono"
					/>
				</Row>
			) : (
				<>
					<Row label="Private key" description={config?.hasPrivateKey ? "A key is saved. Leave blank to keep it." : "Paste the PEM private key."}>
						<Textarea
							value={privateKey}
							onChange={(e) => { setPrivateKey(e.target.value); touch(); }}
							rows={4}
							placeholder={config?.hasPrivateKey ? "(saved — paste to replace)" : "-----BEGIN OPENSSH PRIVATE KEY-----"}
							className="font-mono text-xs"
						/>
					</Row>
					<Separator />
					<Row label="Key passphrase" description={config?.hasPassphrase ? "Saved — blank keeps it." : "Optional."}>
						<PasswordInput
							value={passphrase}
							onChange={(e) => { setPassphrase(e.target.value); touch(); }}
							onReveal={() => revealSecret("passphrase")}
							placeholder={config?.hasPassphrase ? "•••••••• (saved)" : "Optional"}
							className="font-mono"
						/>
					</Row>
				</>
			)}
			<Separator />

			<Row label="Remote directory" description="The starting directory on the server. Browsing begins here and selected files sync relative to it.">
				<Input value={remoteBasePath} onChange={(e) => { setRemoteBasePath(e.target.value); touch(); }} placeholder="/var/www/app" className="font-mono text-sm" />
			</Row>
			<Separator />

			<Row label="Local directory" description="Optional folder under the project workspace to store files in (blank = workspace root).">
				<Input value={localSubdir} onChange={(e) => { setLocalSubdir(e.target.value); touch(); }} placeholder="(workspace root)" className="font-mono text-sm" />
			</Row>
			<Separator />

			{protocol === "ftps" && (
				<>
					<Row label="Verify TLS certificate" description="On: reject self-signed/invalid certs (recommended for public servers). Off: tolerate them (common for internal servers).">
						<Switch checked={rejectUnauthorized} onCheckedChange={(v) => { setRejectUnauthorized(v); touch(); }} />
					</Row>
					<Separator />
				</>
			)}

			{protocol === "sftp" && (
				<>
					<Row label="Host key" description="The server's SSH identity, pinned on first connection to guard against impersonation.">
						{config?.hostKeyFingerprint ? (
							<div className="space-y-2">
								<div className="flex items-center gap-2 text-sm">
									<ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500" />
									<span className="break-all font-mono text-xs">{config.hostKeyFingerprint}</span>
								</div>
								<Button type="button" variant="outline" size="sm" onClick={forgetHostKey} disabled={forgettingKey}>
									{forgettingKey ? "Forgetting…" : "Forget / re-trust"}
								</Button>
							</div>
						) : (
							<p className="text-sm text-muted-foreground">
								Not yet trusted — the host key will be pinned on the first successful connection.
							</p>
						)}
					</Row>
					<Separator />
				</>
			)}

			<Row label="Exclude patterns" description="Skip matching files/folders on pull and push (e.g. node_modules, *.log). A name with no slash matches at any depth.">
				<div className="space-y-2">
					<div className="flex flex-wrap gap-1.5">
						{excludePatterns.map((p) => (
							<Badge key={p} variant="secondary" className="cursor-pointer font-mono text-xs" onClick={() => removeExclude(p)} title="Remove">
								{p} ✕
							</Badge>
						))}
						{excludePatterns.length === 0 && <span className="text-xs text-muted-foreground">None — everything in your selection syncs.</span>}
					</div>
					<div className="flex gap-2">
						<Input
							value={excludeInput}
							onChange={(e) => setExcludeInput(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addExclude(excludeInput))}
							placeholder="node_modules"
							className="font-mono text-xs"
						/>
						<Button type="button" variant="outline" onClick={() => addExclude(excludeInput)}>Add</Button>
					</div>
					<div className="flex flex-wrap gap-1.5">
						{["node_modules", ".git", ".DS_Store", "*.log", "dist", "build"].filter((p) => !excludePatterns.includes(p)).map((p) => (
							<button
								key={p}
								type="button"
								onClick={() => addExclude(p)}
								className="rounded border border-dashed border-border px-2 py-0.5 font-mono text-xs text-muted-foreground hover:bg-muted/60"
							>
								+ {p}
							</button>
						))}
					</div>
				</div>
			</Row>

			{testResult && (
				<div className={cn("flex items-start gap-2 rounded-md border p-3 text-sm", testResult.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-destructive/30 bg-destructive/10 text-destructive")}>
					{testResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
					<span className="break-words">{testResult.text}</span>
				</div>
			)}

			<div className="flex items-center justify-end gap-3 pt-2">
				<p className={cn("text-xs text-muted-foreground transition-opacity", dirty ? "opacity-100" : "opacity-0")}>Unsaved changes.</p>
				<Button variant="outline" onClick={saveAndTest} disabled={saving || testing || !host}>
					{testing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
					Save & test
				</Button>
				<Button onClick={save} disabled={saving || !dirty}>
					{saving ? "Saving…" : "Save connection"}
				</Button>
			</div>
		</div>
	);
}
