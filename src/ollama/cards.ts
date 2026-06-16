/** Caché local de "fichas" de modelo (sidecar): guarda la info de HF para no re-consultarla. */
import * as fs from 'fs';
import * as path from 'path';

export class ModelCardCache {
  constructor(private readonly dir: string) { }

  private file(id: string): string {
    return path.join(this.dir, id.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json');
  }
  save(id: string, data: unknown): void {
    try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.file(id), JSON.stringify(data)); }
    catch { /* nada */ }
  }
  load(id: string): any | undefined {
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch { return undefined; }
  }
  remove(id: string): void { try { fs.unlinkSync(this.file(id)); } catch { /* nada */ } }
}
