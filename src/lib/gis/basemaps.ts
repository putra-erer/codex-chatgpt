import type { Basemap } from "./types";
// Curated configuration. The browser cannot submit tile URLs to the server.
export const basemaps: Basemap[] = [
  {
    id: "light",
    name: "Light canvas",
    description: "Private canvas · no external requests",
    background: "#e8eff0",
  },
  {
    id: "dark",
    name: "Dark canvas",
    description: "Private canvas · no external requests",
    background: "#182a37",
  },
  {
    id: "osm",
    name: "OpenStreetMap",
    description: "External street map · internet required",
    background: "#e8eff0",
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
    maxZoom: 19,
  },
];
