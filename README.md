# Who Int Us — Serveur

## Déploiement sur Railway (gratuit)

### Étape 1 — Créer un compte Railway
Aller sur [railway.app](https://railway.app) et se connecter avec GitHub.

### Étape 2 — Mettre le serveur sur GitHub
```bash
cd whointus-server
git init
git add .
git commit -m "Who Int Us server"
# Créer un repo GitHub "whointus-server" puis :
git remote add origin https://github.com/TON_PSEUDO/whointus-server.git
git push -u origin main
```

### Étape 3 — Déployer sur Railway
1. Sur Railway → **New Project** → **Deploy from GitHub repo**
2. Sélectionner `whointus-server`
3. Railway détecte automatiquement Node.js et lance `npm start`
4. Aller dans **Settings** → **Networking** → **Generate Domain**
5. Tu obtiens une URL du type : `whointus-server-production.up.railway.app`

### Étape 4 — Mettre à jour l'app Electron
Dans `src/app.js`, ligne 1, remplacer :
```js
const SERVER_URL = 'wss://TON-PROJET.up.railway.app';
```
par :
```js
const SERVER_URL = 'wss://whointus-server-production.up.railway.app';
```

### Étape 5 — Distribuer l'app
```bash
cd whointus
npm install electron-builder --save-dev
npm run dist
```
Partager le `.exe` dans `dist/` à tes amis !
