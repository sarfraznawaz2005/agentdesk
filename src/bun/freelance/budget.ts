// Shared budget formatting utility for freelance listings.
// Used by freelance-wizard, freelance-chat, and the approve flow.

export function formatBudget(
  budgetMin: number | null,
  budgetMax: number | null,
  budgetType: string,
  currency: string,
): string {
  const sym = currency === "USD" ? "$" : currency;
  const suffix = budgetType === "hourly" ? "/hr" : "";
  if (budgetMin !== null && budgetMax !== null)
    return `${sym}${budgetMin.toLocaleString()}–${sym}${budgetMax.toLocaleString()}${suffix} (${budgetType})`;
  if (budgetMin !== null)
    return `${sym}${budgetMin.toLocaleString()}+${suffix} (${budgetType})`;
  if (budgetMax !== null)
    return `Up to ${sym}${budgetMax.toLocaleString()}${suffix} (${budgetType})`;
  return "Not specified";
}
