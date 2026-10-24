# Carnet de bord — version mobile

Dashboard de notes et devoirs Ecole Directe, installable sur téléphone (PWA).
Le navigateur ne pouvant pas appeler l'API Ecole Directe directement, `api/ed.js` sert de relais :
sans stockage, appels limités à une liste blanche, protégé par la variable d'environnement `VS_KEY`.

- `public/` : app générée (depuis le dashboard PC via `npm run mobile` dans le projet principal)
- `src/` : sources du shim mobile, du service worker et du manifeste
- `api/ed.js` : fonction Vercel (relais)

Aucune donnée personnelle dans ce dépôt : notes, session et identifiants restent dans le navigateur du téléphone.

Déploiement Vercel : framework « Other », aucune commande de build, dossier de sortie `public`, variable `VS_KEY`.
