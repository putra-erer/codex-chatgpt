import type {
  AreaUnit,
  Coordinate,
  LengthUnit,
  MeasureMode,
} from "@/lib/gis/types";
import {
  formatArea,
  formatLength,
  lineMeters,
  polygonSquareMeters,
} from "@/lib/gis/measurement";
export function MeasurementPanel({
  mode,
  points,
  lengthUnit,
  areaUnit,
  finished,
  onLengthUnit,
  onAreaUnit,
  onUndo,
  onClear,
  onFinish,
  onRemove,
}: {
  mode: MeasureMode;
  points: Coordinate[];
  lengthUnit: LengthUnit;
  areaUnit: AreaUnit;
  finished: boolean;
  onLengthUnit: (unit: LengthUnit) => void;
  onAreaUnit: (unit: AreaUnit) => void;
  onUndo: () => void;
  onClear: () => void;
  onFinish: () => void;
  onRemove: (index: number) => void;
}) {
  if (mode === "none")
    return (
      <section className="gis-panel">
        <h2>Measure</h2>
        <p className="gis-help">
          Use the Line or Area tool above the map to choose your own points.
        </p>
      </section>
    );
  const isArea = mode === "polygon";
  const ready = points.length >= (isArea ? 3 : 2);
  return (
    <section className="gis-panel gis-measure" aria-labelledby="measure-title">
      <h2 id="measure-title">
        {isArea ? "Area measurement" : "Line measurement"}
      </h2>
      <p className="gis-help">
        {finished
          ? "Drag numbered points to adjust the shape, or continue adding points."
          : `Click the map to add ${isArea ? "at least 3" : "at least 2"} points. Drag points to adjust.`}
      </p>
      <label className="gis-unit-label">
        Unit{" "}
        {isArea ? (
          <select
            aria-label="Measurement unit"
            value={areaUnit}
            onChange={(event) => onAreaUnit(event.target.value as AreaUnit)}
          >
            <option value="m²">Square meters (m²)</option>
            <option value="ha">Hectares (ha)</option>
            <option value="km²">Square kilometers (km²)</option>
          </select>
        ) : (
          <select
            aria-label="Measurement unit"
            value={lengthUnit}
            onChange={(event) => onLengthUnit(event.target.value as LengthUnit)}
          >
            <option value="m">Meters (m)</option>
            <option value="km">Kilometers (km)</option>
          </select>
        )}
      </label>
      <output className="gis-measure-result" aria-live="polite">
        {isArea
          ? formatArea(polygonSquareMeters(points), areaUnit)
          : formatLength(lineMeters(points), lengthUnit)}
      </output>
      <p className="gis-help">
        {points.length} points ·{" "}
        {isArea
          ? "Use a polygon without crossing edges."
          : "Distance follows your selected segments."}{" "}
        Estimates on Earth’s surface; not survey measurements.
      </p>
      <div className="gis-measure-actions">
        <button type="button" disabled={!points.length} onClick={onUndo}>
          Undo point
        </button>
        <button type="button" disabled={!points.length} onClick={onClear}>
          Clear
        </button>
        <button type="button" disabled={!ready} onClick={onFinish}>
          {finished ? "Continue" : "Finish"}
        </button>
      </div>
      {points.length > 0 && (
        <details className="gis-point-details">
          <summary>Selected points ({points.length})</summary>
          <ol>
            {points.map((point, index) => (
              <li key={index}>
                <span>
                  {point[1].toFixed(5)}, {point[0].toFixed(5)}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(index)}
                  aria-label={`Remove point ${index + 1}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
