import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Rules } from "../api/schema";
import { RULES } from "./fixtures";

/** Render inside a query cache that already holds the rules, or none yet when `rules` is null. */
export function renderWithRules(ui: ReactNode, rules: Rules | null = RULES) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (rules) client.setQueryData(["rules"], rules);
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
