/** Hugging Face GGUF model catalog (search, files, heuristic capabilities). */
import { httpFetch } from '../http';
import type { ModelCapabilities } from './registry';
import {
  heuristicCapabilities, parseQuant, hfPullRef, isAuxiliaryGguf, isOllamaPullable, shardInfo,
  parseParamCount, formatParams, domainFromPipeline, isOfficialOrg, OFFICIAL_ORG_NAMES,
} from './parse';

export { heuristicCapabilities, parseQuant, hfPullRef, isAuxiliaryGguf, OFFICIAL_ORG_NAMES };

export interface CatalogModel {
  id: string;          // e.g. "google/gemma-4-12b-qat-gguf"
  author: string;
  downloads: number;
  likes: number;
  updated: string;
  tags: string[];
  pipeline: string;    // HF pipeline_tag (text-generation, image-text-to-text…) → description
  params: string;      // parameter count inferred from name (12B, 4B…)
  domain: string;      // LLM / VLM / Embeddings…
  official: boolean;   // author is in the official orgs list
  capabilities: ModelCapabilities; // estimated (D3: truth arrives from /api/show after download)
}

/** Extra model info (architecture and exact params), from the individual HF endpoint. */
export interface ModelInfo {
  arch: string;        // config.model_type (qwen3, gemma, llama…)
  params: string;      // from safetensors.total, if available
}

export interface ModelFile {
  path: string;        // path of the .gguf in the repo (the first part, when sharded)
  size: number;        // bytes (TOTAL across all shards)
  quant: string;       // e.g. "Q4_K_M"
  pullable: boolean;   // can Ollama resolve `:{quant}`? (standard names)
  shards?: string[];   // all shard paths in order, only when the model is split (>1 part)
}

const HF = 'https://huggingface.co';

/** Searches for GGUF models on HF (GET /api/models?search=&filter=gguf). */
export type SortMode = 'relevance' | 'likes' | 'downloads' | 'modified';
const SORT_PARAM: Record<SortMode, string> = {
  relevance: '', likes: 'likes', downloads: 'downloads', modified: 'lastModified',
};

export async function searchHF(
  query: string, limit = 30, signal?: AbortSignal, author = '', sort: SortMode = 'relevance'
): Promise<CatalogModel[]> {
  const q = encodeURIComponent(query || '');
  let url = `${HF}/api/models?search=${q}&filter=gguf&limit=${limit}&full=true`;
  // Capabilities are NOT filtered on HF (its tags are sparse: official orgs don't label them); they
  // are filtered on the client with the family heuristic. "Best Match" (relevance) = no sort.
  const sortField = SORT_PARAM[sort] || (query ? '' : 'downloads');
  if (sortField) url += `&sort=${sortField}&direction=-1`;
  if (author) url += `&author=${encodeURIComponent(author)}`;
  const res = await httpFetch(url, { signal });
  if (!res.ok) throw new Error(`HF search HTTP ${res.status}`);
  const arr = (await res.json()) as any[];
  return (arr || []).map((m) => toCatalogModel(m));
}

/** Normalises an HF API object into our CatalogModel. */
function toCatalogModel(m: any): CatalogModel {
  const id: string = m.id || m.modelId || '';
  const tags: string[] = Array.isArray(m.tags) ? m.tags : [];
  const pipeline: string = m.pipeline_tag || '';
  const author = id.split('/')[0] || '';
  const caps = heuristicCapabilities(id, tags, pipeline);
  return {
    id,
    author,
    downloads: m.downloads || 0,
    likes: m.likes || 0,
    updated: m.lastModified || m.createdAt || '',
    tags,
    pipeline,
    params: parseParamCount(id),
    domain: domainFromPipeline(pipeline, caps),
    official: isOfficialOrg(author),
    capabilities: caps,
  };
}

/** Direct URL of a repo file on HF (to download it manually and import it into Ollama). */
export function hfFileUrl(id: string, filePath: string): string {
  return `${HF}/${id}/resolve/main/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

/** Path of the vision projector (mmproj) in the repo, if present — for importing vision models. */
export async function projectorFile(id: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await httpFetch(`${HF}/api/models/${id}/tree/main?recursive=true`, { signal });
    if (!res.ok) return undefined;
    const arr = (await res.json()) as any[];
    const f = (arr || []).find((e) =>
      e?.type === 'file' && typeof e.path === 'string' && /\.gguf$/i.test(e.path) && isAuxiliaryGguf(e.path));
    return f?.path;
  } catch { return undefined; }
}

/** Fetches a single model by id (GET /api/models/{id}) as a CatalogModel — bypassing search. */
export async function fetchModel(id: string, signal?: AbortSignal): Promise<CatalogModel> {
  const res = await httpFetch(`${HF}/api/models/${id}`, { signal });
  if (!res.ok) throw new Error(`HF model HTTP ${res.status}`);
  return toCatalogModel(await res.json());
}

/** Lists the .gguf files of a repo with their size and quant (GET /api/models/{id}/tree/main). */
export async function modelFiles(id: string, signal?: AbortSignal): Promise<ModelFile[]> {
  const url = `${HF}/api/models/${id}/tree/main?recursive=true`;
  const res = await httpFetch(url, { signal });
  if (!res.ok) throw new Error(`HF tree HTTP ${res.status}`);
  const arr = (await res.json()) as any[];
  const ggufs = (arr || [])
    .filter((e) => e?.type === 'file' && typeof e.path === 'string' && /\.gguf$/i.test(e.path))
    .filter((e) => !isAuxiliaryGguf(e.path)) // excludes mmproj/projectors: not standalone models
    .map((e) => ({ path: e.path as string, size: (e.size || e.lfs?.size || 0) as number }));

  // Collapse split models (`…-00001-of-00003.gguf`) into ONE entry: a single shard is not usable
  // on its own. Standalone files keep one entry each. Grouped by shard base (which includes any
  // subfolder), so different quants in their own folders never mix.
  const groups = new Map<string, { paths: { path: string; size: number; index: number }[] }>();
  const out: ModelFile[] = [];
  for (const f of ggufs) {
    const sh = shardInfo(f.path);
    if (!sh) {
      out.push({ path: f.path, size: f.size, quant: parseQuant(f.path), pullable: isOllamaPullable(f.path) });
      continue;
    }
    const g = groups.get(sh.base) || { paths: [] };
    g.paths.push({ ...f, index: sh.index });
    groups.set(sh.base, g);
  }
  for (const g of groups.values()) {
    g.paths.sort((a, b) => a.index - b.index);
    const first = g.paths[0].path;
    out.push({
      path: first,
      size: g.paths.reduce((n, p) => n + p.size, 0),
      quant: parseQuant(first),
      pullable: isOllamaPullable(first),
      shards: g.paths.map((p) => p.path),
    });
  }
  return out.sort((a, b) => a.size - b.size);
}

/**
 * Pre-flight: will an Ollama `hf.co/{id}:{quant}` pull actually succeed?
 *
 * Ollama builds the model from an Ollama-style manifest that HF generates on the fly at
 * `/v2/{id}/manifests/{quant}`, then fetches the manifest's CONFIG descriptor blob. For some
 * quants HF serves a broken/hanging config descriptor, so the pull dies with "400:" AFTER having
 * already downloaded the (multi-GB) layers. We probe that exact descriptor up front — the same
 * path Ollama walks — so the caller can fall back to a direct .gguf import instead of wasting the
 * download. Returns false on any non-OK response or timeout (the import path still works).
 */
export async function ollamaPullViable(id: string, quant: string, timeoutMs = 6000): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const accept = 'application/vnd.docker.distribution.manifest.v2+json';
    const man = await httpFetch(`${HF}/v2/${id}/manifests/${encodeURIComponent(quant)}`, {
      headers: { Accept: accept }, signal: ac.signal,
    });
    if (!man.ok) return false;
    const digest = ((await man.json()) as any)?.config?.digest;
    if (!digest) return false;
    // Range 0-0: confirm the descriptor is actually retrievable without downloading it whole.
    const blob = await httpFetch(`${HF}/v2/${id}/blobs/${digest}`, {
      headers: { Range: 'bytes=0-0' }, signal: ac.signal,
    });
    return blob.ok; // 200 (full) or 206 (partial) → Ollama will be able to finish the pull
  } catch {
    return false; // network error or 6s timeout → treat as not pullable, import the .gguf directly
  } finally {
    clearTimeout(timer);
  }
}

/** Extra model info (architecture and exact params) from the individual HF endpoint. */
export async function modelInfo(id: string, signal?: AbortSignal): Promise<ModelInfo> {
  try {
    const res = await httpFetch(`${HF}/api/models/${id}`, { signal });
    if (!res.ok) return { arch: '', params: '' };
    const m = (await res.json()) as any;
    return {
      arch: m?.config?.model_type || '',
      params: formatParams(m?.safetensors?.total || 0),
    };
  } catch { return { arch: '', params: '' }; }
}

/** Model README (raw markdown), or empty string if none. */
export async function readme(id: string, signal?: AbortSignal): Promise<string> {
  try {
    const res = await httpFetch(`${HF}/${id}/resolve/main/README.md`, { signal });
    if (!res.ok) return '';
    const text = await res.text();
    // Strips the leading YAML front-matter (--- … ---).
    return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  } catch { return ''; }
}
