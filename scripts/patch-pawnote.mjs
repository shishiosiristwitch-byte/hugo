// Correctif de compatibilité Pawnote 1.6.2 ↔ PRONOTE 2026.2 (lancé automatiquement après npm install).
// 1) La page de démarrage s'écrit désormais « Start ({…});} catch » : Pawnote cherchait « )}catch ».
// 2) Authentification : à partir de PRONOTE 2026.2, le client ne déchiffre plus le défi (challenge),
//    il le chiffre tel quel avec la clé login + SHA256(alea + mot de passe). Les versions antérieures
//    gardent l'ancien calcul. Forçable avec PRONOTE_CHALLENGE=v2 ou PRONOTE_CHALLENGE=legacy.
// Idempotent : un fichier déjà corrigé est laissé tel quel. À retirer quand Pawnote publiera son correctif.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const MARK = "/*vs-pronote-2026*/";
let dir;
try { dir = path.resolve(path.dirname(createRequire(import.meta.url).resolve("pawnote")), ".."); }
catch { console.log("patch-pawnote : pawnote absent, rien à faire"); process.exit(0); }

const CHALLENGE = /(\w+)=\((\w),(\w),(\w)\)=>\{const (\w)=([\w.]+)\.util\.createBuffer\(\2\.information\.aesIV\);try\{/;
const START = '.replace(/ /gu,"").replace(/\\n/gu,"")';
let ok = 0;
for (const f of ["dist/index.mjs", "dist/index.js"]) {
  const file = path.join(dir, f);
  if (!existsSync(file)) continue;
  let s = readFileSync(file, "utf8");
  if (s.includes(MARK)) { ok++; continue; }
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
  writeFileSync(file, s);
  ok++;
}
console.log(`patch-pawnote : ${ok} fichier(s) prêts`);
