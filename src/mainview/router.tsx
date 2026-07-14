import {
  createRouter,
  createRootRoute,
  createRoute,
  createHashHistory,
} from "@tanstack/react-router";
import { AppShell } from "./components/layout/app-shell";
import { DashboardPage } from "./pages/dashboard";
import { SettingsPage } from "./pages/settings";
import { AgentsPage } from "./pages/agents";
import { ProjectPage } from "./pages/project";
import { InboxPage } from "./pages/inbox";
import { SchedulerPage } from "./pages/scheduler";
import { AnalyticsPage } from "./pages/analytics";
import { OnboardingPage } from "./pages/onboarding";
import { PromptsPage } from "./pages/prompts";
import { CollectionsPage } from "./pages/collections";
import { SkillsPage } from "./pages/skills";
import { DbViewerPage } from "./pages/plugin-db-viewer";
import { CouncilPage } from "./pages/council";
import { FreelancePage } from "./pages/freelance";
import { PlaygroundPage } from "./pages/playground";
import { QuickChatPage } from "./pages/quick-chat";

// Use hash-based history so Electrobun's webview doesn't need a server
// for navigation. URLs look like: app://index.html#/settings
const hashHistory = createHashHistory();

// Root route — renders the AppShell layout wrapper with an <Outlet />
const rootRoute = createRootRoute({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: DashboardPage,
});

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  component: AgentsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/project/$projectId",
  component: ProjectPage,
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: InboxPage,
});

const schedulerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/scheduler",
  component: SchedulerPage,
});

const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/analytics",
  component: AnalyticsPage,
});

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingPage,
});

const promptsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/prompts",
  component: PromptsPage,
});

const collectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/collections",
  component: CollectionsPage,
});

const skillsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/skills",
  component: SkillsPage,
});

const dbViewerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plugin/db-viewer",
  component: DbViewerPage,
});

const councilRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/council",
  component: CouncilPage,
});

const freelanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/freelance",
  component: FreelancePage,
});

const playgroundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/playground",
  component: PlaygroundPage,
});

const quickChatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/quick-chat/$projectId",
  component: QuickChatPage,
});

const routeTree = rootRoute.addChildren([
  onboardingRoute,
  indexRoute,
  agentsRoute,
  settingsRoute,
  projectRoute,
  inboxRoute,
  schedulerRoute,
  skillsRoute,
  promptsRoute,
  collectionsRoute,

  analyticsRoute,
  dbViewerRoute,
  councilRoute,
  freelanceRoute,
  playgroundRoute,
  quickChatRoute,
]);

export const router = createRouter({
  routeTree,
  history: hashHistory,
});

// Register the router instance for type-safety across the app
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
