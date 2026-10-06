import type { DataSource } from "./types";

// Statically resolved by Vite, so production bundles never include demo data
// and demo builds never initialise Firebase.
export const dataSource: DataSource =
  import.meta.env.VITE_DATA_SOURCE === "demo"
    ? (await import("./demoSource")).demoSource
    : (await import("./firebaseSource")).firebaseSource;

export type * from "./types";
