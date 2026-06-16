/** Catálogo de modelos GGUF de Hugging Face (búsqueda, ficheros, capacidades heurísticas). */
import { httpFetch } from '../http';
import type { ModelCapabilities } from './registry';
import {
  heuristicCapabilities, parseQuant, hfPullRef, isAuxiliaryGguf, isOllamaPullable,
  parseParamCount, formatParams, domainFromPipeline, isOfficialOrg, OFFICIAL_ORG_NAMES,
} from './parse';

export { heuristicCapabilities, parseQuant, hfPullRef, isAuxiliaryGguf, OFFICIAL_ORG_NAMES };

export interface CatalogModel {
  id: string;          // p. ej. "google/gemma-4-12b-qat-gguf"
  author: string;
  downloads: number;
  likes: number;
  updated: string;
  tags: string[];
  pipeline: string;    // pipeline_tag de HF (text-generation, image-text-to-text…) → descripción
  params: string;      // nº de parámetros deducido del nombre (12B, 4B…)
  domain: string;      // LLM / VLM / Embeddings…
  official: boolean;   // autor en la lista de orgs oficiales
  capabilities: ModelCapabilities; // estimadas (D3: la verdad llega de /api/show tras bajar)
}

/** Info extra del modelo (arquitectura y params exactos), del endpoint individual de HF. */
export interface ModelInfo {
  arch: string;        // config.model_type (qwen3, gemma, llama…)
  params: string;      // de safetensors.total, si está
}

export interface ModelFile {
  path: string;        // ruta del .gguf en el repo
  size: number;        // bytes
  quant: string;       // p. ej. "Q4_K_M"
  pullable: boolean;   // ¿Ollama podrá resolver `:{quant}`? (nombres estándar)
}

const HF = 'https://huggingface.co';

/** Busca modelos GGUF en HF (GET /api/models?search=&filter=gguf). */
export type SortMode = 'relevance' | 'likes' | 'downloads' | 'modified';
const SORT_PARAM: Record<SortMode, string> = {
  relevance: '', likes: 'likes', downloads: 'downloads', modified: 'lastModified',
};

export async function searchHF(
  query: string, limit = 30, signal?: AbortSignal, author = '', sort: SortMode = 'relevance'
): Promise<CatalogModel[]> {
  const q = encodeURIComponent(query || '');
  let url = `${HF}/api/models?search=${q}&filter=gguf&limit=${limit}&full=true`;
  // Capacidades NO se filtran en HF (sus tags son escasos: las orgs oficiales no etiquetan); se
  // filtran en el cliente con la heurística por familias. "Best Match" (relevance) = sin sort.
  const sortField = SORT_PARAM[sort] || (query ? '' : 'downloads');
  if (sortField) url += `&sort=${sortField}&direction=-1`;
  if (author) url += `&author=${encodeURIComponent(author)}`;
  const res = await httpFetch(url, { signal });
  if (!res.ok) throw new Error(`HF search HTTP ${res.status}`);
  const arr = (await res.json()) as any[];
  return (arr || []).map((m) => toCatalogModel(m));
}

/** Normaliza un objeto de la API de HF a nuestro CatalogModel. */
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

/** URL directa de un fichero del repo en HF (para descargarlo a mano e importarlo a Ollama). */
export function hfFileUrl(id: string, filePath: string): string {
  return `${HF}/${id}/resolve/main/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

/** Ruta del proyector de visión (mmproj) del repo, si existe — para importar modelos con visión. */
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

/** Trae UN modelo por id (GET /api/models/{id}) como CatalogModel — sin pasar por la búsqueda. */
export async function fetchModel(id: string, signal?: AbortSignal): Promise<CatalogModel> {
  const res = await httpFetch(`${HF}/api/models/${id}`, { signal });
  if (!res.ok) throw new Error(`HF model HTTP ${res.status}`);
  return toCatalogModel(await res.json());
}

/** Lista los ficheros .gguf de un repo con su tamaño y quant (GET /api/models/{id}/tree/main). */
export async function modelFiles(id: string, signal?: AbortSignal): Promise<ModelFile[]> {
  const url = `${HF}/api/models/${id}/tree/main?recursive=true`;
  const res = await httpFetch(url, { signal });
  if (!res.ok) throw new Error(`HF tree HTTP ${res.status}`);
  const arr = (await res.json()) as any[];
  return (arr || [])
    .filter((e) => e?.type === 'file' && typeof e.path === 'string' && /\.gguf$/i.test(e.path))
    .filter((e) => !isAuxiliaryGguf(e.path)) // excluye mmproj/proyectores: no son modelos sueltos
    .map((e): ModelFile => ({
      path: e.path,
      size: e.size || e.lfs?.size || 0,
      quant: parseQuant(e.path),
      pullable: isOllamaPullable(e.path),
    }))
    .sort((a, b) => a.size - b.size);
}

/** Info extra del modelo (arquitectura y params exactos) del endpoint individual de HF. */
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

/** README del modelo (markdown crudo), o cadena vacía si no hay. */
export async function readme(id: string, signal?: AbortSignal): Promise<string> {
  try {
    const res = await httpFetch(`${HF}/${id}/resolve/main/README.md`, { signal });
    if (!res.ok) return '';
    const text = await res.text();
    // Quita el front-matter YAML (--- … ---) del principio.
    return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  } catch { return ''; }
}
