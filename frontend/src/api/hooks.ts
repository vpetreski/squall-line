import { useQuery } from "@tanstack/react-query";
import { DECIMALS, type Decimals } from "../lib/risk";
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

/** The precision each scale is classified at, from the rules once they arrive. */
export function useDecimals(): Decimals {
  const rules = useRules().data;
  return rules ? { wind: rules.wind.decimals, rain: rules.rain.decimals, snow: rules.snow.decimals } : DECIMALS;
}
