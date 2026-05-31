import { sqlite } from "../db/connection";

// ---------------------------------------------------------------------------
// Table allowlist — only these tables are exposed. System tables, credential
// stores, and internal audit tables are excluded.
// ---------------------------------------------------------------------------

const ALLOWED_TABLES: Record<string, { displayName: string; deletable: boolean }> = {
	// User-managed content — deletable
	kanban_tasks:             { displayName: "Kanban Tasks",             deletable: true  },
	notes:                    { displayName: "Docs",                     deletable: true  },
	prompts:                  { displayName: "Prompts",                  deletable: true  },
	inbox_messages:           { displayName: "Inbox Messages",           deletable: true  },
	cron_jobs:                { displayName: "Cron Jobs",                deletable: true  },
	automation_rules:         { displayName: "Automation Rules",         deletable: true  },
	deploy_history:           { displayName: "Deploy History",           deletable: true  },
	pull_requests:            { displayName: "Pull Requests",            deletable: true  },
	pr_comments:              { displayName: "PR Comments",              deletable: true  },
	github_issues:            { displayName: "GitHub Issues",            deletable: true  },
	webhook_events:           { displayName: "Webhook Events",           deletable: true  },
	cost_budgets:             { displayName: "Cost Budgets",             deletable: true  },
	inbox_rules:              { displayName: "Inbox Rules",              deletable: true  },
	notification_preferences: { displayName: "Notification Preferences", deletable: true  },
	audit_log:                { displayName: "Audit Log",                deletable: true  },

	// Read-only reference data — shown but not deletable
	projects:             { displayName: "Projects",             deletable: false },
	agents:               { displayName: "Agents",               deletable: false },
	conversations:        { displayName: "Conversations",        deletable: false },
	messages:             { displayName: "Messages",             deletable: false },
	message_parts:        { displayName: "Message Parts",        deletable: false },
	deploy_environments:  { displayName: "Deploy Environments",  deletable: false },
	webhook_configs:      { displayName: "Webhook Configs",      deletable: false },
	channels:             { displayName: "Channels",             deletable: false },
	branch_strategies:    { displayName: "Branch Strategies",    deletable: false },
};

export function dbViewerGetTables() {
	return Object.entries(ALLOWED_TABLES)
		.map(([name, cfg]) => ({ name, displayName: cfg.displayName, deletable: cfg.deletable }))
		.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function dbViewerGetRows(table: string, page: number, pageSize: number) {
	if (!ALLOWED_TABLES[table]) throw new Error(`Table "${table}" is not accessible`);

	const offset = (page - 1) * pageSize;

	// Prefer created_at / createdAt for chronological ordering, fall back to rowid
	const tableColumns = (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(c => c.name);
	const orderCol = tableColumns.includes("created_at")
		? "created_at"
		: tableColumns.includes("createdAt")
			? "createdAt"
			: "rowid";

	const rows = sqlite
		.prepare(`SELECT * FROM "${table}" ORDER BY "${orderCol}" DESC LIMIT ? OFFSET ?`)
		.all(pageSize, offset) as Record<string, unknown>[];

	const countRow = sqlite
		.prepare(`SELECT COUNT(*) as count FROM "${table}"`)
		.get() as { count: number };

	// Derive column names: from first row if available, otherwise from PRAGMA
	const columns: string[] =
		rows.length > 0
			? Object.keys(rows[0])
			: (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
					(c) => c.name,
				);

	return { rows, total: countRow.count, columns };
}

export function dbViewerDeleteRow(table: string, id: string) {
	const cfg = ALLOWED_TABLES[table];
	if (!cfg) throw new Error(`Table "${table}" is not accessible`);
	if (!cfg.deletable) throw new Error(`Rows in "${table}" cannot be deleted`);

	sqlite.prepare(`DELETE FROM "${table}" WHERE id = ?`).run(id);
	return { success: true };
}
