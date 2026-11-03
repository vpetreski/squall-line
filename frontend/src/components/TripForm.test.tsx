import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../state/store";
import { renderWithRules } from "../test/render";
import { TripForm } from "./TripForm";

const initial = useStore.getState();

beforeEach(() => {
  useStore.setState(initial, true);
  // Place search and the planner never answer here: the tests are about what the fields show.
  vi.stubGlobal("fetch", () => new Promise(() => undefined));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("place fields", () => {
  it("show a sample trip's places over text being typed", async () => {
    renderWithRules(<TripForm />);
    await userEvent.type(screen.getByTestId("origin"), "Den");
    await userEvent.click(screen.getByRole("button", { name: "Chicago → Atlanta" }));
    expect(screen.getByTestId("origin")).toHaveValue("Chicago, IL");
    expect(screen.getByTestId("destination")).toHaveValue("Atlanta, GA");
  });

  it("show the swapped place over text being typed", async () => {
    useStore.getState().setInput({ destination: { lat: 33.749, lon: -84.388, label: "Atlanta, GA" } });
    renderWithRules(<TripForm />);
    await userEvent.type(screen.getByTestId("origin"), "Den");
    await userEvent.click(screen.getByRole("button", { name: "Swap origin and destination" }));
    expect(screen.getByTestId("origin")).toHaveValue("Atlanta, GA");
  });

  it("show the recorded storm's places over text being typed", async () => {
    renderWithRules(<TripForm />);
    await userEvent.type(screen.getByTestId("destination"), "Den");
    await userEvent.click(screen.getByRole("button", { name: "Recorded storm · 3 Nov" }));
    await vi.waitFor(() => expect(screen.getByTestId("destination")).toHaveValue("Atlanta, GA"));
    expect(screen.getByTestId("origin")).toHaveValue("Chicago, IL");
  });

  it("keep what is typed while no place is chosen", async () => {
    useStore.getState().setInput({ origin: { lat: 41.8781, lon: -87.6298, label: "Chicago, IL" } });
    renderWithRules(<TripForm />);
    const origin = screen.getByTestId("origin");
    await userEvent.clear(origin);
    await userEvent.type(origin, "Den");
    expect(origin).toHaveValue("Den");
    expect(useStore.getState().input.origin.lat).toBeNaN();
  });
});
