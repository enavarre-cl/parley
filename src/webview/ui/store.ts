// Single owner of the current ChatDoc. No other module declares `doc`; they read it via getDoc()
// and replace it via setDoc().
let doc = null;

export function getDoc() { return doc; }

export function setDoc(next) {
  doc = next;
}
