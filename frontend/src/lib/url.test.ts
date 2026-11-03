import { describe, expect, it } from "vitest";
import type { PlanInput } from "../api/schema";
import { readTrip, writeTrip } from "./url";

const input: PlanInput = {
  origin: { lat: 41.8781, lon: -87.6298, label: "Chicago, IL" },
  destination: { lat: 33.749, lon: -84.388, label: "Atlanta, GA" },
  departure: "2026-11-04T08:00",
  load_lb: 42_000,
  interval_mi: 10,
  hours_of_service: false,
};

describe("trip links", () => {
  it("read back what they wrote, with the departure as an instant", () => {
    const trip = readTrip(writeTrip(input, "2026-11-04T08:00-06:00"));
    expect(trip.origin).toEqual(input.origin);
    expect(trip.destination).toEqual(input.destination);
    expect(trip.departure).toBe(Date.parse("2026-11-04T14:00:00Z"));
    expect(trip.load_lb).toBe(42_000);
    expect(trip.interval_mi).toBe(10);
    expect(trip.hours_of_service).toBe(false);
  });

  it("keep commas inside place names", () => {
    const trip = readTrip(
      writeTrip({ ...input, origin: { ...input.origin, label: "Gary, IN, USA" } }, "2026-11-04T08:00-06:00"),
    );
    expect(trip.origin?.label).toBe("Gary, IN, USA");
  });

  it("ignore what does not parse or is out of range", () => {
    const trip = readTrip("?from=91,10,X&to=abc&depart=soon&load=90000&every=15&hos=0");
    expect(trip).toEqual({ hours_of_service: false });
  });

  it("name a bare point by its coordinates", () => {
    expect(readTrip("?from=40.1,-100.2,").origin).toEqual({ lat: 40.1, lon: -100.2, label: "40.1000, -100.2000" });
  });
});
