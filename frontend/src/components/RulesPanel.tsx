import { useRules } from "../api/hooks";
import type { Scale } from "../api/schema";
import { LEVEL_COLOR } from "../lib/risk";

function Bands({ name, scale }: { name: string; scale: Scale }) {
  const f = (v: number) => (scale.decimals > 1 ? v.toFixed(2) : String(v));
  const cells = [
    { color: LEVEL_COLOR.low, text: `< ${f(scale.moderate)}` },
    { color: LEVEL_COLOR.moderate, text: `${f(scale.moderate)}–${f(scale.high)}` },
    { color: LEVEL_COLOR.high, text: `${f(scale.high)}–${f(scale.severe)}` },
    { color: LEVEL_COLOR.severe, text: `${f(scale.severe)}–${f(scale.no_travel)}` },
    { color: LEVEL_COLOR.no_travel, text: `${scale.no_travel_inclusive ? "≥" : ">"} ${f(scale.no_travel)}` },
  ];
  return (
    <tr className="border-line border-t">
      <th scope="row" className="label py-1.5 pr-2 text-left">
        {name} <span className="normal-case tracking-normal text-faint">{scale.unit}</span>
      </th>
      {cells.map((c) => (
        <td key={c.text} className="num py-1.5 pr-1 text-[11px]" style={{ boxShadow: `inset 0 2px 0 ${c.color}` }}>
          {c.text}
        </td>
      ))}
    </tr>
  );
}

/** The rules as the server applies them, read from /api/rules, and the ranking they feed. */
export function RulesPanel() {
  const rules = useRules();
  return (
    <details className="group border border-line" data-testid="rules">
      <summary className="label flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-ink">
        How routes are scored
        <span className="num text-muted group-open:rotate-45">+</span>
      </summary>
      <div className="space-y-3 border-line border-t px-3 py-3 text-[12.5px] text-muted leading-relaxed">
        {rules.data ? (
          <table className="w-full">
            <tbody>
              <Bands name="Wind" scale={rules.data.wind} />
              <Bands name="Rain" scale={rules.data.rain} />
              <Bands name="Snow" scale={rules.data.snow} />
            </tbody>
          </table>
        ) : null}
        <p>
          Each band includes its lower bound. The worst condition sets a checkpoint's level, after the load rules: with
          more than 30,000 lb aboard, 45–54 mph is No Travel; with more than 40,000 lb, 35–44 mph is Severe.
        </p>
        <p>
          Weather is read at the moment the truck reaches each checkpoint: wind and temperature interpolated between
          forecast hours, rain, snow and gusts from the hour that contains the arrival. Each checkpoint stands for the
          road halfway to its neighbours, which turns levels into miles.
        </p>
        <p>
          Routes rank by fewest No Travel miles, then Severe miles, High miles, the lowest mile-weighted average level
          (0 Low to 4 No Travel), and finally the shortest trip. With HOS breaks on, arrival times include a 30-minute
          break after 8 hours of driving and a 10-hour rest after 11.
        </p>
      </div>
    </details>
  );
}
