import type { Basemap } from "@/lib/gis/types";
export function BasemapPanel({
  basemaps,
  selected,
  onSelect,
}: {
  basemaps: Basemap[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <fieldset className="gis-panel gis-basemaps">
      <legend>Basemap</legend>
      {basemaps.map((basemap) => (
        <label
          key={basemap.id}
          className={selected === basemap.id ? "selected" : ""}
        >
          <input
            type="radio"
            name="basemap"
            value={basemap.id}
            checked={selected === basemap.id}
            onChange={() => onSelect(basemap.id)}
          />
          <span
            className={`gis-basemap-swatch ${basemap.tiles ? "streets" : ""}`}
            style={{ backgroundColor: basemap.background }}
            aria-hidden="true"
          />
          <span>
            <strong>{basemap.name}</strong>
            <small>{basemap.description}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
