/**
 * Runs ELK on a `SceneGraph` and caches results per layout key.
 *
 * ELK runs on the main thread: `elk.bundled.js` falls back to its in-process
 * "fake worker" when no `workerUrl` is given, which avoids having to allow
 * worker/blob sources in the webview CSP. No DOM access in this module.
 */
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkPoint } from 'elkjs/lib/elk-api';
import { relaxLayoutOptions, type SceneGraph } from './graph';

export interface Point {
  x: number;
  y: number;
}

export interface EdgeRoute {
  /** One polyline per ELK edge section. */
  polylines: Point[][];
  junctions: Point[];
}

export interface LaidOutScene {
  graph: SceneGraph;
  /** Node id -> top-left position. */
  nodePos: Map<string, Point>;
  edgeRoutes: Map<string, EdgeRoute>;
  width: number;
  height: number;
  /** Milliseconds spent in ELK. */
  elapsed: number;
}

type ElkInstance = InstanceType<typeof ELK>;

let elkInstance: ElkInstance | undefined;
function elk(): ElkInstance {
  elkInstance ??= new ELK();
  return elkInstance;
}

function toPoint(p: ElkPoint): Point {
  return { x: p.x, y: p.y };
}

function extract(graph: SceneGraph, result: ElkNode, elapsed: number): LaidOutScene {
  const nodePos = new Map<string, Point>();
  for (const c of result.children ?? []) nodePos.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  const edgeRoutes = new Map<string, EdgeRoute>();
  for (const e of result.edges ?? []) {
    const polylines = (e.sections ?? []).map((s) => [
      toPoint(s.startPoint),
      ...(s.bendPoints ?? []).map(toPoint),
      toPoint(s.endPoint),
    ]);
    edgeRoutes.set(e.id, { polylines, junctions: (e.junctionPoints ?? []).map(toPoint) });
  }
  return { graph, nodePos, edgeRoutes, width: result.width ?? 0, height: result.height ?? 0, elapsed };
}

export async function runLayout(graph: SceneGraph): Promise<LaidOutScene> {
  const t0 = Date.now();
  try {
    const result = await elk().layout(graph.elk);
    return extract(graph, result, Date.now() - t0);
  } catch (err) {
    // Some layer-constraint combinations are rejected by ELK; retry without.
    console.warn('[odin] layout failed, retrying with relaxed options', err);
    const result = await elk().layout(relaxLayoutOptions(graph.elk));
    return extract(graph, result, Date.now() - t0);
  }
}

/** Promise cache keyed by `layoutKey(...)`. */
export class LayoutCache {
  private readonly cache = new Map<string, Promise<LaidOutScene>>();
  private readonly max: number;

  constructor(max = 24) {
    this.max = max;
  }

  get(key: string, build: () => SceneGraph): Promise<LaidOutScene> {
    const hit = this.cache.get(key);
    if (hit) {
      // Refresh LRU position.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const p = runLayout(build());
    p.catch(() => this.cache.delete(key));
    this.cache.set(key, p);
    while (this.cache.size > this.max) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return p;
  }

  clear(): void {
    this.cache.clear();
  }
}
