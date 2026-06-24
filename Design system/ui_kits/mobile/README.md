# Power — Mobile app (UI kit)

A high-fidelity recreation of the **Power** phone app, shown inside a 390×844 device
frame. Same dark control-room language as the desktop dashboard, tuned for a single column.

## Run
Open `index.html`. Loads React + Babel + Lucide + the compiled bundle (`../../_ds_bundle.js`),
reuses the desktop kit's mock data (`../desktop/data.js`) and charts (`../desktop/charts.jsx`),
then mounts the phone.

## Screens (bottom tab bar)
- **Home** — greeting, compact live `EnergyFlow`, KPI tiles, battery gauge, quick toggles.
- **Flow** — full energy-flow diagram + live per-node readout list.
- **Charge** — EV charge gauge, source segmented control, solar/grid mix, charge controls.
- **Stats** — range switch, KPI tiles, day chart, per-device breakdown.

## Files
- `index.html` — entry.
- `MobileApp.jsx` — phone frame, status bar, all four screens, bottom tab bar.

Built entirely from the design-system components (`window.PowerDesignSystem_138199`).
