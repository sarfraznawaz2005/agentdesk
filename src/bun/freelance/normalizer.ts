import he from "he";
import type { RssItem } from "./rss-fetcher";

export interface FreelanceListing {
  platform: string;
  externalId: string;
  title: string;
  description: string;
  skills: string[];
  budgetType: "fixed" | "hourly";
  budgetMin: number | null;
  budgetMax: number | null;
  currency: string;
  url: string;
  postedAt: string | null;
}

interface BudgetInfo {
  budgetMin: number | null;
  budgetMax: number | null;
  currency: string;
  budgetType: "fixed" | "hourly";
}

// Parses "Budget: $30 - $250 AUD" or "Budget: $500 USD/hr" from description text.
function parseBudget(text: string): BudgetInfo {
  const rangeMatch = /Budget:\s*\$?([\d,]+)\s*[-–]\s*\$?([\d,]+)\s*([A-Z]{2,4})(\/hr)?/i.exec(text);
  if (rangeMatch) {
    return {
      budgetMin: parseInt(rangeMatch[1].replace(/,/g, ""), 10),
      budgetMax: parseInt(rangeMatch[2].replace(/,/g, ""), 10),
      currency: rangeMatch[3].toUpperCase(),
      budgetType: rangeMatch[4] ? "hourly" : "fixed",
    };
  }
  const singleMatch = /Budget:\s*\$?([\d,]+)\s*([A-Z]{2,4})(\/hr)?/i.exec(text);
  if (singleMatch) {
    const amount = parseInt(singleMatch[1].replace(/,/g, ""), 10);
    return {
      budgetMin: amount,
      budgetMax: amount,
      currency: singleMatch[2].toUpperCase(),
      budgetType: singleMatch[3] ? "hourly" : "fixed",
    };
  }
  return { budgetMin: null, budgetMax: null, currency: "USD", budgetType: "fixed" };
}

// Removes the trailing "(Budget: … Jobs: …)" metadata block Freelancer appends to descriptions.
function cleanDescription(text: string): string {
  return text.replace(/\s*\(Budget:[\s\S]*?\)\s*$/, "").trim();
}

export function normalizeRssItem(item: RssItem, sourceName: string): FreelanceListing {
  const externalId = item.guid || item.link;
  if (!externalId) {
    throw new Error(`RSS item from "${sourceName}" has no guid or link — cannot deduplicate`);
  }

  const rawDescription = he.decode(item.description);
  const budget = parseBudget(rawDescription);
  const description = cleanDescription(rawDescription);

  return {
    platform: sourceName,
    externalId,
    title: he.decode(item.title || "(no title)"),
    description,
    skills: item.categories.map((s) => he.decode(s)),
    budgetType: budget.budgetType,
    budgetMin: budget.budgetMin,
    budgetMax: budget.budgetMax,
    currency: budget.currency,
    url: item.link || externalId,
    postedAt: item.isoDate,
  };
}
