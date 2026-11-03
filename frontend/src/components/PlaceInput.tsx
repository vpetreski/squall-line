import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { geocode } from "../api/client";
import type { Suggestion } from "../api/schema";

export type Place = { lat: number; lon: number; label: string; time_zone?: string };

const isSet = (p: Place) => Number.isFinite(p.lat) && Number.isFinite(p.lon);

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** A type-ahead place field (an ARIA combobox): US places, addresses and points of interest, or "lat, lon". */
export function PlaceInput({
  label,
  value,
  onChange,
  placeholder,
  testId,
}: {
  label: string;
  value: Place;
  onChange: (place: Place) => void;
  placeholder: string;
  testId: string;
}) {
  const id = useId();
  const [text, setText] = useState(value.label);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const typed = useRef(false);
  const query = useDebounced(text.trim(), 180);

  // Typing clears the place, so a place arriving while the field holds typed text was set from outside (a sample
  // trip, the swap, the recorded storm): it replaces the typed text.
  const placed = isSet(value);
  useEffect(() => {
    if (placed) typed.current = false;
    if (!typed.current) setText(value.label);
  }, [placed, value.label]);

  const search = useQuery({
    queryKey: ["geocode", query.toLowerCase()],
    queryFn: ({ signal }) => geocode(query, signal),
    enabled: open && typed.current && query.length >= 2,
    staleTime: 10 * 60_000,
    retry: 1,
  });
  const results = search.data ?? [];

  const choose = (s: Suggestion) => {
    typed.current = false;
    setText(s.label);
    setOpen(false);
    onChange({ lat: s.lat, lon: s.lon, label: s.label, time_zone: s.time_zone });
  };

  const listId = `${id}-list`;
  const showList = open && typed.current && query.length >= 2;

  return (
    <div className="relative">
      <label htmlFor={id} className="label mb-1.5 flex items-center justify-between">
        <span>{label}</span>
        {isSet(value) ? (
          <span className="num normal-case tracking-normal text-faint">
            {value.lat.toFixed(3)}, {value.lon.toFixed(3)}
          </span>
        ) : null}
      </label>
      <input
        id={id}
        data-testid={testId}
        className="field"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && results[active] ? `${id}-opt-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={text}
        onChange={(event) => {
          typed.current = true;
          setText(event.target.value);
          setActive(0);
          setOpen(true);
          if (isSet(value)) onChange({ lat: Number.NaN, lon: Number.NaN, label: event.target.value });
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(event) => {
          if (!showList || results.length === 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((a) => (a + 1) % results.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((a) => (a - 1 + results.length) % results.length);
          } else if (event.key === "Enter") {
            const pick = results[active];
            if (pick) {
              event.preventDefault();
              choose(pick);
            }
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {showList ? (
        <div
          id={listId}
          role="listbox"
          aria-label={`${label} suggestions`}
          className="absolute z-30 mt-px w-full border border-line-strong bg-panel shadow-[6px_6px_0_rgba(0,0,0,0.55)]"
        >
          {search.isError ? (
            <div className="px-3 py-2.5 text-[12px] text-severe">Place search is not answering. Type "lat, lon".</div>
          ) : results.length === 0 ? (
            <div className="label px-3 py-2.5 normal-case tracking-normal">
              {search.isFetching ? "Searching…" : "No US place matches."}
            </div>
          ) : (
            results.map((s, i) => (
              <div
                key={`${s.label}|${s.detail}|${s.lat}`}
                id={`${id}-opt-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                className={`flex cursor-pointer items-baseline justify-between gap-3 border-line border-t px-3 py-2 first:border-t-0 ${i === active ? "bg-raise" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(s);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="truncate text-[13px] text-ink">{s.label}</span>
                <span className="label shrink-0 normal-case tracking-normal">{s.detail || s.kind}</span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
