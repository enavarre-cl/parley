import { test } from 'node:test';
import assert from 'node:assert';
import { ollamaAsset, assetFormat, ollamaAssetUrl, ollamaBinName, OLLAMA_ASSET_SHA256, OLLAMA_VERSION } from '../ollama/assets';
import {
  parseQuant, heuristicCapabilities, hfPullRef, formatBytes, isAuxiliaryGguf, isOllamaPullable, shardInfo,
  parseParamCount, formatParams, domainFromPipeline, isOfficialOrg,
} from '../ollama/parse';
import { isImageOutputModel, parseDataUrl } from '../providers/multimodal';

// --- assets ---
test('ollamaAsset picks the correct asset by platform/arch', () => {
  assert.strictEqual(ollamaAsset('darwin', 'arm64'), 'ollama-darwin.tgz');
  assert.strictEqual(ollamaAsset('darwin', 'x64'), 'ollama-darwin.tgz'); // universal binary
  assert.strictEqual(ollamaAsset('linux', 'x64'), 'ollama-linux-amd64.tar.zst');
  assert.strictEqual(ollamaAsset('linux', 'arm64'), 'ollama-linux-arm64.tar.zst');
  assert.strictEqual(ollamaAsset('win32', 'x64'), 'ollama-windows-amd64.zip');
  assert.strictEqual(ollamaAsset('win32', 'arm64'), 'ollama-windows-arm64.zip');
  assert.strictEqual(ollamaAsset('sunos', 'x64'), null);
});

test('every supported asset has a pinned SHA256 (fail-closed)', () => {
  for (const plat of [['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['win32', 'arm64']] as const) {
    const a = ollamaAsset(plat[0], plat[1])!;
    assert.ok(OLLAMA_ASSET_SHA256[a], `missing hash for ${a}`);
    assert.match(OLLAMA_ASSET_SHA256[a], /^[0-9a-f]{64}$/);
  }
});

test('assetFormat detects gz/zst/zip', () => {
  assert.strictEqual(assetFormat('ollama-darwin.tgz'), 'gz');
  assert.strictEqual(assetFormat('ollama-linux-amd64.tar.zst'), 'zst');
  assert.strictEqual(assetFormat('ollama-windows-amd64.zip'), 'zip');
});

test('ollamaAssetUrl and ollamaBinName', () => {
  assert.ok(ollamaAssetUrl('ollama-darwin.tgz').includes(`/download/${OLLAMA_VERSION}/ollama-darwin.tgz`));
  assert.strictEqual(ollamaBinName('win32'), 'ollama.exe');
  assert.strictEqual(ollamaBinName('darwin'), 'ollama');
});

// --- parse ---
test('parseQuant extracts the quantisation level', () => {
  assert.strictEqual(parseQuant('gemma-4-12b-Q4_K_M.gguf'), 'Q4_K_M');
  assert.strictEqual(parseQuant('model.IQ3_XS.gguf'), 'IQ3_XS');
  assert.strictEqual(parseQuant('foo-bar.BF16.gguf'), 'BF16');
  assert.strictEqual(parseQuant('sub/dir/Llama-3-Q8_0.gguf'), 'Q8_0');
  assert.strictEqual(parseQuant('sinquant.gguf'), 'GGUF');
});

test('heuristicCapabilities infers from tags/name/pipeline', () => {
  assert.deepStrictEqual(heuristicCapabilities('org/llava-1.5-gguf', []), { vision: true, tools: false, reasoning: false });
  assert.strictEqual(heuristicCapabilities('org/qwq-32b', ['text-generation']).reasoning, true);
  assert.strictEqual(heuristicCapabilities('org/some-tool-use-model', []).tools, true);
  // HF's pipeline_tag also marks vision (image-text-to-text / any-to-any).
  assert.strictEqual(heuristicCapabilities('google/gemma-4-31b-gguf', [], 'image-text-to-text').vision, true);
  assert.strictEqual(heuristicCapabilities('google/gemma-4-12b-gguf', [], 'any-to-any').vision, true);
  // Family knowledge (like LM Studio's curated catalogue): gemma-4 = V/T/R even when HF doesn't tag it.
  assert.deepStrictEqual(heuristicCapabilities('google/gemma-4-12B-it-qat-q4_0-gguf', ['gguf']),
    { vision: true, tools: true, reasoning: true });
  assert.strictEqual(heuristicCapabilities('Qwen/Qwen3-4B-Thinking', ['gguf']).reasoning, true);
  assert.strictEqual(heuristicCapabilities('Qwen/Qwen3-4B', ['gguf']).tools, true);
  assert.deepStrictEqual(heuristicCapabilities('org/plain-llm', [], 'text-generation'), { vision: false, tools: false, reasoning: false });
});

test('isOllamaPullable: standard (1 quant) yes, non-standard (multiple/none) no', () => {
  assert.strictEqual(isOllamaPullable('google_gemma-4-12b-it-Q4_K_M.gguf'), true);
  assert.strictEqual(isOllamaPullable('Qwen3-4B-Instruct-Q8_0.gguf'), true);
  assert.strictEqual(isOllamaPullable('model-f16.gguf'), true);
  // Multiple quant tokens in one filename → Ollama cannot resolve the tag (antirez/deepseek case).
  assert.strictEqual(isOllamaPullable('DeepSeek-V4-Flash-MTP-Q4K-Q8_0-F32.gguf'), false);
  assert.strictEqual(isOllamaPullable('Llama-3-merged-Q4_K_M-Q6_K.gguf'), false);
  // Quant "glued" to the name (not a clean token) → Ollama fails (google/gemma QAT case).
  assert.strictEqual(isOllamaPullable('gemma-4-E4B_q4_0-it.gguf'), false);
  assert.strictEqual(isOllamaPullable('gemma-4-31B_q4_0-it.gguf'), false);
  // No recognisable quant token.
  assert.strictEqual(isOllamaPullable('plain-model.gguf'), false);
});

test('isImageOutputModel / parseDataUrl', () => {
  assert.strictEqual(isImageOutputModel('gemini-2.5-flash-image'), true);
  assert.strictEqual(isImageOutputModel('google/gemini-2.5-flash-image-preview'), true);
  assert.strictEqual(isImageOutputModel('nano-banana'), true);
  assert.strictEqual(isImageOutputModel('gpt-4o'), false);
  assert.strictEqual(isImageOutputModel('claude-opus-4-8'), false);
  assert.deepStrictEqual(parseDataUrl('data:image/png;base64,AAAB'), { mime: 'image/png', data: 'AAAB' });
  assert.deepStrictEqual(parseDataUrl('data:image/jpeg;base64,Zm9v'), { mime: 'image/jpeg', data: 'Zm9v' });
  assert.strictEqual(parseDataUrl('https://example.com/x.png'), null);
  assert.strictEqual(parseDataUrl(''), null);
});

test('shardInfo parses split GGUF parts and ignores single files', () => {
  assert.deepStrictEqual(shardInfo('Qwen3-235B-Q4_K_M-00001-of-00003.gguf'), { base: 'Qwen3-235B-Q4_K_M', index: 1, total: 3 });
  assert.deepStrictEqual(shardInfo('Q4_K_M/model-00002-of-00010.gguf'), { base: 'Q4_K_M/model', index: 2, total: 10 });
  // Single-file models are not shards.
  assert.strictEqual(shardInfo('Qwen3.5-9B-UD-IQ2_M.gguf'), null);
  assert.strictEqual(shardInfo('model-Q4_K_M.gguf'), null);
  // Malformed / nonsensical part numbers → treated as standalone (null), never a 1-of-1 group.
  assert.strictEqual(shardInfo('model-00001-of-00001.gguf'), null);
  assert.strictEqual(shardInfo('model-00004-of-00003.gguf'), null);
  // parseQuant/isOllamaPullable still work on a shard name (quant lives in the base).
  assert.strictEqual(parseQuant('Qwen3-235B-Q4_K_M-00001-of-00003.gguf'), 'Q4_K_M');
  assert.strictEqual(isOllamaPullable('Qwen3-235B-Q4_K_M-00001-of-00003.gguf'), true);
});

test('isAuxiliaryGguf detects projectors (mmproj) and MTP drafts', () => {
  assert.strictEqual(isAuxiliaryGguf('gemma-4-31B-it-mmproj.gguf'), true);
  assert.strictEqual(isAuxiliaryGguf('sub/dir/mmproj-model-f16.gguf'), true);
  assert.strictEqual(isAuxiliaryGguf('model-vision-adapter.gguf'), true);
  // Speculative-decoding drafts (MTP/ folder and -MTP / mtp- suffixes from unsloth).
  assert.strictEqual(isAuxiliaryGguf('MTP/gemma-4-E4B-it-Q4_0-MTP.gguf'), true);
  assert.strictEqual(isAuxiliaryGguf('mtp-gemma-4-E4B-it.gguf'), true);
  // The real model is NOT auxiliary.
  assert.strictEqual(isAuxiliaryGguf('gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf'), false);
  assert.strictEqual(isAuxiliaryGguf('gemma-4-31B_q4_0-it.gguf'), false);
  assert.strictEqual(isAuxiliaryGguf('llama-3-Q4_K_M.gguf'), false);
});

test('hfPullRef builds the hf.co reference', () => {
  assert.strictEqual(hfPullRef('google/gemma-4-12b-qat-gguf', 'Q4_0'), 'hf.co/google/gemma-4-12b-qat-gguf:Q4_0');
});

test('formatBytes returns human-readable units', () => {
  assert.strictEqual(formatBytes(0), '—');
  assert.strictEqual(formatBytes(7.15 * 1073741824), '7.15 GB');
  assert.strictEqual(formatBytes(500 * 1048576), '500 MB');
});

test('parseParamCount infers parameter count from the name', () => {
  assert.strictEqual(parseParamCount('google/gemma-4-12B-it-GGUF'), '12B');
  assert.strictEqual(parseParamCount('Qwen/Qwen3-4B-Thinking'), '4B');
  assert.strictEqual(parseParamCount('org/Mixtral-8x7B-Instruct'), '8x7B');
  assert.strictEqual(parseParamCount('org/model-700M-gguf'), '700M');
  assert.strictEqual(parseParamCount('google/gemma-4'), ''); // "4" is a version, not params
});

test('formatParams converts safetensors.total', () => {
  assert.strictEqual(formatParams(4022468096), '4B');
  assert.strictEqual(formatParams(70e9), '70B');
  assert.strictEqual(formatParams(700e6), '700M');
  assert.strictEqual(formatParams(0), '');
});

test('domainFromPipeline classifies the domain', () => {
  assert.strictEqual(domainFromPipeline('text-generation'), 'LLM');
  assert.strictEqual(domainFromPipeline('image-text-to-text'), 'VLM');
  assert.strictEqual(domainFromPipeline('text-generation', { vision: true }), 'VLM');
  assert.strictEqual(domainFromPipeline('feature-extraction'), 'Embeddings');
});

test('isOfficialOrg recognises official orgs (case-insensitive)', () => {
  assert.strictEqual(isOfficialOrg('google'), true);
  assert.strictEqual(isOfficialOrg('Qwen'), true);
  assert.strictEqual(isOfficialOrg('meta-llama'), true);
  assert.strictEqual(isOfficialOrg('ibm-granite'), true);
  assert.strictEqual(isOfficialOrg('bartowski'), false);
  assert.strictEqual(isOfficialOrg('unsloth'), false);
});
