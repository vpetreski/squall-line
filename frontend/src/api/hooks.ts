import { useQuery } from "@tanstack/react-query";
import { getRules } from "./client";

/** The published risk rules: fetched once, shared by the legend, the rules panel and the heatmap. */
export function useRules() {
  return useQuery({
    queryKey: ["rules"],
    queryFn: ({ signal }) => getRules(signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 2,
  });
}
