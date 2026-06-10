// Shared key for the freelance "needs attention" unread indicator.
//
// Freelance isn't a project, but it reuses the per-project unread-activity machinery
// (project_activity table → useUnreadStore → UnreadDot) via a sentinel project id.
// The backend records activity here when an escalation is raised; the sidebar
// "Freelance" link and the freelance page's "Auto-Earn" tab both show a red dot for
// it, and opening the Auto-Earn tab marks it seen (clearing both at once).
//
// project_activity.project_id has no foreign key, so the sentinel id is safe.
export const FREELANCE_ATTENTION_PROJECT = "__freelance__";
export const FREELANCE_ATTENTION_LOCATION = "auto-earn";
