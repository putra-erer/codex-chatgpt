import type { VectorStyle } from "@/lib/gis/style";
import styles from "./layer-panel.module.css";

/** A compact swatch using the same fill, outline, opacity and dash as the map. */
export function LayerSymbol({ style, color = style.color }: { style: VectorStyle; color?: string }) {
  const size = style.type === "point" ? Math.max(26, (style.radius + style.strokeWidth) * 2 + 4) : 36;
  return (
    <svg className={styles.symbol} width="36" height="26" viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
      {style.type === "polygon" && <rect x="7" y="7" width="22" height="22" rx="2" fill={color} fillOpacity={style.opacity} stroke={style.strokeColor} strokeWidth={style.strokeWidth} strokeOpacity={style.strokeOpacity} />}
      {style.type === "line" && <line x1="3" y1="24" x2="33" y2="12" stroke={color} strokeWidth={style.width} strokeOpacity={style.opacity} strokeDasharray={style.dash === "dashed" ? `${style.width * 3} ${style.width * 2}` : style.dash === "dotted" ? `${style.width} ${style.width * 2}` : undefined} strokeLinecap={style.dash === "dotted" ? "round" : "butt"} />}
      {style.type === "point" && <circle cx={size / 2} cy={size / 2} r={style.radius} fill={color} fillOpacity={style.opacity} stroke={style.strokeColor} strokeWidth={style.strokeWidth} strokeOpacity={style.strokeOpacity} />}
    </svg>
  );
}
