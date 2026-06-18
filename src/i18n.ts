/** i18n del backend (extension host). Inglés como clave; solo mantenemos el diccionario español. */
import * as vscode from 'vscode';

/** Idioma efectivo: respeta langChat.language ('auto'|'en'|'es') o el locale de VS Code. */
export function resolvedLang(): 'en' | 'es' {
  const pref = vscode.workspace.getConfiguration('langChat').get<string>('language', 'auto');
  if (pref === 'en' || pref === 'es') return pref;
  return vscode.env.language.toLowerCase().startsWith('es') ? 'es' : 'en';
}

const BACKEND_ES: Record<string, string> = {
  // Corrector — diccionario personal
  'Dictionary': 'Diccionario',
  'Personal dictionary': 'Diccionario personal',
  'Words you add here stop being marked as misspelled. The base dictionary is not affected.':
    'Las palabras que agregues aquí dejan de marcarse como error. El diccionario base no se altera.',
  'Add a word…': 'Agregar una palabra…',
  'Add': 'Agregar',
  'No words yet.': 'Aún no hay palabras.',
  'Remove': 'Quitar',
  // Voces Piper (TTS)
  'Voices': 'Voces',
  'No voices downloaded': 'Sin voces descargadas',
  'Delete this voice?': '¿Borrar esta voz?',
  'Add voice': 'Agregar voz',
  'Delete voice': 'Borrar voz',
  'Download': 'Descargar',
  'Downloaded': 'Descargada',
  'Downloading…': 'Descargando…',
  'Download neural voices to read messages aloud. They are verified against a pinned checksum.':
    'Descarga voces neuronales para leer los mensajes en voz alta. Se verifican contra un checksum pineado.',
  // Comparación de versiones
  'Compare': 'Comparar',
  'Compare: ': 'Comparar: ',
  'Past version': 'Versión anterior',
  'Current version': 'Versión actual',
  'Pick a .chat version to compare': 'Elige una versión .chat para comparar',
  'Open the .chat first to compare it.': 'Abre primero el .chat para compararlo.',
  'Could not read one of the .chat versions.': 'No se pudo leer una de las versiones del .chat.',
  // Confirmación de borrado
  'Delete this message?': '¿Borrar este mensaje?',
  'Delete this message and all below?': '¿Borrar este mensaje y todos los siguientes?',
  'Delete this variant?': '¿Borrar esta variante?',
  // Chat / TTS
  'Create chat': 'Crear chat',
  'The .chat file has invalid JSON: ': 'El archivo .chat tiene JSON inválido: ',
  'Could not write the .chat file.': 'No se pudo escribir en el archivo .chat.',
  'missing API key': 'falta API key',
  'no connection': 'sin conexión',
  'Missing the API key for': 'Falta la API key de',
  'Set it in the settings (🔧).': 'Configúrala en los ajustes (🔧).',
  'model': 'modelo',
  'models': 'modelos',
  '🗜️ Summarizing previous context…': '🗜️ Resumiendo contexto previo…',
  '⚠️ Could not summarize context: ': '⚠️ No se pudo resumir el contexto: ',
  '⚠️ Some MCP servers failed to start: ': '⚠️ Algunos servidores MCP no arrancaron: ',
  'The model returned no content. Try another model; on OpenRouter, check the key\'s credits/limits.':
    'El modelo no devolvió contenido. Prueba con otro modelo; en OpenRouter, revisa créditos/límites de la key.',
  'No model selected. Make sure the backend is active and press ⟳.':
    'No hay modelo seleccionado. Comprueba que el backend esté activo y pulsa ⟳.',
  'Create .md': 'Crear .md',
  'Use as system prompt': 'Usar como system prompt',
  'fork': 'bifurcación',
  'No voice available. Download one from the Lang Chat panel (Voices ➕), or set a custom .onnx path in Settings (langChat.tts.piperModel).':
    'No hay ninguna voz disponible. Descarga una desde el panel Lang Chat (Voces ➕), o configura una ruta .onnx personalizada en Ajustes (langChat.tts.piperModel).',
  'Piper failed: ': 'Piper falló: ',
  'Downloading voice: ': 'Descargando voz: ',
  'Could not download voice: ': 'No se pudo descargar la voz: ',
  'Generating audio…': 'Generando audio…',
  'Downloading the Piper engine (first time only)…': 'Descargando el motor Piper (solo la primera vez)…',
  'Setting up the Piper engine (one-time, ~1–2 min)…': 'Preparando el motor Piper (una sola vez, ~1–2 min)…',
  'Downloading a self-contained Python (one-time)…': 'Descargando un Python autocontenido (una sola vez)…',
  'Could not set up Piper: ': 'No se pudo preparar Piper: ',
  'Piper updated.': 'Piper actualizado.',

  // Engines (motores)
  'Engines': 'Motores',
  'running': 'en ejecución',
  'stopped': 'detenido',
  'starting…': 'arrancando…',
  'not installed': 'no instalado',
  'installed': 'instalado',
  'Installing engine…': 'Instalando motor…',
  'Updating engine…': 'Actualizando motor…',
  'Delete this engine?': '¿Borrar este motor?',
  // Modelos locales — árbol
  'Local models': 'Modelos locales',
  'Start the server to see the models': 'Arranca el servidor para ver los modelos',
  'Error: ': 'Error: ',
  'No models. Press "Add" to download.': 'Sin modelos. Pulsa "Agregar" para descargar.',
  'Downloads': 'Descargas',
  'No downloads': 'Sin descargas',
  'queued': 'en cola',
  'downloading…': 'descargando…',
  'cancelled': 'cancelada',
  'interrupted': 'interrumpida',
  'retry to resume': 'reintenta para reanudar',
  'error: ': 'error: ',

  // Modelos locales — explorador (panel host) y descargas
  'Explore models': 'Explorar modelos',
  'Search GGUF models on Hugging Face…': 'Buscar modelos GGUF en Hugging Face…',
  'downloading model': 'descargando modelo',
  'downloading projector (vision)': 'descargando proyector (visión)',
  'registering in Ollama': 'registrando en Ollama',
  'could not start the Ollama server': 'no se pudo arrancar el servidor Ollama',
  'interrupted (VS Code was closed)': 'interrumpida (se cerró VS Code)',

  // Modelos locales — comandos / avisos
  'Delete the model': 'Eliminar el modelo',
  'Delete': 'Eliminar',
  'Could not delete: ': 'No se pudo eliminar: ',
  'This model is not from Hugging Face.': 'Este modelo no viene de Hugging Face.',
  'Not enough space for': 'Puede que no haya espacio para',
  'Free:': 'Libre:',
  'Download anyway?': '¿Descargar igual?',
  'Download anyway': 'Descargar igual',
  'Using': 'Usando en el chat',
  'Open a chat and select the Ollama provider to use': 'Abre un chat y selecciona el provider Ollama para usar',
  // Comando setApiKey
  'Backend for the API key': 'Backend para la API key',
  'API key for': 'API key de',
  '(empty = delete)': '(vacío = borrar)',
  'saved': 'guardada',
  'deleted': 'borrada',
  '(encrypted in SecretStorage).': '(cifrada en SecretStorage).',
};

/** Traduce una cadena del backend al idioma efectivo (inglés es la clave). */
export function tr(s: string): string {
  return resolvedLang() === 'es' ? (BACKEND_ES[s] ?? s) : s;
}
