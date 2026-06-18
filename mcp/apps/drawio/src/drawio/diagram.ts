/**
 * Deterministic builder for draw.io / diagrams.net diagrams.
 *
 * Turns a structured description (nodes + edges) into a valid mxGraph XML
 * document that the draw.io editor can load directly. When node positions are
 * omitted, a simple layered auto-layout is applied so the LLM only has to
 * describe *what* connects to *what*, not pixel coordinates.
 */

export type NodeShape =
  | "rectangle"
  | "rounded"
  | "ellipse"
  | "diamond"
  | "process"
  | "terminator"
  | "cylinder"
  | "cloud"
  | "hexagon"
  | "parallelogram";

export interface DiagramNode {
  /** Unique identifier, referenced by edges. */
  id: string;
  /** Text shown inside the shape. */
  label?: string;
  /** Visual shape (default: rectangle). */
  shape?: NodeShape;
  /** Absolute x position. Omit to auto-layout. */
  x?: number;
  /** Absolute y position. Omit to auto-layout. */
  y?: number;
  width?: number;
  height?: number;
  /** Fill color, e.g. "#dae8fc". */
  fillColor?: string;
  /** Border color, e.g. "#6c8ebf". */
  strokeColor?: string;
}

export interface DiagramEdge {
  /** id of the source node. */
  source: string;
  /** id of the target node. */
  target: string;
  /** Optional label on the connector. */
  label?: string;
  /** Render the connector dashed. */
  dashed?: boolean;
}

export interface BuildOptions {
  /** Layout flow direction when auto-laying-out (default: "vertical"). */
  direction?: "vertical" | "horizontal";
  nodeWidth?: number;
  nodeHeight?: number;
}

const DEFAULT_WIDTH = 160;
const DEFAULT_HEIGHT = 60;
const H_GAP = 50;
const V_GAP = 60;

const DEFAULT_FILL = "#dae8fc";
const DEFAULT_STROKE = "#6c8ebf";

const SHAPE_STYLES: Record<NodeShape, string> = {
  rectangle: "rounded=0;whiteSpace=wrap;html=1;",
  process: "rounded=0;whiteSpace=wrap;html=1;",
  rounded: "rounded=1;whiteSpace=wrap;html=1;",
  ellipse: "ellipse;whiteSpace=wrap;html=1;",
  diamond: "rhombus;whiteSpace=wrap;html=1;",
  terminator:
    "rounded=1;whiteSpace=wrap;html=1;arcSize=40;",
  cylinder:
    "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;",
  cloud: "ellipse;shape=cloud;whiteSpace=wrap;html=1;",
  hexagon:
    "shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;",
  parallelogram:
    "shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;",
};

const EDGE_STYLE = "edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;";

/** Escape a string for safe inclusion in an XML attribute value. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Assign a layer (level) to every node via longest-path from the roots.
 *
 * Back-edges (connectors that point to an ancestor, i.e. loops/retries) are
 * detected with a DFS and excluded from the level computation, so a cycle
 * doesn't push its start node to the bottom of the canvas. The remaining
 * forward edges form a DAG, so the longest-path relaxation converges.
 */
function computeLevels(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const validEdges = edges.filter(
    (e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target,
  );

  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of validEdges) adj.get(e.source)!.push(e.target);

  // DFS colouring to find back-edges (target currently on the recursion stack).
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const SEP = String.fromCharCode(0);
  const color = new Map<string, number>(nodes.map((n) => [n.id, WHITE]));
  const backEdges = new Set<string>();

  // Iterative DFS to avoid blowing the call stack on large graphs.
  for (const start of nodes) {
    if (color.get(start.id) !== WHITE) continue;
    const stack: Array<{ node: string; i: number }> = [{ node: start.id, i: 0 }];
    color.set(start.id, GRAY);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const neighbors = adj.get(frame.node)!;
      if (frame.i < neighbors.length) {
        const v = neighbors[frame.i++];
        const c = color.get(v);
        if (c === GRAY) {
          backEdges.add(frame.node + SEP + v);
        } else if (c === WHITE) {
          color.set(v, GRAY);
          stack.push({ node: v, i: 0 });
        }
      } else {
        color.set(frame.node, BLACK);
        stack.pop();
      }
    }
  }

  const forwardEdges = validEdges.filter(
    (e) => !backEdges.has(e.source + SEP + e.target),
  );

  const level = new Map<string, number>();
  for (const n of nodes) level.set(n.id, 0);

  // Longest-path relaxation over the DAG of forward edges.
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of forwardEdges) {
      const next = (level.get(e.source) ?? 0) + 1;
      if (next > (level.get(e.target) ?? 0)) {
        level.set(e.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return level;
}

/**
 * Compute absolute positions for any node missing explicit x/y, grouping
 * nodes by their layer and centering each row.
 */
function autoLayout(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  opts: BuildOptions,
): Map<string, { x: number; y: number }> {
  const direction = opts.direction ?? "vertical";
  const w = opts.nodeWidth ?? DEFAULT_WIDTH;
  const h = opts.nodeHeight ?? DEFAULT_HEIGHT;

  const level = computeLevels(nodes, edges);

  // Group node ids by level, preserving input order within a level.
  const byLevel = new Map<number, string[]>();
  for (const n of nodes) {
    const lvl = level.get(n.id) ?? 0;
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl)!.push(n.id);
  }

  const maxPerLevel = Math.max(1, ...[...byLevel.values()].map((g) => g.length));
  const rowSpan = maxPerLevel * w + (maxPerLevel - 1) * H_GAP;

  const pos = new Map<string, { x: number; y: number }>();
  for (const [lvl, group] of byLevel) {
    const groupSpan = group.length * w + (group.length - 1) * H_GAP;
    const offset = (rowSpan - groupSpan) / 2;
    group.forEach((id, idx) => {
      const along = offset + idx * (w + H_GAP);
      const across = lvl * (h + V_GAP);
      pos.set(
        id,
        direction === "vertical"
          ? { x: along + 40, y: across + 40 }
          : { x: across + 40, y: along + 40 },
      );
    });
  }
  return pos;
}

/**
 * Build a complete mxGraph XML document from nodes and edges.
 * Throws if a node id is missing or duplicated.
 */
export function buildDiagramXml(
  nodes: DiagramNode[],
  edges: DiagramEdge[] = [],
  opts: BuildOptions = {},
): string {
  const seen = new Set<string>();
  for (const n of nodes) {
    if (!n.id) throw new Error("Every node needs a non-empty id.");
    if (seen.has(n.id)) throw new Error(`Duplicate node id: ${n.id}`);
    seen.add(n.id);
  }

  const layout = autoLayout(nodes, edges, opts);
  const w = opts.nodeWidth ?? DEFAULT_WIDTH;
  const h = opts.nodeHeight ?? DEFAULT_HEIGHT;

  const cells: string[] = [];

  for (const n of nodes) {
    const shape = n.shape ?? "rectangle";
    const baseStyle = SHAPE_STYLES[shape] ?? SHAPE_STYLES.rectangle;
    const style =
      baseStyle +
      `fillColor=${n.fillColor ?? DEFAULT_FILL};` +
      `strokeColor=${n.strokeColor ?? DEFAULT_STROKE};`;
    const p = layout.get(n.id) ?? { x: 40, y: 40 };
    const x = n.x ?? p.x;
    const y = n.y ?? p.y;
    const nodeW = n.width ?? w;
    const nodeH = n.height ?? h;

    cells.push(
      `        <mxCell id="${escapeXml(n.id)}" value="${escapeXml(
        n.label ?? "",
      )}" style="${escapeXml(style)}" vertex="1" parent="1">\n` +
        `          <mxGeometry x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" as="geometry" />\n` +
        `        </mxCell>`,
    );
  }

  const validNodeIds = seen;
  let edgeSeq = 0;
  for (const e of edges) {
    if (!validNodeIds.has(e.source) || !validNodeIds.has(e.target)) {
      // Skip edges that reference unknown nodes rather than producing broken XML.
      continue;
    }
    const style = EDGE_STYLE + (e.dashed ? "dashed=1;" : "");
    const edgeId = `edge-${edgeSeq++}`;
    cells.push(
      `        <mxCell id="${edgeId}" value="${escapeXml(
        e.label ?? "",
      )}" style="${escapeXml(style)}" edge="1" parent="1" source="${escapeXml(
        e.source,
      )}" target="${escapeXml(e.target)}">\n` +
        `          <mxGeometry relative="1" as="geometry" />\n` +
        `        </mxCell>`,
    );
  }

  return (
    `<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" ` +
    `tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" ` +
    `pageWidth="850" pageHeight="1100" math="0" shadow="0">\n` +
    `  <root>\n` +
    `    <mxCell id="0" />\n` +
    `    <mxCell id="1" parent="0" />\n` +
    cells.join("\n") +
    `\n  </root>\n` +
    `</mxGraphModel>`
  );
}
