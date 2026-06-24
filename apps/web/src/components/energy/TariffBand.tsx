/** Tariff band index → 24-segment strip color. 0=P3 (solar), 1=P2 (grid-dim), 2=P1 (grid). */
const BAND_COLOR = ['var(--solar)', 'var(--grid-dim)', 'var(--grid)'];

/** Default Spain 2.0TD band pattern across 24 h (P3 night / P2 shoulder / P1 peak). */
export const DEFAULT_TARIFF_24 = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 2, 1, 1, 1, 1, 2, 2, 2, 2, 1, 1];

type Props = {
  /** 24 band indices (0/1/2). Defaults to the standard 2.0TD pattern. */
  tariff?: number[];
  /** current hour index 0–23 to highlight */
  current?: number;
  height?: number;
};

/** TariffBand — the 24-segment P1/P2/P3 strip used under the tariff readout. */
export function TariffBand({ tariff = DEFAULT_TARIFF_24, current, height = 8 }: Props) {
  return (
    <div className="tband" style={{ height }}>
      {tariff.map((b, i) => (
        <i key={i} style={{ background: BAND_COLOR[b], opacity: i === current ? 1 : 0.5 }} />
      ))}
    </div>
  );
}
