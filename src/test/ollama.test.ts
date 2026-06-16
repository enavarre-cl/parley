import { test } from 'node:test';
import assert from 'node:assert';
import { ollamaAsset, assetFormat, ollamaAssetUrl, ollamaBinName, OLLAMA_ASSET_SHA256, OLLAMA_VERSION } from '../ollama/assets';
import {
  parseQuant, heuristicCapabilities, hfPullRef, formatBytes, isAuxiliaryGguf, isOllamaPullable,
  parseParamCount, formatParams, domainFromPipeline, isOfficialOrg,
} from '../ollama/parse';

// --- assets ---
test('ollamaAsset elige el asset correcto por plataforma/arch', () => {
  assert.strictEqual(ollamaAsset('darwin', 'arm64'), 'ollama-darwin.tgz');
  assert.strictEqual(ollamaAsset('darwin', 'x64'), 'ollama-darwin.tgz'); // universal
  assert.strictEqual(ollamaAsset('linux', 'x64'), 'ollama-linux-amd64.tar.zst');
  assert.strictEqual(ollamaAsset('linux', 'arm64'), 'ollama-linux-arm64.tar.zst');
  assert.strictEqual(ollamaAsset('win32', 'x64'), 'ollama-windows-amd64.zip');
  assert.strictEqual(ollamaAsset('win32', 'arm64'), 'ollama-windows-arm64.zip');
  assert.strictEqual(ollamaAsset('sunos', 'x64'), null);
});

test('cada asset soportado tiene SHA256 pineado (fail-closed)', () => {
  for (const plat of [['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['win32', 'arm64']] as const) {
    const a = ollamaAsset(plat[0], plat[1])!;
    assert.ok(OLLAMA_ASSET_SHA256[a], `falta hash de ${a}`);
    assert.match(OLLAMA_ASSET_SHA256[a], /^[0-9a-f]{64}$/);
  }
});

test('assetFormat detecta gz/zst/zip', () => {
  assert.strictEqual(assetFormat('ollama-darwin.tgz'), 'gz');
  assert.strictEqual(assetFormat('ollama-linux-amd64.tar.zst'), 'zst');
  assert.strictEqual(assetFormat('ollama-windows-amd64.zip'), 'zip');
});

test('ollamaAssetUrl y ollamaBinName', () => {
  assert.ok(ollamaAssetUrl('ollama-darwin.tgz').includes(`/download/${OLLAMA_VERSION}/ollama-darwin.tgz`));
  assert.strictEqual(ollamaBinName('win32'), 'ollama.exe');
  assert.strictEqual(ollamaBinName('darwin'), 'ollama');
});

// --- parse ---
test('parseQuant extrae el nivel de cuantización', () => {
  assert.strictEqual(parseQuant('gemma-4-12b-Q4_K_M.gguf'), 'Q4_K_M');
  assert.strictEqual(parseQuant('model.IQ3_XS.gguf'), 'IQ3_XS');
  assert.strictEqual(parseQuant('foo-bar.BF16.gguf'), 'BF16');
  assert.strictEqual(parseQuant('sub/dir/Llama-3-Q8_0.gguf'), 'Q8_0');
  assert.strictEqual(parseQuant('sinquant.gguf'), 'GGUF');
});

test('heuristicCapabilities deduce de tags/nombre/pipeline', () => {
  assert.deepStrictEqual(heuristicCapabilities('org/llava-1.5-gguf', []), { vision: true, tools: false, reasoning: false });
  assert.strictEqual(heuristicCapabilities('org/qwq-32b', ['text-generation']).reasoning, true);
  assert.strictEqual(heuristicCapabilities('org/some-tool-use-model', []).tools, true);
  // El pipeline_tag de HF también marca visión (image-text-to-text / any-to-any).
  assert.strictEqual(heuristicCapabilities('google/gemma-4-31b-gguf', [], 'image-text-to-text').vision, true);
  assert.strictEqual(heuristicCapabilities('google/gemma-4-12b-gguf', [], 'any-to-any').vision, true);
  // Conocimiento de familias (como el catálogo curado de LM Studio): gemma-4 = V/T/R aunque HF no lo etiquete.
  assert.deepStrictEqual(heuristicCapabilities('google/gemma-4-12B-it-qat-q4_0-gguf', ['gguf']),
    { vision: true, tools: true, reasoning: true });
  assert.strictEqual(heuristicCapabilities('Qwen/Qwen3-4B-Thinking', ['gguf']).reasoning, true);
  assert.strictEqual(heuristicCapabilities('Qwen/Qwen3-4B', ['gguf']).tools, true);
  assert.deepStrictEqual(heuristicCapabilities('org/plain-llm', [], 'text-generation'), { vision: false, tools: false, reasoning: false });
});

test('isOllamaPullable: estándar (1 quant) sí, no estándar (varios/ninguno) no', () => {
  assert.strictEqual(isOllamaPullable('google_gemma-4-12b-it-Q4_K_M.gguf'), true);
  assert.strictEqual(isOllamaPullable('Qwen3-4B-Instruct-Q8_0.gguf'), true);
  assert.strictEqual(isOllamaPullable('model-f16.gguf'), true);
  // Varios tokens de cuant en un fichero → Ollama no resuelve el tag (caso antirez/deepseek).
  assert.strictEqual(isOllamaPullable('DeepSeek-V4-Flash-MTP-Q4K-Q8_0-F32.gguf'), false);
  assert.strictEqual(isOllamaPullable('Llama-3-merged-Q4_K_M-Q6_K.gguf'), false);
  // Quant "pegado" al nombre (no es token limpio) → Ollama falla (caso google/gemma QAT).
  assert.strictEqual(isOllamaPullable('gemma-4-E4B_q4_0-it.gguf'), false);
  assert.strictEqual(isOllamaPullable('gemma-4-31B_q4_0-it.gguf'), false);
  // Sin token de cuant reconocible.
  assert.strictEqual(isOllamaPullable('plain-model.gguf'), false);
});

test('isAuxiliaryGguf detecta proyectores (mmproj) y drafts MTP', () => {
  assert.strictEqual(isAuxiliaryGguf('gemma-4-31B-it-mmproj.gguf'), true);
  assert.strictEqual(isAuxiliaryGguf('sub/dir/mmproj-model-f16.gguf'), true);
  assert.strictEqual(isAuxiliaryGguf('model-vision-adapter.gguf'), true);
  // Drafts de speculative decoding (carpeta MTP/ y sufijos -MTP / mtp- de unsloth).
  assert.strictEqual(isAuxiliaryGguf('MTP/gemma-4-E4B-it-Q4_0-MTP.gguf'), true);
  assert.strictEqual(isAuxiliaryGguf('mtp-gemma-4-E4B-it.gguf'), true);
  // El modelo real NO es auxiliar.
  assert.strictEqual(isAuxiliaryGguf('gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf'), false);
  assert.strictEqual(isAuxiliaryGguf('gemma-4-31B_q4_0-it.gguf'), false);
  assert.strictEqual(isAuxiliaryGguf('llama-3-Q4_K_M.gguf'), false);
});

test('hfPullRef arma la referencia hf.co', () => {
  assert.strictEqual(hfPullRef('google/gemma-4-12b-qat-gguf', 'Q4_0'), 'hf.co/google/gemma-4-12b-qat-gguf:Q4_0');
});

test('formatBytes da unidades legibles', () => {
  assert.strictEqual(formatBytes(0), '—');
  assert.strictEqual(formatBytes(7.15 * 1073741824), '7.15 GB');
  assert.strictEqual(formatBytes(500 * 1048576), '500 MB');
});

test('parseParamCount deduce los parámetros del nombre', () => {
  assert.strictEqual(parseParamCount('google/gemma-4-12B-it-GGUF'), '12B');
  assert.strictEqual(parseParamCount('Qwen/Qwen3-4B-Thinking'), '4B');
  assert.strictEqual(parseParamCount('org/Mixtral-8x7B-Instruct'), '8x7B');
  assert.strictEqual(parseParamCount('org/model-700M-gguf'), '700M');
  assert.strictEqual(parseParamCount('google/gemma-4'), ''); // "4" es versión, no params
});

test('formatParams convierte safetensors.total', () => {
  assert.strictEqual(formatParams(4022468096), '4B');
  assert.strictEqual(formatParams(70e9), '70B');
  assert.strictEqual(formatParams(700e6), '700M');
  assert.strictEqual(formatParams(0), '');
});

test('domainFromPipeline clasifica el dominio', () => {
  assert.strictEqual(domainFromPipeline('text-generation'), 'LLM');
  assert.strictEqual(domainFromPipeline('image-text-to-text'), 'VLM');
  assert.strictEqual(domainFromPipeline('text-generation', { vision: true }), 'VLM');
  assert.strictEqual(domainFromPipeline('feature-extraction'), 'Embeddings');
});

test('isOfficialOrg reconoce orgs oficiales (case-insensitive)', () => {
  assert.strictEqual(isOfficialOrg('google'), true);
  assert.strictEqual(isOfficialOrg('Qwen'), true);
  assert.strictEqual(isOfficialOrg('meta-llama'), true);
  assert.strictEqual(isOfficialOrg('ibm-granite'), true);
  assert.strictEqual(isOfficialOrg('bartowski'), false);
  assert.strictEqual(isOfficialOrg('unsloth'), false);
});
