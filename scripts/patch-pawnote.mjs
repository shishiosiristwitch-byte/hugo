// Correctif de compatibilité Pawnote 1.6.2 ↔ PRONOTE 2026.2 (lancé automatiquement après npm install).
// 1) La page de démarrage s'écrit désormais « Start ({…});} catch » : Pawnote cherchait « )}catch ».
// 2) Authentification : à partir de PRONOTE 2026.2, le client ne déchiffre plus le défi (challenge),
//    il le chiffre tel quel avec la clé login + SHA256(alea + mot de passe). Les versions antérieures
//    gardent l'ancien calcul. Forçable avec PRONOTE_CHALLENGE=v2 ou PRONOTE_CHALLENGE=legacy.
// 3) Espace parent : chaque requête doit désigner l'enfant concerné (Signature.membre = { N: id de l'enfant, G: 4 }),
//    sinon PRONOTE répond « accès refusé » puis ferme la session. Pawnote ne l'envoie pas.
// 4) Connexion via un ENT (CAS) : ajoute loginENT(session, { url, kind, cookies, username: e, password: f, deviceUUID }),
//    copie de loginCredentials avec les cookies de la session ENT, pourENT activé et la clé sans identifiant.
// Idempotent : un fichier déjà corrigé est laissé tel quel. À retirer quand Pawnote publiera son correctif.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const MARK = "/*vs-pronote-2026b*/";
const OLD_MARK = "/*vs-pronote-2026*/";
let dir;
try { dir = path.resolve(path.dirname(createRequire(import.meta.url).resolve("pawnote")), ".."); }
catch { console.log("patch-pawnote : pawnote absent, rien à faire"); process.exit(0); }

const CHALLENGE = /(\w+)=\((\w),(\w),(\w)\)=>\{const (\w)=([\w.]+)\.util\.createBuffer\(\2\.information\.aesIV\);try\{/;
const START = '.replace(/ /gu,"").replace(/\\n/gu,"")';
const REQUEST = /(\w+)=class\{constructor\((\w),(\w),(\w)\)\{this\.session=\2,this\.name=\3,this\.data=\4\}/;
const MEMBRE = ';try{const __r=this.session.userResource,__g=this.data&&(this.data.Signature||this.data._Signature_);' +
  'if(__g&&typeof __g==="object"&&this.session.information.accountKind===7&&__r&&__r.id&&!__g.membre)__g.membre={N:__r.id,G:4}}catch{}';
let ok = 0;
for (const f of ["dist/index.mjs", "dist/index.js"]) {
  const file = path.join(dir, f);
  if (!existsSync(file)) continue;
  let s = readFileSync(file, "utf8");
  if (s.includes(MARK)) { ok++; continue; }
  if (s.includes(OLD_MARK)) { // version précédente du correctif : on ajoute seulement le point 3
    const r = REQUEST.exec(s);
    if (!r) { console.error(`patch-pawnote : requêtes introuvables dans ${f}`); process.exitCode = 1; continue; }
    s = s.slice(0, r.index + r[0].length - 1) + MEMBRE + "}" + s.slice(r.index + r[0].length);
    writeFileSync(file, s.replace(OLD_MARK, MARK)); ok++; continue;
  }
  const m = CHALLENGE.exec(s);
  if (!m || !s.includes(START) || !/\.challenge,/.test(s.slice(m.index, m.index + 400))) {
    console.error(`patch-pawnote : motif introuvable dans ${f} (version de Pawnote différente ?)`); process.exitCode = 1; continue;
  }
  const [, , e, ch, key, iv, forge] = m;
  const enc = /(\w+)\.decrypt\(\w\.challenge/.exec(s.slice(m.index, m.index + 400))[1];
  const v2 = `${MARK}const __m=typeof process!=="undefined"&&process.env&&process.env.PRONOTE_CHALLENGE,__v=(${e}.instance&&${e}.instance.version)||[0,0];` +
    `if(__m==="v2"||(__m!=="legacy"&&(__v[0]>2026||(__v[0]===2026&&__v[1]>=2))))return ${enc}.encrypt(${forge}.util.encodeUtf8(${ch}.challenge),${key},${iv});`;
  s = s.slice(0, m.index + m[0].length - 4) + v2 + s.slice(m.index + m[0].length - 4);
  s = s.replace(START, START + '.replace(/\\);\\}catch/u,")}catch")');
  const r = REQUEST.exec(s);
  if (!r) { console.error(`patch-pawnote : requêtes introuvables dans ${f}`); process.exitCode = 1; continue; }
  s = s.slice(0, r.index + r[0].length - 1) + MEMBRE + "}" + s.slice(r.index + r[0].length);
  writeFileSync(file, s);
  ok++;
}
// (ok compte les fichiers corrigés pour les points 1 à 3)
// ── 4) loginENT (indépendant des points 1 à 3) ──
const ENT_MARK = "/*vs-loginENT2*/", ENT_MARK1 = "/*vs-loginENT*/";
function fnBody(src, start) { // position juste après l'accolade fermante du corps commençant à start ("{")
  let depth = 0, q = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === "\\") i++; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return -1;
}
function entVariant(body) {
  // params remplaçables : sans « bydlg », PRONOTE passe par le CAS de l'ENT (et fournit e/f)
  const out = body.replace("cookies:[]", "cookies:s.cookies??[]").replace("params:{", "params:s.params??{").replace("useCAS:!1", "useCAS:!0")
    .replace(/(\w+)\((\w),s\.username,s\.password\)/, '$1($2,"",s.password)');
  if (out === body || !out.includes("useCAS:!0") || !out.includes('"",s.password')) throw new Error("loginCredentials inattendu");
  return out;
}
let entOk = 0;
for (const f of ["dist/index.mjs", "dist/index.js"]) {
  const file = path.join(dir, f);
  if (!existsSync(file)) continue;
  let s = readFileSync(file, "utf8");
  if (s.includes(ENT_MARK)) { entOk++; continue; }
  if (s.includes(ENT_MARK1)) { // première version : rendre les paramètres de page remplaçables
    const i = s.indexOf(ENT_MARK1), j = s.indexOf("params:{", i);
    if (j < 0) { console.error(`patch-pawnote : loginENT v1 inattendu dans ${f}`); process.exitCode = 1; continue; }
    s = s.slice(0, j) + "params:s.params??{" + s.slice(j + "params:{".length);
    writeFileSync(file, s.replace(ENT_MARK1, ENT_MARK)); entOk++; continue;
  }
  try {
    if (f.endsWith(".mjs")) {
      const name = /,?(\w+) as loginCredentials\b/.exec(s)?.[1];
      const at = s.indexOf(`${name}=async(e,s)=>{`);
      if (!name || at < 0) throw new Error("loginCredentials introuvable");
      const b0 = at + `${name}=async(e,s)=>`.length, b1 = fnBody(s, b0);
      const fn = `__vsLoginENT=async(e,s)=>${ENT_MARK}${entVariant(s.slice(b0, b1))},`;
      s = s.slice(0, at) + fn + s.slice(at);
      s = s.replace(`${name} as loginCredentials`, `${name} as loginCredentials,__vsLoginENT as loginENT`);
    } else {
      const at = s.indexOf("exports.loginCredentials=async(e,s)=>{");
      if (at < 0) throw new Error("loginCredentials introuvable");
      const b0 = at + "exports.loginCredentials=async(e,s)=>".length, b1 = fnBody(s, b0);
      s = s.slice(0, at) + `exports.loginENT=async(e,s)=>${ENT_MARK}${entVariant(s.slice(b0, b1))},` + s.slice(at);
    }
    writeFileSync(file, s); entOk++;
  } catch (e) { console.error(`patch-pawnote : loginENT non ajouté à ${f} (${e.message})`); process.exitCode = 1; }
}
console.log(`patch-pawnote : ${ok} fichier(s) prêts, loginENT : ${entOk}`);
