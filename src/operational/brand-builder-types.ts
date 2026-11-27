export type BrandFace = "both" | "neither" | "first" | "second" | "first-contradiction" | "second-contradiction";
export type BrandLayout = "split" | "poster" | "editorial";
export type BrandTypeStyle = "modern" | "serif" | "condensed" | "mono";

export interface BrandTheme {
  paper: string;
  ink: string;
  accent: string;
  layout: BrandLayout;
  typeStyle: BrandTypeStyle;
  direction: string;
}

export interface BrandPreview {
  headline: string;
  copy: string;
  action: string;
  imagery: string;
}

export interface BrandDirection {
  id: string;
  title: string;
  thesis: string;
  payoff: string;
  tradeoff: string;
  proof: string;
  focus: BrandFace;
  preview: BrandPreview;
  theme: BrandTheme;
}

export interface BrandSourceRecord {
  id: string;
  label: string;
  url: string;
  excerpt: string;
  kind: "project" | "market";
}

export interface BrandDiscovery {
  brandName: string;
  audience: string;
  reality: string;
  unknown: string;
  axis: { domain: string; first: string; second: string; notFirst: string; notSecond: string };
  directions: BrandDirection[];
  sources: BrandSourceRecord[];
}

export interface BrandSection {
  id: string;
  text: string;
  example: string;
  sourceIds: string[];
}

export interface BrandCubeFace {
  face: BrandFace;
  story: string;
  boundary: string;
  preview: BrandPreview;
}

export interface BrandWord {
  id: string;
  face: BrandFace;
  word: string;
  meaning: string;
  application: string;
  links: { id: string; reason: string }[];
}

export interface BrandSystem {
  name: string;
  idea: string;
  theme: BrandTheme;
  sections: BrandSection[];
  faces: BrandCubeFace[];
  words: BrandWord[];
  guidelines: {
    logo: string;
    palette: string;
    type: string;
    imagery: string;
    layout: string;
    avoid: string;
    motion: string;
  };
  checks: string[];
}

export interface BrandFocus {
  face: BrandFace;
  context: string;
  reason: string;
  author: string;
  at: string;
  version: number;
}

export interface BrandLesson {
  id: string;
  section: string;
  context: string;
  verdict: "keep" | "avoid";
  example: string;
  reason: string;
  at: string;
}

export interface BrandApproval {
  version: number;
  directionId: string;
  by: string;
  at: string;
  system: BrandSystem;
  axis: BrandDiscovery["axis"];
  sources: BrandSourceRecord[];
}

export interface BrandDraft {
  brief: string;
  directionId: string;
  discovery: BrandDiscovery | null;
  system: BrandSystem | null;
  artDirectionId?: string;
  dirty: boolean;
  reviewed: string[];
  corrections?: Record<string, { text: string; example: string }>;
}

export interface BrandMethod {
  section: string;
  version: number;
  instructions: string;
  good: string;
  bad: string;
  reject: string;
}

export interface BrandBuilderData {
  revision: number;
  draft: BrandDraft;
  approved: BrandApproval | null;
  history: { version: number; by: string; at: string; idea: string }[];
  focus: BrandFocus[];
  focusHistory?: BrandFocus[];
  memory: BrandLesson[];
  canEditMethods: boolean;
  methods: BrandMethod[];
  workspaceRevision?: number;
  workspacePatch?: Partial<ProductWorkspace>;
}

import type { ProductWorkspace } from "./types";
