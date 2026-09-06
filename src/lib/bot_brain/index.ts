// The game-agnostic bot brain (ARCHITECTURE.md, "Bots and navigation": the
// brain is written as a game-agnostic module so it can be fed back into
// quake-2-re-ts, which has the nav loader and the game-side adapter but no
// decision-making). A file under src/lib imports nothing from src/ outside
// src/lib, so nothing here knows what a Quake edict is; the Quake 1 binding
// lives in src/bots.

export * from "./math";
export * from "./rng";
export * from "./nav_graph";
export * from "./world";
export * from "./knowledge";
export * from "./aim";
export * from "./senses";
export * from "./path_follow";
export * from "./brain";
